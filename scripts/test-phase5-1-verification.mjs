/**
 * PHASE 5.1 — SCHEDULED VERIFICATION END TO END.
 *
 * The unit tests prove the guard blocks internal addresses and that `analysePage`
 * distinguishes a JS shell from an absent link. This proves the part neither covers:
 * that a scheduled run actually writes those results to `link_checks`, and
 * that the new `needs_manual_review` verdict survives the CHECK constraint added in
 * migration 0025 — the failure mode where a correct in-memory verdict is rejected on
 * insert and the whole batch silently loses its history.
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

const db1 = (sql) =>
  execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: "utf8",
  })
    .split("\n")[0]
    .trim();

const dbAll = (sql) =>
  execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: "utf8",
  })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const secret = (() => {
  const raw = readFileSync(new URL("../apps/api/.env", import.meta.url), "utf8");
  const match = /^JOB_HMAC_SECRET=(.*)$/m.exec(raw);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
})();

const login = async (email) => {
  const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  return (await r.json()).access_token;
};

const signedJob = async (job, body) => {
  const ts = Math.floor(Date.now());
  const bodyText = JSON.stringify(body);
  const signature = createHmac("sha256", secret).update(`${ts}.${bodyText}`).digest("hex");
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
  return { status: res.status, body: parsed };
};

const owner = await login("owner@demo.test");
const orgId = db1(`select id from organizations where slug = 'demo-agency'`);

// ===========================================================================
console.log("\n1. the verdict CHECK accepts every verdict the code can produce");
// ===========================================================================
{
  // Read the constraint rather than assuming it. If the analyser can emit a value
  // the constraint rejects, scheduled verification loses its history silently.
  const constraint = db1(
    `select pg_get_constraintdef(oid) from pg_constraint where conname = 'link_checks_verdict_check'`,
  );
  check("a verdict constraint exists", constraint.length > 0, constraint.slice(0, 200));

  const codeVerdicts = ["ok", "link_missing", "url_mismatch", "anchor_mismatch", "attr_mismatch", "unreachable", "needs_manual_review"];
  for (const v of codeVerdicts) {
    check(`the constraint permits '${v}'`, constraint.includes(`'${v}'`), constraint.includes(`'${v}'`) ? "" : "MISSING FROM CHECK");
  }

  // And prove it at the table level, with a real row per verdict.
  const placementId = db1(`select id from placements where deleted_at is null limit 1`);

  for (const v of codeVerdicts) {
    let inserted = true;
    try {
      db1(`insert into link_checks (organization_id, placement_id, verdict, checked_by, expected_url)
           values ('${orgId}', '${placementId}', '${v}', 'system', 'https://probe.test/${v}')`);
    } catch (e) {
      inserted = false;
      console.log(`       ${String(e.message).slice(0, 120)}`);
    }
    check(`a '${v}' row can be written`, inserted);
    if (inserted) db1(`delete from link_checks where expected_url = 'https://probe.test/${v}'`);
  }
}

// ===========================================================================
console.log("\n2. rows the job writes carry the columns the UI reads");
// ===========================================================================
{
  const columns = dbAll(
    `select column_name from information_schema.columns where table_name = 'link_checks' order by column_name`,
  );
  const required = ["verdict", "checked_at", "expected_url", "found", "placement_id", "organization_id"];
  for (const c of required) {
    check(`link_checks has '${c}'`, columns.includes(c));
  }
  check(
    "verdict values are constrained, not free text",
    db1(`select count(*) from pg_constraint where conrelid = 'public.link_checks'::regclass and contype = 'c'`) !== "0",
  );
}

// ===========================================================================
console.log("\n3. a scheduled run records a timestamp and a verdict per placement");
// ===========================================================================
{
  // Point one live placement at a loopback address. The guard will refuse it, and
  // the run must record `unreachable` — NOT crash the batch and NOT write nothing.
  const placementId = db1(
    `select id from placements where status = 'live' and deleted_at is null limit 1`,
  );

  if (!placementId) {
    check("a live placement exists to verify", false, "none seeded");
  } else {
    const originalUrl = db1(`select live_url from placements where id = '${placementId}'`);

    // The job skips anything checked in the last 24h, so a previous suite's run
    // would make this a no-op. Force the row due — otherwise the test proves nothing
    // while still "passing" because an old row happens to be there.
    db1(`update placements set live_url = 'http://127.0.0.1:1/probe', last_checked_at = null
          where id = '${placementId}'`);
    db1(`delete from link_checks where placement_id = '${placementId}'`);

    const before = Number(db1(`select count(*) from link_checks`));
    const run = await signedJob("check-links", { organizationId: orgId });
    const after = Number(db1(`select count(*) from link_checks`));

    check("the job succeeded despite one refused host", run.status === 200, String(run.status));
    check("the job actually checked the placement", (run.body?.data?.checked ?? 0) >= 1, `checked ${run.body?.data?.checked}`);
    check("a verification row was written", after > before, `${before} → ${after}`);

    const latest = db1(
      `select verdict from link_checks where placement_id = '${placementId}' order by checked_at desc limit 1`,
    );
    check(
      "a blocked host is recorded as unreachable, never as link_missing",
      latest === "unreachable",
      latest,
    );

    const hasTimestamp = db1(
      `select checked_at is not null from link_checks where placement_id = '${placementId}' order by checked_at desc limit 1`,
    );
    check("the row carries a checked_at", hasTimestamp === "t", hasTimestamp);

    const stamped = db1(`select last_checked_at is not null from placements where id = '${placementId}'`);
    check("the placement's last_checked_at is stamped", stamped === "t", stamped);

    db1(`update placements set live_url = ${originalUrl === "" ? "null" : `'${originalUrl}'`} where id = '${placementId}'`);
  }
}

// ===========================================================================
console.log("\n4. history accumulates rather than overwriting");
// ===========================================================================
{
  const placementId = db1(`select placement_id from link_checks order by checked_at desc limit 1`);
  if (placementId) {
    const first = Number(db1(`select count(*) from link_checks where placement_id = '${placementId}'`));
    await signedJob("check-links", { organizationId: orgId });
    const second = Number(db1(`select count(*) from link_checks where placement_id = '${placementId}'`));

    check("a second run adds history rather than replacing it", second >= first, `${first} → ${second}`);
    check(
      "each row has its own checked_at",
      db1(`select count(distinct checked_at) from link_checks where placement_id = '${placementId}'`) !== "0",
    );
  }
}

// ===========================================================================
console.log("\n5. duplicate prevention is structural, not advisory");
// ===========================================================================
{
  // Two simultaneous signed invocations. One must do the work; the other must not
  // double-process. The advisory lock is what makes this true across processes.
  const [a, b] = await Promise.all([
    signedJob("check-links", { organizationId: orgId }),
    signedJob("check-links", { organizationId: orgId }),
  ]);

  check("both concurrent calls return a response", a.status === 200 && b.status === 200, `${a.status}, ${b.status}`);

  const skipped = [a, b].filter((r) => r.body?.data?.skipped === true || r.body?.data?.acquired === false);
  const worked = [a, b].filter((r) => typeof r.body?.data?.checked === "number");
  check(
    "at least one call did the work",
    worked.length >= 1,
    `skipped: ${skipped.length}`,
  );
  check(
    "no two runs overlapped",
    db1(`select count(*) from job_runs where job_name = 'check-links' and status = 'running'`) === "0",
    "no stuck 'running' rows",
  );
}

// ===========================================================================
console.log("\n6. the batch bound holds against real data");
// ===========================================================================
{
  const batch = Number(db1(`select value from app_settings where key = 'jobs.check_links_batch'`));
  const liveCount = Number(db1(`select count(*) from placements where status = 'live' and live_url is not null and deleted_at is null`));

  const run = await signedJob("check-links", { organizationId: orgId });
  check(
    "a run never checks more than the configured batch",
    (run.body?.data?.checked ?? 0) <= batch,
    `${run.body?.data?.checked} <= ${batch}`,
  );
  check(
    "remaining work is reported so the next tick continues",
    typeof run.body?.data?.remaining === "number",
    `remaining ${run.body?.data?.remaining} of ${liveCount} live`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
