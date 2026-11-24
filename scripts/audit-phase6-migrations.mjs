/**
 * MIGRATION INTEGRITY AUDIT.
 *
 * Checks the things a schema review looks for: that new functions are not callable
 * by end users, that RLS is on everywhere, and that a fresh database reproduces
 * what the tests assume.
 */
import { execSync } from "node:child_process";

const db = (sql) =>
  execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: "utf8",
  }).trim();

const dbAll = (sql) => db(sql).split("\n").map((l) => l.trim()).filter(Boolean);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

console.log("1. new internal functions are not callable by end users");

for (const fn of [
  "app_private.invoice_effective_status(text, numeric, numeric, date, timestamptz, timestamptz)",
  "app_private.invoice_days_overdue(numeric, numeric, date)",
]) {
  const acl = db(
    `select coalesce(array_to_string(proacl, ','), 'null') from pg_proc
     where oid = '${fn}'::regprocedure`,
  );
  check(`${fn.split("(")[0]} has no authenticated grant`, !/authenticated=/.test(acl), acl.slice(0, 60));
  check(`${fn.split("(")[0]} has no anon grant`, !/anon=/.test(acl), acl.slice(0, 60));
}

const shareAcl = db(
  `select coalesce(array_to_string(proacl, ','), 'null') from pg_proc where proname = 'resolve_invoice_share'`,
);
check("resolve_invoice_share is not callable by authenticated", !/authenticated=/.test(shareAcl));
check("resolve_invoice_share is not callable by anon", !/anon=/.test(shareAcl));

console.log("\n2. RLS on every Phase 6 table");

for (const table of ["writer_payouts", "campaign_expenses", "invoice_share_links", "invoices", "invoice_line_items", "payments"]) {
  const flags = db(
    `select relrowsecurity || '/' || relforcerowsecurity from pg_class where relname = '${table}'`,
  );
  check(`${table} RLS enabled and forced`, flags === "true/true", flags);
}

console.log("\n3. no table is missing a policy");

const noPolicy = dbAll(
  `select c.relname from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     and not exists (select 1 from pg_policies p where p.tablename = c.relname)
   order by c.relname`,
);
check("every RLS-enabled table has a policy", noPolicy.length === 0, noPolicy.join(", ") || "none missing");

console.log("\n4. the status ladder has exactly one definition");

const statusFns = dbAll(
  `select proname from pg_proc where pronamespace = 'app_private'::regnamespace and proname like '%effective_status%'`,
);
check("exactly one effective-status function exists", statusFns.length === 1, statusFns.join(","));

const viewDef = db(
  `select pg_get_viewdef('public.v_invoices'::regclass, true)`,
);
check("v_invoices calls the shared function", /invoice_effective_status/.test(viewDef));
check("v_invoices does not inline its own CASE ladder", !/CASE\s+WHEN i\.status = 'cancelled'/i.test(viewDef));

const resolverDef = db(`select prosrc from pg_proc where proname = 'resolve_invoice_share'`);
check("the share resolver calls the shared function", /invoice_effective_status/.test(resolverDef));

console.log("\n5. monetary columns are numeric, never float");

const floatCols = dbAll(
  `select table_name || '.' || column_name || ' ' || data_type
   from information_schema.columns
   where table_schema = 'public'
     and data_type in ('double precision','real')
     and table_name in ('invoices','invoice_line_items','payments','writer_payouts','campaign_expenses','placement_costs','placement_pricing')`,
);
check("no float columns in the financial tables", floatCols.length === 0, floatCols.join(", ") || "none");

console.log("\n6. migration count and ordering");

// Asserted against the FILES rather than a hardcoded number.
//
// The literal (31) had to be edited every time a phase added a migration, and a
// stale literal looks exactly like a broken schema. Deriving it from the directory
// means this check keeps meaning something.
const fs = await import("node:fs");
const migrationFiles = fs
  .readdirSync("supabase/migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort();

const count = Number(db(`select count(*) from supabase_migrations.schema_migrations`));
check(
  `every migration file is applied (${migrationFiles.length} on disk)`,
  count === migrationFiles.length,
  `${count} applied`,
);

const lastApplied = db(`select version from supabase_migrations.schema_migrations order by version desc limit 1`);
const lastFile = migrationFiles.at(-1)?.replace(/\.sql$/, "") ?? "";
check("the newest file on disk is the newest applied migration", lastApplied.startsWith(lastFile.slice(0, 14)), `${lastApplied} vs ${lastFile}`);

console.log("\n7. the share token is stored only as a hash");

const shareCols = dbAll(
  `select column_name from information_schema.columns where table_name = 'invoice_share_links'`,
);
check("no plaintext token column", !shareCols.includes("token"), shareCols.join(","));
check("a hash column exists", shareCols.includes("token_hash"));

const hashRows = db(`select count(*) from invoice_share_links where token_hash !~ '^[0-9a-f]{64}$'`);
check("every stored hash is 64 hex chars", hashRows === "0", hashRows);

console.log(`\n${failures === 0 ? "migration audit clean" : `${failures} migration issues`}`);
process.exit(failures === 0 ? 0 : 1);
