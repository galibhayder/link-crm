/**
 * PHASE 6 — MIGRATION AND RLS VERIFICATION.
 *
 * Inspects the actual database rather than trusting the migration files: a
 * constraint that was written but silently skipped, or an RLS flag left off a new
 * table, both look fine in source and wrong in production.
 */
import { execSync } from "node:child_process";

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

/**
 * Reads a MULTI-LINE value (function source, view definition).
 *
 * `db1` returns only the first line, which silently truncated every
 * `select prosrc` / `get_viewdef` assertion in this suite and produced fifteen
 * false failures while the SQL was correct. Body inspections need the whole text.
 */
const dbText = (sql) =>
  execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: "utf8",
  }).trim();

const dbAll = (sql) =>
  execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: "utf8",
  })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

// ===========================================================================
console.log("\n1. the status vocabulary");
// ===========================================================================
{
  const constraint = db1(
    `select pg_get_constraintdef(oid) from pg_constraint where conname = 'invoices_status_check'`,
  );

  for (const status of ["draft", "issued", "published", "partially_paid", "paid", "overdue", "cancelled"]) {
    check(`the CHECK permits '${status}'`, constraint.includes(`'${status}'`), "");
  }

  check("the old 'sent' value is gone", !constraint.includes("'sent'"), constraint.slice(0, 90));
  check("the old 'void' value is gone", !constraint.includes("'void'"));

  // And no row is left on a retired value.
  const stale = db1(`select count(*) from invoices where status in ('sent','void')`);
  check("no invoice row still uses a retired status", stale === "0", stale);
}

// ===========================================================================
console.log("\n2. new invoice columns and constraints");
// ===========================================================================
{
  const cols = dbAll(
    `select column_name from information_schema.columns where table_name = 'invoices'`,
  );

  for (const col of [
    "discount_amount",
    "payment_instructions",
    "agency_partner_id",
    "published_at",
    "cancelled_at",
    "snapshot",
    "snapshot_version",
    "snapshot_hash",
  ]) {
    check(`invoices has '${col}'`, cols.includes(col));
  }

  const discountCheck = db1(
    `select pg_get_constraintdef(oid) from pg_constraint where conname = 'invoices_discount_check'`,
  );
  // Postgres normalises `>= 0` to `>= (0)::numeric`, so the assertion matches on
  // the column and a non-negative comparison rather than on the literal source.
  check(
    "a discount cannot go negative",
    /discount_amount >= /.test(discountCheck) && !/-/.test(discountCheck.replace(/::numeric/g, "")),
    discountCheck,
  );

  const currencyCheck = db1(
    `select pg_get_constraintdef(oid) from pg_constraint where conname = 'invoices_currency_iso'`,
  );
  check("currency is constrained to an ISO code", /\[A-Z\]/.test(currencyCheck), currencyCheck);
}

// ===========================================================================
console.log("\n3. the totals function applies discount before tax");
// ===========================================================================
{
  const src = dbText(`select prosrc from pg_proc where proname = 'recompute_invoice_totals'`);
  check("the subtotal is summed from line items", /sum\(li\.amount\)/.test(src));
  check("the discount is clamped to the subtotal", /least\(/.test(src));
  check("tax uses the discounted base", /v_effective \* v_tax_rate/.test(src));
  check("the total adds tax after discount", /v_effective \+ v_tax/.test(src));
}

// ===========================================================================
console.log("\n4. the recompute no longer writes overdue");
// ===========================================================================
{
  const src = dbText(`select prosrc from pg_proc where proname = 'recompute_invoice_status'`);
  check(
    "recompute_invoice_status does NOT write 'overdue'",
    !/'overdue'/.test(src),
    "overdue is derived in v_invoices",
  );
  check("it still protects the cancelled state", /cancelled/.test(src));
}

// ===========================================================================
console.log("\n5. v_invoices derives status and balance");
// ===========================================================================
{
  const cols = dbAll(
    `select column_name from information_schema.columns where table_name = 'v_invoices'`,
  );

  for (const col of ["effective_status", "paid_amount", "balance", "days_overdue", "client_name"]) {
    check(`v_invoices exposes '${col}'`, cols.includes(col));
  }

  const def = dbText(`select pg_get_viewdef('public.v_invoices'::regclass, true)`);
  check("the view derives effective_status", /effective_status/i.test(def));
  // Postgres qualifies the column as `sum(payments.amount)` when it deparses.
  check("the view sums payments", /sum\(payments\.amount\)/i.test(def), def.slice(0, 60));

  // It must be security_invoker, or a client could read every invoice.
  const opts = db1(`select reloptions::text from pg_class where relname = 'v_invoices'`);
  check("v_invoices is security_invoker (RLS applies to the caller)", /security_invoker=true/.test(opts), opts);
}

// ===========================================================================
console.log("\n6. new tables exist with RLS");
// ===========================================================================
{
  const tables = dbAll(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relname in
     ('writer_payouts','campaign_expenses','invoice_share_links')`,
  );

  for (const table of ["writer_payouts", "campaign_expenses", "invoice_share_links"]) {
    check(`${table} exists`, tables.includes(table));

    const flags = db1(
      `select c.relrowsecurity || '/' || c.relforcerowsecurity from pg_class c
       where c.relname = '${table}'`,
    );
    check(`${table} has RLS enabled AND forced`, flags === "true/true", flags);

    const policies = db1(`select count(*) from pg_policies where tablename = '${table}'`);
    check(`${table} has at least one policy`, Number(policies) > 0, `${policies} policies`);
  }
}

// ===========================================================================
console.log("\n7. payout and expense tables are owner-only");
// ===========================================================================
{
  for (const table of ["writer_payouts", "campaign_expenses"]) {
    const quals = dbAll(`select coalesce(qual, with_check, '') from pg_policies where tablename = '${table}'`);
    const text = quals.join(" | ");

    check(`${table} restricts to owner`, /'owner'::text/.test(text), text.slice(0, 100));
    check(
      `${table} does not grant access to account_manager`,
      !/'account_manager'::text/.test(text),
      "AM must not see internal pay",
    );
  }
}

// ===========================================================================
console.log("\n8. share link integrity");
// ===========================================================================
{
  const hashCheck = db1(
    `select pg_get_constraintdef(oid) from pg_constraint where conname = 'invoice_share_links_hash_format'`,
  );
  check("the token hash is constrained to 64 hex chars", /\[0-9a-f\]\{64\}/.test(hashCheck), hashCheck);

  const uniqueIdx = db1(
    `select indexdef from pg_indexes where indexname = 'invoice_share_links_one_active_idx'`,
  );
  check("only one ACTIVE link per invoice is possible", /UNIQUE/.test(uniqueIdx) && /revoked_at IS NULL/.test(uniqueIdx), uniqueIdx.slice(0, 110));

  const cols = dbAll(`select column_name from information_schema.columns where table_name = 'invoice_share_links'`);
  check("the raw token is never stored", !cols.includes("token"), cols.join(","));
  check("only the hash is stored", cols.includes("token_hash"));

  const expiryCheck = db1(
    `select pg_get_constraintdef(oid) from pg_constraint where conname = 'invoice_share_links_expiry_after_creation'`,
  );
  check("an expiry must be after creation", /expires_at > created_at/.test(expiryCheck), expiryCheck);
}

// ===========================================================================
console.log("\n9. the anonymous resolver is service_role only");
// ===========================================================================
{
  const grants = dbAll(
    `select coalesce(array_to_string(proacl, ','), '') from pg_proc where proname = 'resolve_invoice_share'`,
  ).join("");
  check(
    "resolve_invoice_share is not executable by authenticated",
    !/authenticated=X/.test(grants),
    grants.slice(0, 120),
  );
  check("resolve_invoice_share is not executable by anon", !/anon=X/.test(grants));

  const src = dbText(`select prosrc from pg_proc where proname = 'resolve_invoice_share'`);
  check("the resolver checks revocation", /revoked_at is null/.test(src));
  check("the resolver checks expiry", /expires_at is null or l\.expires_at > now\(\)/.test(src));
  check("the resolver excludes cancelled invoices", /cancelled/.test(src));
}

// ===========================================================================
console.log("\n10. profitability views are service_role only");
// ===========================================================================
{
  for (const view of ["v_campaign_profitability", "v_financial_summary", "v_financial_ledger"]) {
    const exists = db1(
      `select count(*) from information_schema.views where table_name = '${view}'`,
    );
    check(`${view} exists`, exists === "1", exists);

    const grants = dbAll(
      `select coalesce(array_to_string(relacl, ','), '') from pg_class where relname = '${view}'`,
    ).join("");
    check(`${view} is not granted to authenticated`, !/authenticated=/.test(grants), grants.slice(0, 80));
  }
}

// ===========================================================================
console.log("\n11. arithmetic is numeric, not float");
// ===========================================================================
{
  const def = dbText(`select pg_get_viewdef('public.v_campaign_profitability'::regclass, true)`);

  check("gross_profit is cast to numeric(12,2)", /numeric\(12,2\)/.test(def));
  check("margin_pct rounds exactly once", /round\(/.test(def));
  check("no float8 cast appears in the view", !/::double precision|::float/i.test(def));

  // The view never sums across currencies: each column is joined on the code.
  check("components are joined on currency", /and r\.currency = k\.currency/.test(def) || /currency = k\.currency/.test(def));
  check("the view reports a multi_currency flag", /multi_currency/.test(def));
}

// ===========================================================================
console.log("\n12. audit actions were widened");
// ===========================================================================
{
  const constraint = db1(
    `select pg_get_constraintdef(oid) from pg_constraint where conname = 'activity_log_action_check'`,
  );

  for (const action of ["publish", "unpublish", "share_link_created", "share_link_revoked", "view", "download"]) {
    check(`activity_log accepts '${action}'`, constraint.includes(`'${action}'`), "");
  }

  check("the original actions still work", constraint.includes("'create'") && constraint.includes("'role_change'"));
}

// ===========================================================================
console.log("\n13. every migration applied");
// ===========================================================================
{
  const count = db1(`select count(*) from supabase_migrations.schema_migrations`);
  check("at least 30 migrations are recorded", Number(count) >= 30, count);

  // Assert the PHASE 6 SET is present, not "the newest three contain 0030".
  //
  // That assertion expired the moment 0031 shipped: it looked at the three most
  // recent migrations, so adding any later file made it fail while the schema it
  // was guarding was still perfectly correct. Version-specific tests have to be
  // written against the set, or every later phase breaks them for no reason.
  const all = dbAll(`select version from supabase_migrations.schema_migrations`);
  const missing = ["0028", "0029", "0030", "0031"].filter((v) => !all.some((x) => x.includes(v)));
  check("every Phase 6 migration is present", missing.length === 0, missing.join(", ") || "all present");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
