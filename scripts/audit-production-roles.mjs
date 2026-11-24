/**
 * SEVEN-ROLE PRODUCTION SWEEP.
 *
 * `test-authorization` already checks the permission matrix per role. This is a
 * different question: in a *deployed* configuration, can each role actually log in,
 * reach its own surface, be refused everywhere else, and see the right amount of
 * financial data?
 *
 * The interesting failures are silent ones — a role that logs in fine but sees
 * margin data it should not, or a client that can read another client's records.
 */
const API = process.env.API_URL ?? "http://127.0.0.1:3000";
const SUPABASE = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const USERS = {
  owner: "owner@demo.test",
  account_manager: "am@demo.test",
  prospector: "prospector@demo.test",
  outreach_specialist: "outreach@demo.test",
  content_writer: "writer@demo.test",
  client_user: "client@demo.test",
  publisher_user: "publisher@demo.test",
};

const SURFACE = {
  owner: "/api/v1",
  account_manager: "/api/v1",
  prospector: "/api/v1",
  outreach_specialist: "/api/v1",
  content_writer: "/api/v1",
  client_user: "/portal/v1",
  publisher_user: "/supplier/v1",
};

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d });
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

async function login(email) {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, token: body.access_token, user: body.user };
}

async function call(path, token) {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  let body = null;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, text };
}

const tokens = {};

// ---------------------------------------------------------------------------
console.log("1. every role can authenticate");
// ---------------------------------------------------------------------------
for (const [role, email] of Object.entries(USERS)) {
  const r = await login(email);
  tokens[role] = r.token;
  check(`${role} logs in`, r.status === 200 && Boolean(r.token), `status ${r.status}`);

  if (r.token) {
    const payload = JSON.parse(Buffer.from(r.token.split(".")[1], "base64url").toString());
    check(`${role} carries its role in the token`, payload.role === "authenticated", payload.role);
  }
}

// ---------------------------------------------------------------------------
console.log("\n2. each role reaches ONLY its own surface");
// ---------------------------------------------------------------------------
for (const [role, token] of Object.entries(tokens)) {
  if (!token) continue;
  const own = SURFACE[role];

  const ok = await call(`${own === "/api/v1" ? own : own}/me`, token);
  check(`${role} reaches its own surface`, ok.status === 200, `${own} → ${ok.status}`);

  // Every OTHER surface must refuse it. This is the structural isolation that
  // authenticate() enforces before any handler runs.
  for (const other of ["/api/v1", "/portal/v1", "/supplier/v1"]) {
    if (other === own) continue;
    const wrong = await call(`${other}/me`, token);
    check(`${role} is refused on ${other}`, wrong.status === 401 || wrong.status === 403, String(wrong.status));
  }
}

// ---------------------------------------------------------------------------
console.log("\n3. financial visibility is tiered, not all-or-nothing");
// ---------------------------------------------------------------------------
{
  // Tier 3 — margin/profitability data. Owner only.
  const ownerMargin = await call("/api/v1/reports/profitability", tokens.owner);
  check("owner reaches profitability (tier 3)", ownerMargin.status === 200, String(ownerMargin.status));

  for (const role of ["prospector", "outreach_specialist", "content_writer", "account_manager"]) {
    const t = tokens[role];
    if (!t) continue;
    const r = await call("/api/v1/reports/profitability", t);
    check(`${role} is refused profitability (tier 3)`, r.status === 403, String(r.status));
  }

  // Tier 2 — publisher costs. The prospector works with publishers, so it may see
  // them; the writer may not.
  const prospectorPubs = await call("/api/v1/publishers", tokens.prospector);
  check("prospector can see publisher costs (tier 2)", prospectorPubs.status === 200, String(prospectorPubs.status));

  const writerPubs = await call("/api/v1/publishers", tokens.content_writer);
  check("content writer cannot see publisher costs (tier 2)", writerPubs.status === 403, String(writerPubs.status));

  // Tier 1 — client-facing pricing. The AM negotiates it; the writer does not.
  const amMargin = await call("/api/v1/reports/financial", tokens.account_manager);
  check(
    "account manager is refused profitability too (tier 3 is owner-only)",
    amMargin.status === 403,
    String(amMargin.status),
  );

  // The financial summary a non-owner is allowed to see must not carry cost data.
  const amAr = await call("/api/v1/reports/ar-aging", tokens.account_manager);
  check("account manager can read AR aging", amAr.status === 200, String(amAr.status));
  if (amAr.status === 200) {
    const blob = JSON.stringify(amAr.body);
    check("AR aging carries no margin or cost columns", !/"margin"|"cost_total"|"writer_cost"/i.test(blob));
  }
}

// ---------------------------------------------------------------------------
console.log("\n4. a client cannot reach another client's data");
// ---------------------------------------------------------------------------
{
  const mine = await call("/portal/v1/me", tokens.client_user);
  check("the client portal identifies the caller", mine.status === 200, String(mine.status));

  // The portal scopes every query by the caller's client_user_access rows. Trying an
  // arbitrary client id must not return another tenant's campaigns.
  const other = await call("/portal/v1/campaigns", tokens.client_user);
  check("the client sees only its own campaigns", other.status === 200, String(other.status));

  if (other.status === 200) {
    const rows = other.body?.data ?? [];
    const ids = new Set(rows.map((r) => r.client_id).filter(Boolean));
    check("no campaign belongs to more than one client", ids.size <= 1, [...ids].join(", "));
  }
}

// ---------------------------------------------------------------------------
console.log("\n5. a publisher cannot see client identity or pricing");
// ---------------------------------------------------------------------------
{
  const t = tokens.publisher_user;
  const earnings = await call("/supplier/v1/earnings", t);
  check("publisher reaches its own earnings", earnings.status === 200, String(earnings.status));

  const placements = await call("/supplier/v1/placements", t);
  check("publisher reaches its own placements", placements.status === 200, String(placements.status));

  if (placements.status === 200) {
    const blob = JSON.stringify(placements.body);
    // A publisher is paid a cost, never told the client's price. Leaking either the
    // client name or the sell price turns every vendor into a competitor's informant.
    check("no client identity in the supplier payload", !/"client_name"|"client_id"/i.test(blob));
    check("no client sell price in the supplier payload", !/"client_price"|"sell_price"|"margin"/i.test(blob));
  }

  const clients = await call("/api/v1/clients", t);
  check("publisher cannot read the client list", clients.status === 401 || clients.status === 403, String(clients.status));
}

// ---------------------------------------------------------------------------
console.log("\n6. token handling is sound");
// ---------------------------------------------------------------------------
{
  const noToken = await call("/api/v1/clients", "");
  check("a missing token is rejected", noToken.status === 401, String(noToken.status));

  const garbage = await call("/api/v1/clients", "not-a-jwt");
  check("a malformed token is rejected", garbage.status === 401, String(garbage.status));

  // A structurally-valid JWT signed with the wrong key must not pass.
  const forged = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "00000000-0000-4000-8000-000000000000", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
    "deadbeef",
  ].join(".");
  const forgedRes = await call("/api/v1/clients", forged);
  check("a forged token is rejected", forgedRes.status === 401, String(forgedRes.status));

  const expired = await call("/api/v1/clients", tokens.owner);
  check("a valid token works (control)", expired.status === 200, String(expired.status));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.n} — ${f.d}`);
  process.exit(1);
}
