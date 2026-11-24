import { Router } from "express";
import { z } from "zod";
import {
  ANCHOR_DISPLAY_GROUPS,
  ANCHOR_TARGET_RATIO,
  classifyAnchor,
  displayGroupOf,
  isOverOptimised,
  uuidSchema,
} from "@crm/shared";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, noContent, ok, parsedQuery, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest } from "../../lib/audit.js";
import { admin } from "../../integrations/supabase.js";
import { orgOf } from "../../lib/crud.js";
import { evaluateAnchorAlerts, type AlertRule, type DistributionRow } from "./evaluate.js";

/**
 * ANCHOR ANALYTICS AND ALERTS.
 *
 * Two related jobs:
 *
 *   1. REPORT the distribution, by campaign and by client.
 *   2. ALERT when a category drifts outside a configured band.
 *
 * The report reads the service_role-only views, because they join placements to
 * campaigns and a client must never see the whole picture. The permission check
 * (`reports:read` plus `costs`-free data) is what makes that safe — no money is in
 * these views at all, which is why they can be shared more broadly than the margin
 * views.
 */
export const anchorsRouter: Router = Router();

// ===========================================================================
// CLASSIFY — preview and backfill
// ===========================================================================

/**
 * Classify anchor text without saving it.
 *
 * The UI calls this while the user types so they can see how an anchor will be
 * categorised before committing to it. Same function the server uses on write, so
 * the preview cannot disagree with the result.
 */
anchorsRouter.post(
  "/classify",
  authorize("placements:read"),
  validate({
    body: z.object({
      anchorText: z.string().max(500),
      targetUrl: z.string().trim().max(2000).optional(),
      brandName: z.string().trim().max(200).optional(),
      brandDomain: z.string().trim().max(300).optional(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as {
      anchorText: string;
      targetUrl?: string;
      brandName?: string;
      brandDomain?: string;
    };

    const category = classifyAnchor(b.anchorText, b.targetUrl, {
      brandName: b.brandName,
      brandDomain: b.brandDomain,
    });

    ok(res, {
      anchorText: b.anchorText,
      category,
      displayGroup: displayGroupOf(category),
      // null means "nothing to classify", which the UI shows differently from
      // "classified as generic".
      classified: category !== null,
    });
  }),
);

/**
 * Fill in missing anchor categories for existing placements.
 *
 * Safe to run repeatedly: it only touches rows where `anchor_type` is NULL. A
 * human-set category is never overwritten — the classifier is a convenience, not
 * an authority, and silently relabelling a person's judgement would make the
 * report untrustworthy.
 */
anchorsRouter.post(
  "/backfill",
  authorize("placements:write"),
  validate({ body: z.object({ campaignId: uuidSchema.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }) }),
  asyncRoute(async (req, res) => {
    const b = req.body as { campaignId?: string; limit: number };
    const orgId = orgOf(req);

    let query = admin()
      .from("placements")
      .select("id, anchor_text, target_url, campaign_id")
      .eq("organization_id", orgId)
      .is("anchor_type", null)
      .is("deleted_at", null)
      .not("anchor_text", "is", null)
      .limit(b.limit);

    if (b.campaignId) query = query.eq("campaign_id", b.campaignId);

    const { data: placements, error } = await query;
    if (error) throw Errors.internal(error.message);

    const rows = (placements ?? []) as Array<{
      id: string;
      anchor_text: string | null;
      target_url: string;
      campaign_id: string;
    }>;

    if (rows.length === 0) {
      ok(res, { scanned: 0, classified: 0, skipped: 0 });
      return;
    }

    // Brand context comes from the campaign's client, so "Acme" is recognised as
    // branded without asking the caller.
    const campaignIds = [...new Set(rows.map((r) => r.campaign_id))];
    const { data: campaigns } = await admin()
      .from("campaigns")
      .select("id, client_id")
      .in("id", campaignIds);

    const clientIds = [
      ...new Set(((campaigns ?? []) as Array<{ client_id: string }>).map((c) => c.client_id)),
    ];
    const { data: clients } = await admin()
      .from("clients")
      .select("id, name, domain")
      .in("id", clientIds);

    const clientById = new Map(
      ((clients ?? []) as Array<{ id: string; name: string; domain: string | null }>).map((c) => [c.id, c]),
    );
    const clientOfCampaign = new Map(
      ((campaigns ?? []) as Array<{ id: string; client_id: string }>).map((c) => [c.id, c.client_id]),
    );

    let classified = 0;
    let skipped = 0;

    for (const placement of rows) {
      const client = clientById.get(clientOfCampaign.get(placement.campaign_id) ?? "");
      const category = classifyAnchor(placement.anchor_text, placement.target_url, {
        brandName: client?.name,
        brandDomain: client?.domain,
      });

      if (!category) {
        skipped += 1;
        continue;
      }

      const { error: updateErr } = await admin()
        .from("placements")
        .update({ anchor_type: category })
        .eq("id", placement.id)
        .eq("organization_id", orgId)
        .is("anchor_type", null);
      if (!updateErr) classified += 1;
    }

    await auditFromRequest(req, {
      entityType: "placement",
      action: "update",
      diff: { anchorBackfill: { scanned: rows.length, classified, skipped } },
    });

    ok(res, { scanned: rows.length, classified, skipped });
  }),
);

// ===========================================================================
// DISTRIBUTION — by campaign and by client
// ===========================================================================

const scopeQuery = z.object({
  campaignId: uuidSchema.optional(),
  clientId: uuidSchema.optional(),
  scope: z.enum(["campaign", "client"]).default("campaign"),
});

anchorsRouter.get(
  "/distribution",
  authorize("reports:read"),
  validate({ query: scopeQuery }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<z.infer<typeof scopeQuery>>(req);

    if (query.scope === "campaign" && !query.campaignId) {
      throw Errors.badRequest("campaignId is required when scope is campaign");
    }
    if (query.scope === "client" && !query.clientId) {
      throw Errors.badRequest("clientId is required when scope is client");
    }

    const view = query.scope === "client" ? "v_anchor_distribution_client" : "v_anchor_distribution";
    const key = query.scope === "client" ? "client_id" : "campaign_id";
    const value = (query.scope === "client" ? query.clientId : query.campaignId)!;

    const { data, error } = await admin()
      .from(view)
      .select("anchor_type, link_count, share")
      .eq("organization_id", orgOf(req))
      .eq(key, value);

    if (error) throw Errors.internal(error.message);

    const rows = (data ?? []) as Array<{ anchor_type: string; link_count: number; share: number }>;

    // Roll the six stored categories into the four the brief names, while keeping
    // the raw rows available — a reader who wants "naked URL" separately should not
    // have to re-derive it.
    //
    // Shares are computed over CLASSIFIED links only. An unclassified row (a live
    // placement whose anchor nobody has categorised, or one with no anchor at all)
    // is not a category, so counting it in the denominator would make every share
    // slightly too small and the four groups would not sum to 1.
    const grouped = new Map<string, number>();
    let classifiedTotal = 0;
    let unclassified = 0;

    for (const row of rows) {
      const group = displayGroupOf(row.anchor_type);
      const count = Number(row.link_count);
      if (group === "unclassified") {
        unclassified += count;
        continue;
      }
      grouped.set(group, (grouped.get(group) ?? 0) + count);
      classifiedTotal += count;
    }

    const groups = ANCHOR_DISPLAY_GROUPS.map((g) => ({
      group: g,
      linkCount: grouped.get(g) ?? 0,
      share: classifiedTotal > 0 ? Number(((grouped.get(g) ?? 0) / classifiedTotal).toFixed(4)) : 0,
      target: targetForGroup(g),
    }));

    ok(res, {
      scope: query.scope,
      scopeId: value,
      /** Classified links: the denominator every share uses, and the donut's total. */
      totalLinks: classifiedTotal,
      raw: rows,
      groups,
      // Reported separately so a reader can see how much of the profile is unknown.
      unclassified,
      /** Every live link, classified or not. */
      trackedLinks: classifiedTotal + unclassified,
    });
  }),
);

function targetForGroup(group: string): { min: number; max: number } | null {
  switch (group) {
    case "branded":
      return ANCHOR_TARGET_RATIO.branded;
    case "exact_match":
      return ANCHOR_TARGET_RATIO.exact_match;
    case "partial_match":
      return ANCHOR_TARGET_RATIO.partial_match;
    case "generic_or_naked":
      return {
        min: ANCHOR_TARGET_RATIO.generic.min + ANCHOR_TARGET_RATIO.naked_url.min,
        max: ANCHOR_TARGET_RATIO.generic.max + ANCHOR_TARGET_RATIO.naked_url.max,
      };
    default:
      return null;
  }
}

// ===========================================================================
// ALERTS
// ===========================================================================

const alertSchema = z
  .object({
    campaignId: uuidSchema.nullish(),
    clientId: uuidSchema.nullish(),
    anchorCategory: z.enum(["branded", "exact_match", "partial_match", "generic", "naked_url", "image_alt"]),
    maxShare: z.coerce.number().gt(0).max(1),
    minShare: z.coerce.number().min(0).max(1).nullish(),
    minLinks: z.coerce.number().int().min(0).max(10_000).default(10),
    enabled: z.boolean().default(true),
  })
  .refine((v) => Boolean(v.campaignId) !== Boolean(v.clientId), {
    message: "Set exactly one of campaignId or clientId",
  })
  .refine((v) => v.minShare == null || v.minShare <= v.maxShare, {
    message: "minShare must not exceed maxShare",
  });

anchorsRouter.get(
  "/alerts",
  authorize("reports:read"),
  validate({ query: z.object({ campaignId: uuidSchema.optional(), clientId: uuidSchema.optional() }) }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<{ campaignId?: string; clientId?: string }>(req);

    let dbQuery = req.auth!.db
      .from("anchor_alerts")
      .select("id, campaign_id, client_id, anchor_category, max_share, min_share, min_links, enabled, created_at, updated_at")
      .order("created_at", { ascending: false });

    if (query.campaignId) dbQuery = dbQuery.eq("campaign_id", query.campaignId);
    if (query.clientId) dbQuery = dbQuery.eq("client_id", query.clientId);

    const { data, error } = await dbQuery;
    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

anchorsRouter.post(
  "/alerts",
  authorize("settings:manage"),
  validate({ body: alertSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof alertSchema>;

    const { data, error } = await req.auth!.db
      .from("anchor_alerts")
      .insert({
        organization_id: orgOf(req),
        campaign_id: b.campaignId ?? null,
        client_id: b.clientId ?? null,
        anchor_category: b.anchorCategory,
        max_share: b.maxShare,
        min_share: b.minShare ?? null,
        min_links: b.minLinks,
        enabled: b.enabled,
        created_by: req.auth!.userId,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23514") throw Errors.badRequest("Check the alert thresholds and scope");
      throw Errors.internal(error.message);
    }

    await auditFromRequest(req, {
      entityType: "anchor_alert",
      entityId: data.id,
      action: "create",
      diff: { category: b.anchorCategory, maxShare: b.maxShare, minShare: b.minShare },
    });

    created(res, data);
  }),
);

anchorsRouter.patch(
  "/alerts/:id([0-9a-fA-F-]{36})",
  authorize("settings:manage"),
  validate({
    params: z.object({ id: uuidSchema }),
    body: z.object({
      maxShare: z.coerce.number().gt(0).max(1).optional(),
      minShare: z.coerce.number().min(0).max(1).nullish(),
      minLinks: z.coerce.number().int().min(0).max(10_000).optional(),
      enabled: z.boolean().optional(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as { maxShare?: number; minShare?: number | null; minLinks?: number; enabled?: boolean };
    const patch: Record<string, unknown> = {};
    if (b.maxShare !== undefined) patch.max_share = b.maxShare;
    if (b.minShare !== undefined) patch.min_share = b.minShare;
    if (b.minLinks !== undefined) patch.min_links = b.minLinks;
    if (b.enabled !== undefined) patch.enabled = b.enabled;
    if (Object.keys(patch).length === 0) throw Errors.badRequest("No fields to update");

    const { data, error } = await req.auth!.db
      .from("anchor_alerts")
      .update(patch)
      .eq("id", req.params.id)
      .select()
      .maybeSingle();

    if (error) {
      if (error.code === "23514") throw Errors.badRequest("minShare must not exceed maxShare");
      throw Errors.internal(error.message);
    }
    if (!data) throw Errors.notFound("Alert");
    ok(res, data);
  }),
);

anchorsRouter.delete(
  "/alerts/:id([0-9a-fA-F-]{36})",
  authorize("settings:manage"),
  validate({ params: z.object({ id: uuidSchema }) }),
  asyncRoute(async (req, res) => {
    const { error } = await req.auth!.db.from("anchor_alerts").delete().eq("id", req.params.id);
    if (error) throw Errors.internal(error.message);
    noContent(res);
  }),
);

/**
 * Evaluate the alerts.
 *
 * Returns every breach, not just the first: a reader wants the whole picture, and
 * a client with three over-optimised categories needs to see all three.
 *
 * Defaults are used when a scope has no configured alert, so a campaign nobody
 * has tuned still gets the platform-wide thresholds rather than silence.
 */
anchorsRouter.get(
  "/alerts/evaluate",
  authorize("reports:read"),
  validate({
    query: z.object({
      campaignId: uuidSchema.optional(),
      clientId: uuidSchema.optional(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<{ campaignId?: string; clientId?: string }>(req);
    if (!query.campaignId && !query.clientId) {
      throw Errors.badRequest("Provide campaignId or clientId");
    }

    const scope = query.clientId ? "client" : "campaign";
    const view = scope === "client" ? "v_anchor_distribution_client" : "v_anchor_distribution";
    const key = scope === "client" ? "client_id" : "campaign_id";
    const value = (query.clientId ?? query.campaignId)!;

    const [{ data: dist, error: distErr }, { data: alerts, error: alertErr }] = await Promise.all([
      admin().from(view).select("anchor_type, link_count, share").eq("organization_id", orgOf(req)).eq(key, value),
      req.auth!.db
        .from("anchor_alerts")
        .select("id, anchor_category, max_share, min_share, min_links, enabled")
        .eq(key, value)
        .eq("enabled", true),
    ]);

    if (distErr) throw Errors.internal(distErr.message);
    if (alertErr) throw Errors.internal(alertErr.message);

    const rows = (dist ?? []) as DistributionRow[];
    const total = rows.reduce((n, r) => n + Number(r.link_count), 0);

    // One implementation, shared with the scheduled anchor-alerts job. Two copies
    // would drift, and a user seeing a different answer from the one that notified
    // them is worse than no alert.
    const breaches = evaluateAnchorAlerts(rows, (alerts ?? []) as AlertRule[]);

    ok(res, {
      scope,
      scopeId: value,
      totalLinks: total,
      evaluatedAt: new Date().toISOString(),
      breaches,
      healthy: breaches.length === 0,
    });
  }),
);
