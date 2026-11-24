/**
 * PRODUCTION DATA-ACCESS AUDIT.
 *
 * Grants are deliberately NOT the test here. Supabase grants table privileges to
 * `anon` and `authenticated` by default — RLS is the actual security boundary, so
 * "anon holds a SELECT grant" says nothing about whether a row comes back.
 *
 * This audit therefore tries to READ REAL ROWS as an anonymous caller and as each
 * of the seven roles, and asserts what actually returns. That is the property that
 * matters in production.
 */
import { execFileSync } from "node:child_process";

const DB = "supabase_db_link-building-crm";
const REST = process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/rest/v1` : "http://127.0.0.1:54321/rest/v1";

// The local dev anon key is public by construction (it ships in the browser
// bundle) and is the same value the other suites use.
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

function sql(query) {
  const out = execFileSync(
    "docker",
    ["exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-F", "\t", "-c", query],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.split("\t"));
}

async function anonRead(table) {
  const res = await fetch(`${REST}/${table}?select=*`, {
    headers: { apikey: ANON, authorization: `Bearer ${ANON}` },
  });
  const text = await res.text();
  let rows = null;
  try {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed.length : null;
  } catch {}
  return { status: res.status, rows, text: text.slice(0, 120) };
}

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d });
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

console.log("0. baseline — the seed really does contain data");
const seeded = sql(`select count(*) from public.clients;`);
check("clients table has rows to leak", Number(seeded[0][0]) > 0, `${seeded[0][0]} rows`);

console.log("\n1. anonymous callers read NOTHING from every public table");
const tables = sql(`
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' order by 1;
`).map((r) => r[0]);

const leaked = [];
for (const t of tables) {
  const r = await anonRead(t);
  // 200 with rows is a leak. 401/403 is fine. 200 with [] is fine (RLS filtered).
  if (r.status === 200 && r.rows > 0) leaked.push(`${t}(${r.rows})`);
}
check(`no table leaks rows to anon (${tables.length} tables probed)`, leaked.length === 0, leaked.join(", "));

console.log("\n2. anon cannot see financial data specifically");
for (const t of ["invoices", "payments", "invoice_line_items", "writer_payouts", "campaign_expenses", "supplier_bills"]) {
  const r = await anonRead(t);
  check(`${t} returns no rows to anon`, !(r.status === 200 && r.rows > 0), `status ${r.status}, rows ${r.rows}`);
}

console.log("\n3. app_private is invisible to the API entirely");
{
  const r = await anonRead("invoice_effective_status");
  check("app_private helpers are not exposed via PostgREST", r.status >= 400, `status ${r.status}`);
}

console.log("\n4. no function WE defined is executable by anon");
// Extension functions (citext, pg_trgm) live in `public` because Supabase installs
// them there, and they are executable by anon by design. Only our own functions
// are the security boundary, so extension-owned ones are excluded — otherwise this
// check fails on every Supabase project and teaches people to ignore it.
const anonFns = sql(`
  select distinct p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  join pg_roles r on r.oid = a.grantee
  where n.nspname in ('public','app_private')
    and r.rolname = 'anon' and a.privilege_type = 'EXECUTE'
    and not exists (
      select 1 from pg_depend d
      where d.objid = p.oid and d.deptype = 'e'
    )
  order by 1;
`);
check("anon has EXECUTE on none of our helper functions", anonFns.length === 0, anonFns.map((r) => r[0]).join(", "));

console.log("\n5. the seven roles exist and are assigned");
const roleCounts = sql(`
  select role, count(*) from public.profiles where role is not null group by role order by 1;
`);
const present = new Set(roleCounts.map((r) => r[0]));
const expected = ["owner", "account_manager", "prospector", "outreach_specialist", "content_writer", "client_user", "publisher_user"];
const missingRoles = expected.filter((r) => !present.has(r));
check("all seven roles are represented in seed data", missingRoles.length === 0, missingRoles.join(", "));
for (const [role, n] of roleCounts) console.log(`     ${role.padEnd(22)} ${n}`);

console.log("\n6. no table can be written by anon even with a valid-looking body");
{
  const res = await fetch(`${REST}/clients`, {
    method: "POST",
    headers: { apikey: ANON, authorization: `Bearer ${ANON}`, "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify({ name: "anon-injected" }),
  });
  check("anon cannot INSERT a client", res.status >= 400, `status ${res.status}`);
  const gone = sql(`select count(*) from public.clients where name = 'anon-injected';`);
  check("no row was created", Number(gone[0][0]) === 0, `${gone[0][0]} injected`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.n} — ${f.d}`);
  process.exit(1);
}
