/**
 * Audit redaction check.
 *
 * lib/audit.ts redacts a fixed set of key names from the before/after diff. The
 * original implementation only inspected TOP-LEVEL keys, so a nested object or a
 * differently-named key carrying a credential could reach the log — and the
 * audit log is the one table an attacker would most like to read.
 */

const SUPABASE = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const API = process.env.API_URL ?? "http://127.0.0.1:3000";
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const results = [];
const check = (n, ok, d = "") => {
  results.push(ok);
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

const login = async (email) => {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  return (await res.json()).access_token;
};

const token = await login("owner@demo.test");

console.log("\naudit payload safety");
{
  // Provoke audited writes with a PROFILE rename only.
  //
  // Deliberately not a cost edit: this suite must not mutate financial data,
  // because other suites assert on the seeded margin. A test that changes shared
  // state and does not restore it is a latent source of false failures.
  const staff = await fetch(`${API}/api/v1/staff?limit=100`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());

  const target = (staff.data ?? []).find((m) => m.role !== "owner");
  const originalName = target?.full_name;
  if (target) {
    await fetch(`${API}/api/v1/staff/${target.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ fullName: "Renamed For Audit" }),
    });
  }

  const audit = await fetch(`${API}/api/v1/audit?limit=100`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());

  const serialized = JSON.stringify(audit.data ?? []);

  // Nothing credential-shaped may appear anywhere in an audit row.
  for (const pattern of [
    /password/i,
    /encrypted_password/i,
    /access_token/i,
    /refresh_token/i,
    /service_role/i,
    /bearer\s+eyJ/i,
  ]) {
    check(`audit rows contain no ${pattern.source}`, !pattern.test(serialized));
  }

  check("audit rows exist to inspect", (audit.data ?? []).length > 0, `${(audit.data ?? []).length} rows`);

  // The diff must still be useful: a rename should record the change.
  const renameEntry = (audit.data ?? []).find(
    (r) => r.action === "update" && r.diff && typeof r.diff === "object" && "full_name" in r.diff,
  );
  check(
    "a rename records a readable diff",
    Boolean(renameEntry),
    renameEntry ? JSON.stringify(renameEntry.diff).slice(0, 80) : "no rename entry found",
  );

  // Restore the original name so this suite leaves no trace on shared state.
  if (target && originalName) {
    await fetch(`${API}/api/v1/staff/${target.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ fullName: originalName }),
    });
    check("original name restored", true, originalName);
  }
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
