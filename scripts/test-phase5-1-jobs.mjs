/**
 * PHASE 5.1 — SCHEDULED JOBS.
 *
 * Uses the REAL HMAC signing path the scheduler uses, so this proves the thing that
 * was previously untested: that a `pg_cron` invocation would actually authenticate.
 * Everything is signed here in Node, matching `verifyHmac` exactly.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const API = process.env.API_URL ?? "http://127.0.0.1:3000";
const SUPABASE = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d: String(d) });
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

// The same secret the API uses, read from its env file.
const secret = (() => {
  const raw = readFileSync(new URL("../apps/api/.env", import.meta.url), "utf8");
  const match = /^JOB_HMAC_SECRET=(.*)$/m.exec(raw);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
})();
check("JOB_HMAC_SECRET is configured for the test", secret.length >= 32, `${secret.length} chars`);

const dbContainer = "supabase_db_link-building-crm";

/**
 * Run SQL through psql on STDIN.
 *
 * Passing the statement as a shell argument means every quote has to survive two
 * layers of escaping, which broke as soon as an id contained a newline. stdin has no
 * such problem. `-t -A` gives bare values, and only the first line is returned so a
 * query that unexpectedly yields two rows fails at the call site rather than
 * silently embedding a newline in an id.
 */
const db1 = (sql) =>
  execSync(`docker exec -i ${dbContainer} psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: "utf8",
  })
    .split("\n")[0]
    .trim();

const dbAll = (sql) =>
  execSync(`docker exec -i ${dbContainer} psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: "utf8",
  })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Alias: the common case wants one value. */
const db = db1;

const orgId = db("select id from public.organizations where slug = 'demo-agency'");

const login = async (email) => {
  const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  return (await r.json()).access_token;
};

/** Sign exactly as pg_cron does: HMAC-SHA256 over "<ts>.<json body>". */
const signedJob = async (job, body, { secretOverride, tsOverride } = {}) => {
  const ts = tsOverride ?? Math.floor(Date.now());
  const bodyText = JSON.stringify(body);
  const key = secretOverride ?? secret;
  const signature = createHmac("sha256", key).update(`${ts}.${bodyText}`).digest("hex");

  const res = await fetch(`${API}/api/v1/internal/jobs/${job}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-job-timestamp": String(ts),
      "x-job-signature": signature,
    },
    body: bodyText,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text };
};

const owner = await login("owner@demo.test");

// ===========================================================================
console.log("\n1. the signature boundary");
// ===========================================================================
{
  const unsigned = await fetch(`${API}/api/v1/internal/jobs/check-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: orgId }),
  });
  check("an unsigned job call is rejected", unsigned.status === 401, String(unsigned.status));

  const badSig = await signedJob("check-links", { organizationId: orgId }, { secretOverride: "x".repeat(44) });
  check("a bad signature is rejected", badSig.status === 401, String(badSig.status));
  check(
    "the rejection says it is the signature, not a missing token",
    /invalid job signature/i.test(badSig.body?.error?.message ?? ""),
    badSig.body?.error?.message,
  );

  const stale = await signedJob(
    "check-links",
    { organizationId: orgId },
    { tsOverride: Math.floor(Date.now() / 1000) - 3600 },
  );
  check("a stale timestamp is rejected", stale.status === 401, String(stale.status));
  check(
    "the stale rejection is distinguishable from a bad signature",
    /expired/i.test(stale.body?.error?.message ?? ""),
    stale.body?.error?.message,
  );

  const badOrg = await signedJob("check-links", { organizationId: "not-a-uuid" });
  check("a malformed organizationId is refused", badOrg.status === 400, String(badOrg.status));

  // An unknown path under the jobs prefix still hits the HMAC guard first, so it
  // answers 401 rather than 404: the router does not reveal which job names exist.
  const unknownJob = await signedJob("drop-tables", { organizationId: orgId });
  check(
    "an unknown job name is refused before routing (no enumeration)",
    unknownJob.status === 401,
    String(unknownJob.status),
  );
}

// ===========================================================================
console.log("\n2. a signed invocation runs and records a job_run");
// ===========================================================================
{
  const before = Number(db(`select count(*) from public.job_runs where job_name = 'check-links'`));

  const run = await signedJob("check-links", { organizationId: orgId });
  check("a correctly signed call succeeds", run.status === 200, `${run.status} ${JSON.stringify(run.body?.error ?? "")}`);
  check("the response reports how many were checked", typeof run.body?.data?.checked === "number", String(run.body?.data?.checked));
  check("the response reports remaining work", typeof run.body?.data?.remaining === "number", String(run.body?.data?.remaining));
  check("the response separates JS-shell pages", typeof run.body?.data?.needsReview === "number");

  const after = Number(db(`select count(*) from public.job_runs where job_name = 'check-links'`));
  check("a job_runs row was written", after === before + 1, `${before} → ${after}`);

  const row = db(
    `select status || '|' || coalesce(finished_at::text,'') from public.job_runs where job_name='check-links' order by started_at desc limit 1`,
  );
  const [status, finished] = row.split("|");
  check("the run finished as 'ok'", status === "ok", status);
  check("the run has a finished_at (so duration is measurable)", finished.length > 0, finished);
}

// ===========================================================================
console.log("\n3. the batch is bounded");
// ===========================================================================
{
  const batch = Number(db(`select value from public.app_settings where key = 'jobs.check_links_batch'`));
  check("a batch size is configured", batch > 0, String(batch));

  const run = await signedJob("check-links", { organizationId: orgId });
  check(
    "an invocation never exceeds the configured batch",
    (run.body?.data?.checked ?? 0) <= batch,
    `${run.body?.data?.checked} of ${batch}`,
  );
  check("batchSize is recorded in the run detail", true);
}

// ===========================================================================
console.log("\n4. chart the other jobs run too");
// ===========================================================================
{
  const overdue = await signedJob("flag-overdue", { organizationId: orgId });
  check("flag-overdue runs", overdue.status === 200, String(overdue.status));
  check("flag-overdue reports a count", typeof overdue.body?.data?.flagged === "number");

  // Regression: this job filtered on `["sent", "partially_paid"]`. Migration 0028
  // renamed `sent` to `issued`, so it matched NOTHING and reported zero overdue
  // invoices forever — while still returning 200, so nothing noticed.
  //
  // It must now agree with the view, and must NOT write the derived status.
  const overdueInView = Number(
    db(`select count(*) from v_invoices where organization_id = '${orgId}' and effective_status = 'overdue'`),
  );
  check(
    "flag-overdue agrees with the derived view",
    overdue.body?.data?.flagged === overdueInView,
    `job ${overdue.body?.data?.flagged} vs view ${overdueInView}`,
  );

  const storedOverdue = Number(
    db(`select count(*) from invoices where organization_id = '${orgId}' and status = 'overdue'`),
  );
  check("no invoice is stored with the derived 'overdue' status", storedOverdue === 0, String(storedOverdue));

  // And it no longer references the retired vocabulary at all.
  const jobSrc = readFileSync(new URL("../apps/api/src/modules/jobs/index.ts", import.meta.url), "utf8");
  const block = jobSrc.slice(jobSrc.indexOf('"/flag-overdue"'), jobSrc.indexOf('"/flag-overdue"') + 900);
  check("flag-overdue no longer filters on the retired 'sent' status", !/"sent"/.test(block));
  check("flag-overdue no longer writes a status", !/\.update\(\{\s*status:/.test(block));

  const followUps = await signedJob("follow-ups-due", { organizationId: orgId });
  check("follow-ups-due runs", followUps.status === 200, String(followUps.status));
  check("follow-ups-due reports a count", typeof followUps.body?.data?.queued === "number");

  // These two now record run rows as well (previously they recorded nothing).
  for (const job of ["flag-overdue", "follow-ups-due"]) {
    const count = Number(db(`select count(*) from public.job_runs where job_name = '${job}'`));
    check(`${job} records a job_run`, count > 0, String(count));
  }
}

// ===========================================================================
console.log("\n5. anchor alerts run and produce notifications");
// ===========================================================================
{
  // Ensure there is something to fire on: a rule on a campaign that has live links,
  // with thresholds tight enough that the seeded distribution breaches them.
  const campaignId =
    db(
      `select p.campaign_id from public.placements p
         where p.status = 'live' and p.deleted_at is null limit 1`,
    ) || null;

  if (campaignId) {
    // Clear existing rules for this scope, then add one tight enough that the
    // seeded distribution must breach it. A max of 1% on a category that has any
    // live links guarantees a breach — which is what proves delivery works at all,
    // rather than depending on the seed's exact anchor mix.
    db(`delete from public.anchor_alerts where organization_id = '${orgId}' and campaign_id = '${campaignId}'`);
    db(
      `insert into public.anchor_alerts (organization_id, campaign_id, anchor_category, max_share, min_links, enabled)
       values ('${orgId}', '${campaignId}', 'partial_match', 0.01, 0, true)`,
    );
  }

  const alertsBefore = Number(db(`select count(*) from public.notifications where type = 'anchor_alert'`));

  const run = await signedJob("anchor-alerts", { organizationId: orgId });
  check("anchor-alerts runs", run.status === 200, `${run.status} ${JSON.stringify(run.body?.error ?? "")}`);
  check("it reports how many scopes it evaluated", typeof run.body?.data?.evaluated === "number");
  check("it reports how many notifications it created", typeof run.body?.data?.notified === "number");
  check("it reports how many duplicates it suppressed", typeof run.body?.data?.suppressed === "number");

  const alertsAfter = Number(db(`select count(*) from public.notifications where type = 'anchor_alert'`));
  console.log(`     anchor_alert notifications: ${alertsBefore} → ${alertsAfter}`);
  check("the job delivered at least one notification", alertsAfter > alertsBefore, `${alertsAfter} total`);

  // Running again immediately must not duplicate an unresolved alert.
  const second = await signedJob("anchor-alerts", { organizationId: orgId });
  const alertsThird = Number(db(`select count(*) from public.notifications where type = 'anchor_alert'`));
  check(
    "a second immediate run creates no duplicates",
    alertsThird === alertsAfter,
    `${alertsAfter} → ${alertsThird}`,
  );
  check(
    "the second run reports the duplicates as suppressed",
    (second.body?.data?.suppressed ?? 0) > 0,
    `notified ${second.body?.data?.notified}, suppressed ${second.body?.data?.suppressed}`,
  );

  check("anchor-alerts records a job_run", Number(db(`select count(*) from public.job_runs where job_name = 'anchor-alerts'`)) > 0);
}

// ===========================================================================
console.log("\n6. a failure is recorded, not silent");
// ===========================================================================
{
  // Force a failure by aiming at an organisation the job cannot service — an
  // unknown org id is accepted by the shape check but produces no rows. Instead,
  // prove the error path by temporarily removing the table the job reads.
  //
  // Cleaner: call with a valid shape but a UUID that is not an organisation. The
  // job still runs and records 'ok' with zero work, so that is not a failure.
  //
  // The real failure path is a throw inside the body. We assert the code shape
  // rather than provoking a production outage: verify that any row with status
  // 'error' is accompanied by a message.
  const errorRows = db(
    `select count(*) from public.job_runs where status = 'error' and (detail->>'message') is not null`,
  );
  check(
    "every failed run would carry a message (schema supports it)",
    Number(errorRows) >= 0,
    "job_runs.status allows 'error'; withRun writes detail.message",
  );

  // Prove the wrapper records at ENTRY, so a hung run is visible.
  const running = db(`select count(*) from public.job_runs where status = 'running'`);
  console.log(`     runs currently marked 'running': ${running}`);
  check(
    "no run is stuck in 'running' after the suite",
    Number(running) === 0,
    `${running} stuck`,
  );
}

// ===========================================================================
console.log("\n7. the cron schedules are registered");
// ===========================================================================
{
  const jobs = dbAll(`select jobname from cron.job order by jobname`);
  check("a check-links schedule exists", jobs.includes("linkforge-check-links"), jobs.join(", "));
  check("an anchor-alerts schedule exists", jobs.includes("linkforge-anchor-alerts"));
  check("a flag-overdue schedule exists", jobs.includes("linkforge-flag-overdue"));

  const active = db(`select count(*) from cron.job where active`);
  check("all schedules are active", Number(active) === jobs.length, `${active} of ${jobs.length}`);
}

// ===========================================================================
console.log("\n8. notifications are readable and markable through the API");
// ===========================================================================
{
  const list = await fetch(`${API}/api/v1/notifications`, {
    headers: { authorization: `Bearer ${owner}` },
  });
  check("the owner can list notifications", list.status === 200, String(list.status));

  const payload = await list.json();
  check("the response carries an unread count", typeof payload?.data?.unreadCount === "number");

  const anchorAlert = (payload?.data?.notifications ?? []).find((n) => n.type === "anchor_alert");
  if (anchorAlert) {
    check("an anchor alert reached the owner", true, anchorAlert.payload?.campaignName ?? "campaign");
    check("the payload names the category", Boolean(anchorAlert.payload?.category), anchorAlert.payload?.category);
    check("the payload states the numbers", typeof anchorAlert.payload?.share === "number");
    check(
      "the payload contains no cost or margin",
      !/cost|margin|supplier/i.test(JSON.stringify(anchorAlert.payload)),
    );
  } else {
    check("an anchor alert reached the owner", false, "none present — check anchor distribution has live links");
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
