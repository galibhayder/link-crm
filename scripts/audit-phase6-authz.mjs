/**
 * AUTHORIZATION SWEEP.
 *
 * Enumerates every Phase 6 endpoint and asserts the response for each role. The
 * point is to find a gap I did not think to test, not to re-confirm the ones I did.
 */
const API = "http://127.0.0.1:3000";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const login = async (email) => {
  const r = await fetch("http://127.0.0.1:54321/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  return (await r.json()).access_token;
};

const roles = {
  owner: await login("owner@demo.test"),
  am: await login("am@demo.test"),
  writer: await login("writer@demo.test"),
  prospector: await login("prospector@demo.test"),
  outreach: await login("outreach@demo.test"),
  publisher: await login("publisher@demo.test"),
  client: await login("client@demo.test"),
};

// Financial-sensitivity per endpoint: what SHOULD happen.
//
// `publisher_user` is a SUPPLIER-surface role. `authenticate` rejects it on
// `/api/v1` before any handler runs, so 403 everywhere here is correct — it
// reaches reports through `/supplier/v1`, not this surface.
const endpoints = [
  { path: "/api/v1/invoices", expect: { owner: 200, am: 200, writer: 403, prospector: 403, outreach: 403, publisher: 403, client: 403 } },
  { path: "/api/v1/payments", expect: { owner: 200, am: 403, writer: 403, prospector: 403, outreach: 403, publisher: 403, client: 403 } },
  { path: "/api/v1/payouts", expect: { owner: 200, am: 403, writer: 403, prospector: 403, outreach: 403, publisher: 403, client: 403 } },
  { path: "/api/v1/expenses", expect: { owner: 200, am: 403, writer: 403, prospector: 403, outreach: 403, publisher: 403, client: 403 } },
  { path: "/api/v1/reports/campaigns", expect: { owner: 200, am: 403, writer: 403, prospector: 403, outreach: 403, publisher: 403, client: 403 } },
  { path: "/api/v1/reports/financial", expect: { owner: 200, am: 403, writer: 403, prospector: 403, outreach: 403, publisher: 403, client: 403 } },
  { path: "/api/v1/reports/ledger", expect: { owner: 200, am: 403, writer: 403, prospector: 403, outreach: 403, publisher: 403, client: 403 } },
  { path: "/api/v1/reports/database", expect: { owner: 200, am: 403, writer: 403, prospector: 403, outreach: 403, publisher: 403, client: 403 } },
  { path: "/api/v1/reports/ar-aging", expect: { owner: 200, am: 200, writer: 403, prospector: 403, outreach: 403, publisher: 403, client: 403 } },
  { path: "/api/v1/reports/publishers", expect: { owner: 200, am: 200, writer: 403, prospector: 200, outreach: 200, publisher: 403, client: 403 } },
  { path: "/api/v1/reports/placements", expect: { owner: 200, am: 200, writer: 200, prospector: 200, outreach: 200, publisher: 403, client: 403 } },
];

let failures = 0;
console.log("endpoint".padEnd(38) + Object.keys(roles).map((r) => r.padEnd(11)).join(""));
console.log("-".repeat(38 + 11 * 7));

for (const ep of endpoints) {
  const cells = [];
  for (const [role, token] of Object.entries(roles)) {
    const res = await fetch(`${API}${ep.path}`, { headers: { authorization: `Bearer ${token}` } });
    const want = ep.expect[role];
    const ok = res.status === want;
    if (!ok) failures += 1;
    cells.push(`${ok ? "" : "!!"}${res.status}`.padEnd(11));
  }
  console.log(ep.path.padEnd(38) + cells.join(""));
}

console.log("\nFinancial leak check: does any role's payload contain internal fields?");
const leakTerms = ["supplier_cost", "payout", "margin", "wholesale", "profit"];

for (const [role, token] of Object.entries(roles)) {
  for (const ep of endpoints) {
    if (ep.expect[role] !== 200) continue;
    const res = await fetch(`${API}${ep.path}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    const hit = leakTerms.filter((t) => new RegExp(t, "i").test(text));
    // These endpoints legitimately contain the words; the check is for roles that
    // must never see them.
    const forbiddenFor = ["client", "writer", "publisher"];
    if (forbiddenFor.includes(role) && hit.length > 0) {
      console.log(`   LEAK ${role} ${ep.path}: ${hit.join(",")}`);
      failures += 1;
    }
  }
}

console.log(failures === 0 ? "\nno authorization gaps found" : `\n${failures} gaps found`);
process.exit(failures === 0 ? 0 : 1);
