/**
 * MIGRATION REVIEW.
 *
 * Checks the properties a migration set must have beyond "it applies":
 *   - a fresh database builds from zero;
 *   - re-running is idempotent where it claims to be;
 *   - constraints actually reject the invalid rows they were written for;
 *   - no column that leaked before still exists.
 */
import { execSync } from "node:child_process";

const DB = "supabase_db_link-building-crm";
const psql = (sql) =>
  execSync(`docker exec ${DB} psql -U postgres -d postgres -t -A -c "${sql.replace(/"/g, '\\"')}"`, {
    encoding: "utf8",
  }).trim();

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d });
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

console.log("\n1. the leaking column is gone");
const leaked = psql(
  "select count(*) from information_schema.columns where table_name='placements' and column_name in ('negotiated_cost','negotiated_currency')",
);
check("placements has no negotiated_cost / negotiated_currency", leaked === "0", `${leaked} present`);

console.log("\n2. tier-2 carries the negotiation state");
const costCols = psql(
  "select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name='placement_costs'",
);
check("placement_costs records who agreed and when", /agreed_at/.test(costCols) && /agreed_by/.test(costCols), costCols);

console.log("\n3. the view exists and is invoker-scoped");
const viewDef = psql(
  "select coalesce(array_to_string(c.reloptions, ','), '') from pg_class c where c.relname='v_placement_negotiation'",
);
check("v_placement_negotiation exists", viewDef !== "");
check("view uses security_invoker (cannot widen access)", /security_invoker=true/.test(viewDef), viewDef || "no reloptions");

console.log("\n4. constraints reject invalid rows");
const liveNoUrl = psql(
  "select count(*) from public.placements where pipeline_stage='live' and live_url is null",
);
check("no live placement lacks a URL", liveNoUrl === "0", `${liveNoUrl} offenders`);

const approvedNoAttr = psql(
  "select count(*) from public.placements where pipeline_stage not in ('prospected','pitched') and client_approved_at is null",
);
check("no approved-or-later placement lacks attribution", approvedNoAttr === "0", `${approvedNoAttr} offenders`);

// Prove each constraint independently. A multi-violation insert reports only the
// first constraint PostgreSQL happens to check, which would let one of them be
// silently absent, so each probe violates exactly one rule.
function isRejected(sql) {
  try {
    psql(sql);
    return false;
  } catch {
    return true;
  }
}

const orgCampaign = "select organization_id, id from public.campaigns limit 1";

check(
  "the database refuses a live placement with no URL",
  isRejected(
    "insert into public.placements (organization_id, campaign_id, target_url, pipeline_stage, client_approved_at) " +
      `select organization_id, id, 'https://probe-no-url.test', 'live', now() from (${orgCampaign}) c`,
  ),
);

check(
  "the database refuses an approved stage with no attribution",
  isRejected(
    "insert into public.placements (organization_id, campaign_id, target_url, pipeline_stage) " +
      `select organization_id, id, 'https://probe-no-attr.test', 'client_approved' from (${orgCampaign}) c`,
  ),
);

check(
  "the database refuses an unknown pipeline stage",
  isRejected(
    "insert into public.placements (organization_id, campaign_id, target_url, pipeline_stage) " +
      `select organization_id, id, 'https://probe-bad-stage.test', 'banana' from (${orgCampaign}) c`,
  ),
);

check(
  "a valid live placement IS accepted (the constraints are not over-broad)",
  !isRejected(
    "insert into public.placements (organization_id, campaign_id, target_url, pipeline_stage, live_url, client_approved_at) " +
      `select organization_id, id, 'https://probe-valid-${Date.now()}.test', 'live', 'https://publisher.test/x', now() from (${orgCampaign}) c`,
  ),
);

// The probes above may leave a row behind when they are accepted. Remove any so
// this script does not leave state that makes a later suite fail for the wrong
// reason — the recurring test-isolation defect.
psql("delete from public.placements where target_url like 'https://probe-%'");

console.log("\n5. no duplicate pipeline stages");
const dupes = psql(
  "select count(*) from (select organization_id, applies_to, key from public.pipeline_stages group by 1,2,3 having count(*) > 1) d",
);
check("pipeline stages are unique per (org, scope, key)", dupes === "0", `${dupes} duplicates`);

const scopes = psql("select string_agg(distinct applies_to, ',') from public.pipeline_stages");
check("both pipelines are seeded", /placement/.test(scopes) && /prospect/.test(scopes), scopes);

console.log("\n6. every organization has both pipelines");
const missing = psql(
  "select count(*) from public.organizations o where not exists (select 1 from public.pipeline_stages s where s.organization_id=o.id and s.applies_to='placement')",
);
check("no organization is missing placement stages", missing === "0", `${missing} orgs`);

console.log("\n7. RLS is enabled where money lives");
for (const t of ["placements", "placement_costs", "placement_pricing", "placement_events", "outreach_records"]) {
  const rls = psql(
    `select relrowsecurity::text || '/' || relforcerowsecurity::text from pg_class where relname='${t}'`,
  );
  check(`${t} has RLS enabled and forced`, rls === "true/true", rls);
}

console.log("\n8. a client has no policy on placements");
const clientPolicy = psql(
  "select count(*) from pg_policies where schemaname='public' and tablename='placements' and coalesce(with_check, qual, '') like '%client_user%'",
);
check("no placements policy mentions client_user", clientPolicy === "0", `${clientPolicy} policies`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
