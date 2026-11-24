import { Router, type NextFunction, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { asyncRoute, ok } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { admin } from "../../integrations/supabase.js";
import { logger } from "../../lib/logger.js";
import { UnsafeUrlError } from "../../integrations/url-safety.js";
import { breachDedupeKey, breachSummary, evaluateAnchorAlerts } from "../anchors/evaluate.js";

/**
 * SCHEDULED WORK.
 *
 * Hostinger's Node hosting runs the app on demand and stops it when idle, so there
 * are no always-running background workers. Scheduled work therefore arrives as an
 * HTTP call from pg_cron / pg_net, authenticated by an HMAC over the body plus a
 * timestamp — never a JWT, because there is no user involved.
 *
 * The signature and the 5-minute window together stop both forgery and replay.
 *
 * ONE INVOCATION IS ONE BOUNDED BATCH
 *
 * Hostinger caps a request at 120 s. A sweep of 50 placements at a 15 s fetch
 * timeout could exceed that, and a request killed mid-run loses whatever it had not
 * written yet. So each invocation takes a bounded batch, writes its progress as it
 * goes, records the run and returns. The scheduler re-fires; the next call picks up
 * where this one stopped, because `last_checked_at` is stamped per placement.
 */
export const jobsRouter: Router = Router();

const MAX_SKEW_MS = 5 * 60 * 1000;

function verifyHmac(req: Request): void {
  if (!env.JOB_HMAC_SECRET) throw Errors.unauthorized("Scheduled jobs are not configured");

  const signature = req.header("x-job-signature");
  const timestamp = req.header("x-job-timestamp");
  if (!signature || !timestamp) throw Errors.unauthorized("Missing job signature");

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
    throw Errors.unauthorized("Job signature has expired");
  }

  const body = JSON.stringify(req.body ?? {});
  const expected = createHmac("sha256", env.JOB_HMAC_SECRET).update(`${ts}.${body}`).digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  // Constant-time compare; length mismatch would throw, so check first.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Errors.unauthorized("Invalid job signature");
  }
}

function jobAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    verifyHmac(req);
    next();
  } catch (err) {
    next(err);
  }
}

jobsRouter.use(jobAuth);

/**
 * TRUST BOUNDARY.
 *
 * A signed job may name ANY organization, because the signer is the scheduler
 * (pg_cron / pg_net) and there is no user identity to scope to. So possession of
 * JOB_HMAC_SECRET is equivalent to service-role access for these routes.
 * That is why the secret must be long, held only by the scheduler, and rotated
 * if it ever appears in a log or a client bundle.
 *
 * The only defence here beyond the signature is shape validation: a malformed id
 * must not reach a service-role query.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireOrgId(req: Request): string {
  const orgId = (req.body as { organizationId?: unknown }).organizationId;
  if (typeof orgId !== "string" || !UUID_RE.test(orgId)) {
    throw Errors.badRequest("organizationId must be a valid UUID");
  }
  return orgId;
}

/** Read a numeric setting, falling back when the row is missing or malformed. */
async function settingNumber(key: string, fallback: number): Promise<number> {
  const { data } = await admin().from("app_settings").select("value").eq("key", key).maybeSingle();
  const parsed = Number((data as { value?: string } | null)?.value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Record a job run at ENTRY, with `status: 'running'`.
 *
 * Before this, a row was written only on success — so a run that crashed (OOM, a
 * killed request, an unhandled throw) left no trace at all and looked identical to
 * a job that never fired. Writing at entry makes a hung or crashed run visible.
 */
async function startRun(orgId: string, jobName: string): Promise<string | null> {
  const { data, error } = await admin()
    .from("job_runs")
    .insert({ organization_id: orgId, job_name: jobName, status: "running", detail: {} })
    .select("id")
    .maybeSingle();

  if (error) {
    // The work matters more than the audit row, so a failure here must not stop the
    // job — but it is logged so the gap is visible.
    logger.warn({ err: error, jobName, orgId, severity: "job_run_gap" }, "could not record job run start");
    return null;
  }
  return (data as { id?: string } | null)?.id ?? null;
}

async function finishRun(
  runId: string | null,
  status: "ok" | "error",
  detail: Record<string, unknown>,
): Promise<void> {
  if (!runId) return;
  const { error } = await admin()
    .from("job_runs")
    .update({ status, detail, finished_at: new Date().toISOString() })
    .eq("id", runId);

  if (error) logger.warn({ err: error, runId }, "could not record job run finish");
}

/**
 * Run a job body inside the run-record wrapper, so every job records
 * `running` → `ok`/`error` and a throw is both recorded and re-thrown.
 */
async function withRun<T extends { detail: Record<string, unknown> }>(
  orgId: string,
  jobName: string,
  body: () => Promise<T>,
): Promise<T> {
  const runId = await startRun(orgId, jobName);
  try {
    const result = await body();
    await finishRun(runId, "ok", result.detail);
    return result;
  } catch (err) {
    await finishRun(runId, "error", { message: (err as Error).message });
    logger.error({ err, jobName, orgId, severity: "job_failed" }, "scheduled job failed");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// LINK VERIFICATION
// ---------------------------------------------------------------------------
jobsRouter.post(
  "/check-links",
  asyncRoute(async (req, res) => {
    const orgId = requireOrgId(req);

    const result = await withRun(orgId, "check-links", async () => {
      const batchSize = await settingNumber("jobs.check_links_batch", 10);
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Claim a bounded batch, oldest-checked first.
      //
      // `last_checked_at` is stamped as each placement completes, so a run that dies
      // halfway keeps its progress and the next invocation resumes from the rows
      // still due — not from the beginning. That is what makes a bounded batch
      // converge instead of looping on the same first ten.
      const { data: pending, error } = await admin()
        .from("placements")
        .select("id, live_url, target_url, anchor_text, anchor_type, link_type, rel_attribute")
        .eq("organization_id", orgId)
        .eq("status", "live")
        .not("live_url", "is", null)
        .is("deleted_at", null)
        .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`)
        .order("last_checked_at", { ascending: true, nullsFirst: true })
        .limit(batchSize);

      if (error) throw Errors.internal(error.message);

      const { verifyBacklink, expectedRelFromPlacement } = await import("../../integrations/verification.js");

      let checked = 0;
      let notFound = 0;
      let mismatched = 0;
      let unreachable = 0;
      let needsReview = 0;
      let retried = 0;

      for (const placement of pending ?? []) {
        const expectedRel = expectedRelFromPlacement(
          placement.link_type as string | null,
          placement.rel_attribute as string | null,
        );

        const attempt = () =>
          verifyBacklink({
            liveUrl: placement.live_url as string,
            expectedUrl: placement.target_url as string,
            expectedAnchor: placement.anchor_text as string | null,
            expectedRel,
            expectedAnchorType: placement.anchor_type as string | null,
          });

        // One retry on a TRANSIENT failure only.
        //
        // A network blip is worth retrying; a refused address is not. Retrying an
        // `UnsafeUrlError` would be pointless — the guard refuses identically — and
        // would look, from the publisher's side, like an attack.
        let outcome;
        try {
          outcome = await attempt();
        } catch (err) {
          if (err instanceof UnsafeUrlError) {
            logger.warn({ err, placementId: placement.id }, "verification blocked by URL guard; not retrying");
            checked += 1;
            unreachable += 1;
            continue;
          }
          logger.warn({ err, placementId: placement.id }, "verification threw; retrying once");
          retried += 1;
          await new Promise((r) => setTimeout(r, 1500));
          outcome = await attempt();
        }

        await admin()
          .from("link_checks")
          .insert({
            organization_id: orgId,
            placement_id: placement.id,
            http_status: outcome.httpStatus,
            found: outcome.found,
            rel_attribute: outcome.rel.actual.join(" ") || null,
            checked_by: "system",
            verdict: outcome.verdict,
            expected_url: placement.target_url,
            found_url: outcome.foundUrl,
            anchor_expected: placement.anchor_text,
            anchor_found: outcome.anchorFoundText,
            anchor_matches: outcome.anchor.matches,
            rel_expected: expectedRel.join(" ") || "",
            rel_matches: outcome.rel.matches,
            url_matches: outcome.urlMatches,
            failure_reason: outcome.failureReason,
            http_final_url: outcome.finalUrl,
            elapsed_ms: outcome.elapsedMs,
            raw: outcome.detail,
          });

        await admin()
          .from("placements")
          .update({ last_checked_at: new Date().toISOString() })
          .eq("id", placement.id);

        checked += 1;
        if (outcome.verdict === "unreachable") unreachable += 1;
        // A JS shell is neither a missing link nor a pass. Counted separately so
        // "4 links missing" never quietly includes "we could not tell".
        else if (outcome.verdict === "needs_manual_review") needsReview += 1;
        else if (!outcome.found) notFound += 1;
        else if (outcome.verdict !== "ok") mismatched += 1;
      }

      // How much work is still due, so the caller can tell a drained sweep from one
      // that needs another pass.
      const now = new Date().toISOString();
      const { count: remaining } = await admin()
        .from("placements")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("status", "live")
        .not("live_url", "is", null)
        .is("deleted_at", null)
        .or(`last_checked_at.is.null,last_checked_at.lt.${now}`);

      const remainingCount = remaining ?? 0;

      return {
        checked,
        notFound,
        mismatched,
        unreachable,
        needsReview,
        retried,
        remaining: remainingCount,
        batchSize,
        detail: {
          checked,
          notFound,
          mismatched,
          unreachable,
          needsReview,
          retried,
          remaining: remainingCount,
          batchSize,
        },
      };
    });

    ok(res, {
      checked: result.checked,
      notFound: result.notFound,
      mismatched: result.mismatched,
      unreachable: result.unreachable,
      needsReview: result.needsReview,
      retried: result.retried,
      remaining: result.remaining,
    });
  }),
);

// ---------------------------------------------------------------------------
// OVERDUE INVOICES
//
// This job used to write `status = 'overdue'`, and two things were wrong with it:
//
//   1. It filtered on `["sent", "partially_paid"]`. Migration 0028 renamed `sent`
//      to `issued`, so from that point the job matched NOTHING — it reported zero
//      overdue invoices forever while real ones sat unpaid.
//
//   2. `overdue` is now DERIVED, in `app_private.invoice_effective_status`. Writing
//      it here would re-introduce the write-fight between this job and the payment
//      trigger that migration 0028 removed.
//
// So it now REPORTS: it counts what the derived view considers overdue, and the
// count lands in `job_runs.detail` where an operator can see it. A cron that has
// been silently doing nothing is exactly what this job should make visible.
// ---------------------------------------------------------------------------
jobsRouter.post(
  "/flag-overdue",
  asyncRoute(async (req, res) => {
    const orgId = requireOrgId(req);

    const flagged = await withRun(orgId, "flag-overdue", async () => {
      const { data, error } = await admin()
        .from("v_invoices")
        .select("id")
        .eq("organization_id", orgId)
        .eq("effective_status", "overdue");

      if (error) throw Errors.internal(error.message);
      const count = data?.length ?? 0;
      return { flagged: count, detail: { overdue: count } };
    });

    ok(res, { flagged: flagged.flagged });
  }),
);

// ---------------------------------------------------------------------------
// FOLLOW-UP REMINDERS
// ---------------------------------------------------------------------------
jobsRouter.post(
  "/follow-ups-due",
  asyncRoute(async (req, res) => {
    const orgId = requireOrgId(req);

    const queued = await withRun(orgId, "follow-ups-due", async () => {
      const { data, error } = await admin()
        .from("prospects")
        .select("id, assigned_to, domain")
        .eq("organization_id", orgId)
        .is("deleted_at", null)
        .lte("next_follow_up_at", new Date().toISOString())
        .not("assigned_to", "is", null)
        .limit(500);

      if (error) throw Errors.internal(error.message);

      let inserted = 0;
      for (const p of data ?? []) {
        // Deduped: an overdue follow-up stays overdue across every run until
        // somebody acts, and re-notifying hourly would train people to ignore it.
        const { data: id, error: emitErr } = await admin().rpc("emit_notification_rpc", {
          p_org: orgId,
          p_user: p.assigned_to,
          p_type: "follow_up_due",
          p_payload: { prospectId: p.id, domain: p.domain },
          p_dedupe_key: `follow_up_due:${p.id}`,
        });
        // A NULL id means "a duplicate was suppressed". An ERROR means the write
        // failed. Conflating the two is how the notification table stayed empty
        // while this job reported success.
        if (emitErr) throw Errors.internal(emitErr.message);
        if (id) inserted += 1;
      }

      return { queued: inserted, detail: { queued: inserted } };
    });

    ok(res, { queued: queued.queued });
  }),
);

// ---------------------------------------------------------------------------
// ANCHOR ALERTS
//
// Evaluates every enabled alert for the organisation and notifies the people who
// can act on it. Uses the SAME `evaluateAnchorAlerts` implementation as the
// `/anchors/alerts/evaluate` endpoint, so what the UI shows and what is delivered
// cannot drift.
//
// Deduped on (scope, category, kind): an unresolved breach notifies once. Once the
// user reads it the slot frees, and a later re-fire notifies again — correct,
// because the condition came back after they acknowledged it.
// ---------------------------------------------------------------------------
jobsRouter.post(
  "/anchor-alerts",
  asyncRoute(async (req, res) => {
    const orgId = requireOrgId(req);

    const result = await withRun(orgId, "anchor-alerts", async () => {
      const { data: rules, error: rulesErr } = await admin()
        .from("anchor_alerts")
        .select("id, campaign_id, client_id, anchor_category, max_share, min_share, min_links, enabled")
        .eq("organization_id", orgId)
        .eq("enabled", true);

      if (rulesErr) throw Errors.internal(rulesErr.message);

      if (!rules || rules.length === 0) {
        return { evaluated: 0, notified: 0, suppressed: 0, detail: { evaluated: 0, notified: 0, suppressed: 0 } };
      }

      // Recipients by role: the people who can actually change a campaign's anchor
      // mix. Notifying a writer or prospector would be noise they cannot resolve.
      const { data: recipients, error: recErr } = await admin()
        .from("profiles")
        .select("id")
        .eq("organization_id", orgId)
        .eq("is_active", true)
        .in("role", ["owner", "account_manager"]);

      if (recErr) throw Errors.internal(recErr.message);

      // Group rules by scope so the distribution view is read once per scope rather
      // than once per rule.
      const scopes = new Map<
        string,
        { scope: "campaign" | "client"; id: string; rules: Array<Record<string, unknown>> }
      >();

      for (const rule of rules) {
        const scope: "campaign" | "client" = rule.campaign_id ? "campaign" : "client";
        const id = (rule.campaign_id ?? rule.client_id) as string;
        const key = `${scope}:${id}`;
        const existing = scopes.get(key);
        if (existing) existing.rules.push(rule);
        else scopes.set(key, { scope, id, rules: [rule] });
      }

      let evaluated = 0;
      let notified = 0;
      let suppressed = 0;

      for (const { scope, id, rules: scopeRules } of scopes.values()) {
        evaluated += 1;

        const view = scope === "client" ? "v_anchor_distribution_client" : "v_anchor_distribution";
        const key = scope === "client" ? "client_id" : "campaign_id";

        const { data: dist, error: distErr } = await admin()
          .from(view)
          .select("anchor_type, link_count, share")
          .eq("organization_id", orgId)
          .eq(key, id);

        if (distErr) {
          logger.warn({ err: distErr, scope, id }, "could not read anchor distribution for alerts");
          continue;
        }

        const breaches = evaluateAnchorAlerts(
          (dist ?? []) as Array<{ anchor_type: string; link_count: number; share: number }>,
          scopeRules as unknown as Parameters<typeof evaluateAnchorAlerts>[1],
        );

        if (breaches.length === 0) continue;

        // A campaign name makes the notification actionable ("Beta Niche Edits").
        let campaignName: string | null = null;
        if (scope === "campaign") {
          const { data: campaign } = await admin().from("campaigns").select("name").eq("id", id).maybeSingle();
          campaignName = (campaign as { name?: string } | null)?.name ?? null;
        }

        for (const breach of breaches) {
          const dedupeKey = breachDedupeKey(id, breach);

          for (const recipient of recipients ?? []) {
            const { data: notificationId, error: emitErr } = await admin().rpc("emit_notification_rpc", {
              p_org: orgId,
              p_user: recipient.id,
              p_type: "anchor_alert",
              // Deliberately narrow: campaign identity, category, the numbers, and
              // where to look. No cost, no margin, no internal note — a notification
              // payload is the least-protected surface in the app.
              p_payload: {
                campaignId: scope === "campaign" ? id : null,
                clientId: scope === "client" ? id : null,
                campaignName,
                category: breach.category,
                kind: breach.kind,
                share: breach.share,
                threshold: breach.threshold,
                severity: breach.severity,
                message: breachSummary(breach),
                link: "/anchors",
              },
              p_dedupe_key: dedupeKey,
            });

            if (emitErr) throw Errors.internal(emitErr.message);
            if (notificationId) notified += 1;
            else suppressed += 1;
          }
        }
      }

      return { evaluated, notified, suppressed, detail: { evaluated, notified, suppressed } };
    });

    ok(res, {
      evaluated: result.evaluated,
      notified: result.notified,
      suppressed: result.suppressed,
    });
  }),
);
