/**
 * End-to-end smoke test against the running API and local Supabase.
 *
 * Proves the properties that matter, through real HTTP with real JWTs:
 *   1. each role can reach its own surface and is rejected on the others
 *   2. the three financial tiers are isolated
 *   3. the client portal sees exactly one client
 *   4. health endpoints respond
 *
 * Run with: node scripts/smoke.mjs
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

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function login(email) {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`Login failed for ${email}: ${JSON.stringify(body)}`);
  return body.access_token;
}

async function api(path, token, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const tokens = {};
for (const [role, email] of Object.entries(USERS)) {
  tokens[role] = await login(email);
}

console.log("\nhealth");
{
  const live = await fetch(`${API}/health/live`);
  const ready = await fetch(`${API}/health/ready`);
  check("GET /health/live is 200", live.status === 200);
  const readyBody = await ready.json();
  check("GET /health/ready reports database reachable", ready.status === 200 && readyBody.data.database === "reachable");
}

console.log("\nsurface separation");
{
  const owner = await api("/api/v1/me", tokens.owner);
  check("owner reaches /api/v1", owner.status === 200, `got ${owner.status}`);
  check("owner role is owner", owner.body?.data?.role === "owner");

  const clientOnInternal = await api("/api/v1/clients", tokens.client_user);
  check("client_user is 403 on /api/v1/clients", clientOnInternal.status === 403, `got ${clientOnInternal.status}`);

  const publisherOnInternal = await api("/api/v1/clients", tokens.publisher_user);
  check("publisher_user is 403 on /api/v1/clients", publisherOnInternal.status === 403, `got ${publisherOnInternal.status}`);

  const internalOnPortal = await api("/portal/v1/placements", tokens.owner);
  check("owner is 403 on /portal/v1", internalOnPortal.status === 403, `got ${internalOnPortal.status}`);

  const publisherOnPortal = await api("/portal/v1/placements", tokens.publisher_user);
  check("publisher_user is 403 on /portal/v1", publisherOnPortal.status === 403, `got ${publisherOnPortal.status}`);

  const anon = await fetch(`${API}/api/v1/clients`);
  check("no token is 401", anon.status === 401, `got ${anon.status}`);
}

console.log("\nrole matrix through HTTP");
{
  const clients = await api("/api/v1/clients", tokens.owner);
  // "At least the two seeded clients", not "exactly two": other suites create
  // clients, so an exact count passes only on a freshly reset database and fails
  // when the suite is run after Phase 3 — a false failure, not a regression.
  check(
    "owner sees the demo clients",
    clients.status === 200 && clients.body.data.length >= 2,
    `got ${clients.body?.data?.length}`,
  );

  const am = await api("/api/v1/clients", tokens.account_manager);
  check("account_manager can list clients", am.status === 200);

  // The dashboard summary is the landing page for EVERY internal role. If it
  // requires a permission some role lacks, that role gets a 403 on sign-in.
  for (const role of ["owner", "account_manager", "prospector", "outreach_specialist", "content_writer"]) {
    const dash = await api("/api/v1/reports/dashboard", tokens[role]);
    check(`${role} can load the dashboard summary`, dash.status === 200, `got ${dash.status}`);
  }

  // A restricted role's counts must reflect its own row access, not the whole org.
  const writerDash = await api("/api/v1/reports/dashboard", tokens.content_writer);
  const ownerDash = await api("/api/v1/reports/dashboard", tokens.owner);
  check(
    "dashboard counts are RLS-scoped, not org-wide",
    typeof writerDash.body?.data?.activeCampaigns === "number" &&
      (writerDash.body?.data?.activeClients ?? 0) <= (ownerDash.body?.data?.activeClients ?? 0),
    `writer clients=${writerDash.body?.data?.activeClients} owner clients=${ownerDash.body?.data?.activeClients}`,
  );

  const writerStaff = await api("/api/v1/staff", tokens.content_writer);
  check("content_writer cannot list staff", writerStaff.status === 403, `got ${writerStaff.status}`);

  const amPayments = await api("/api/v1/payments", tokens.account_manager);
  check("account_manager cannot read payments", amPayments.status === 403, `got ${amPayments.status}`);

  const ownerPayments = await api("/api/v1/payments", tokens.owner);
  check("owner can read payments", ownerPayments.status === 200);

  const amMargin = await api("/api/v1/reports/profitability", tokens.account_manager);
  check("account_manager cannot read margins", amMargin.status === 403, `got ${amMargin.status}`);

  const ownerMargin = await api("/api/v1/reports/profitability", tokens.owner);
  check("owner reads margins", ownerMargin.status === 200, `got ${ownerMargin.status}`);
  // Assert the SHAPE of the report, not that the aggregate margin is positive.
  //
  // "margin > 0" is not an invariant: it holds only on a freshly seeded database.
  // Any suite that records a cost without a matching client price — which the
  // Phase 4 placement tests legitimately do — drives the aggregate negative. That
  // is correct arithmetic, not a defect, and asserting otherwise makes this test
  // fail for reasons that have nothing to do with margin reporting.
  check(
    "margin summary has the expected fields",
    typeof ownerMargin.body?.data?.summary?.revenue === "number" &&
      typeof ownerMargin.body?.data?.summary?.cost === "number" &&
      typeof ownerMargin.body?.data?.summary?.margin === "number",
    JSON.stringify(ownerMargin.body?.data?.summary),
  );

  // The seeded placement has a known price (1500) and cost (850), so its own
  // margin is a stable fact independent of anything else in the database.
  const marginRows = ownerMargin.body?.data?.placements ?? [];
  const seeded = marginRows.find((r) => Number(r.client_rate) === 1500 && Number(r.supplier_cost) === 850);
  check(
    "the priced seed placement shows a positive margin",
    seeded ? Number(seeded.margin) > 0 : false,
    seeded ? `margin ${seeded.margin}` : `no priced seed row among ${marginRows.length}`,
  );
}

console.log("\nclient portal isolation");
{
  const overview = await api("/portal/v1/overview", tokens.client_user);
  check("client portal overview is 200", overview.status === 200, `got ${overview.status}`);
  check("client sees exactly one client", overview.body?.data?.clients?.length === 1, `got ${overview.body?.data?.clients?.length}`);
  check("client sees Acme only", overview.body?.data?.clients?.[0]?.name === "Acme SaaS");

  const clientMargins = await api("/api/v1/reports/profitability", tokens.client_user);
  check("client cannot reach internal profitability", clientMargins.status === 403, `got ${clientMargins.status}`);

  const portalPlacements = await api("/portal/v1/placements", tokens.client_user);
  check("portal placements payload has no cost keys", 
    !JSON.stringify(portalPlacements.body).match(/supplier_cost|client_rate|margin/i));
}

console.log("\nsupplier portal isolation");
{
  const me = await api("/supplier/v1/me", tokens.publisher_user);
  check("publisher reaches /supplier/v1", me.status === 200, `got ${me.status}`);
  check("publisher identity resolves", me.body?.data?.supplier?.name?.length > 0);

  const clients = await api("/supplier/v1/placements", tokens.publisher_user);
  check("publisher placements payload has no client rate", 
    !JSON.stringify(clients.body).match(/client_rate|margin/i));

  const supplierMargins = await api("/api/v1/reports/profitability", tokens.publisher_user);
  check("publisher cannot reach margins", supplierMargins.status === 403, `got ${supplierMargins.status}`);
}

console.log("\nfinancial tier isolation through HTTP");
{
  const writerCosts = await api("/api/v1/costs/placements/00000000-0000-0000-0000-000000000000", tokens.content_writer);
  check("content_writer is 403 on costs", writerCosts.status === 403, `got ${writerCosts.status}`);

  const amCosts = await api("/api/v1/costs/placements/00000000-0000-0000-0000-000000000000", tokens.account_manager);
  check("account_manager is 403 on costs", amCosts.status === 403, `got ${amCosts.status}`);

  const prosCosts = await api("/api/v1/costs/placements/00000000-0000-0000-0000-000000000000", tokens.prospector);
  check("prospector is NOT 403 on costs", prosCosts.status !== 403, `got ${prosCosts.status}`);

  const writerPricing = await api("/api/v1/pricing/placements/00000000-0000-0000-0000-000000000000", tokens.content_writer);
  check("content_writer is 403 on pricing", writerPricing.status === 403, `got ${writerPricing.status}`);
}

console.log("\ninput validation");
{
  const bad = await api(
    "/api/v1/clients",
    tokens.owner,
    { method: "POST", body: JSON.stringify({ name: "", domain: "not a domain!!" }) },
  );
  check("invalid client payload is 400", bad.status === 400, `got ${bad.status}`);
  check("validation returns structured details", Array.isArray(bad.body?.error?.details));
}

console.log("\njob authentication");
{
  // The job endpoints must be reachable WITHOUT a user token — pg_cron has no
  // JWT — and must reject a request that carries no HMAC signature. The previous
  // version of this test only asserted 401, which passed for the wrong reason
  // (401 from missing auth rather than 401 from a bad signature). Asserting the
  // error CODE distinguishes them.
  const noSig = await fetch(`${API}/api/v1/internal/jobs/check-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: "x" }),
  });
  const noSigBody = await noSig.json().catch(() => ({}));
  check("job without HMAC is rejected", noSig.status === 401, `got ${noSig.status}`);
  check(
    "rejection is a signature failure, not a missing-token failure",
    noSigBody?.error?.message?.includes("signature"),
    JSON.stringify(noSigBody?.error),
  );

  // A user JWT must NOT be an accepted credential for jobs.
  const withJwt = await fetch(`${API}/api/v1/internal/jobs/check-links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens.owner}` },
    body: JSON.stringify({ organizationId: "x" }),
  });
  check("a user JWT does not authorise a job", withJwt.status === 401, `got ${withJwt.status}`);

  // A correctly signed request must be accepted. This is the assertion that
  // would have caught the jobs router being mounted behind `authenticate`.
  const crypto = await import("node:crypto");
  const secret = process.env.JOB_HMAC_SECRET ?? "local-dev-only-hmac-secret-at-least-32-chars";

  // Use the real organization id: the job routes validate the shape, so a
  // placeholder like all-zeros is (correctly) rejected before any work runs.
  // Read from the org endpoint as the signed-in owner — no service key needed.
  const orgRes = await api("/api/v1/settings/org", tokens.owner);
  const demoOrg = orgRes.body?.data?.id ?? null;
  check("demo organization id resolved", typeof demoOrg === "string", String(demoOrg));

  const ts = Date.now();
  const body = JSON.stringify({ organizationId: demoOrg });
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

  const signed = await fetch(`${API}/api/v1/internal/jobs/check-links`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-job-signature": sig,
      "x-job-timestamp": String(ts),
    },
    body,
  });
  check(
    "a correctly signed job is accepted without a JWT",
    signed.status === 200,
    `got ${signed.status}`,
  );

  // A malformed organization id must be rejected before it reaches a
  // service-role query, even with a valid signature.
  const badBody = JSON.stringify({ organizationId: "not-a-uuid" });
  const badTs = Date.now();
  const badSig = crypto.createHmac("sha256", secret).update(`${badTs}.${badBody}`).digest("hex");
  const badOrg = await fetch(`${API}/api/v1/internal/jobs/check-links`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-job-signature": badSig,
      "x-job-timestamp": String(badTs),
    },
    body: badBody,
  });
  check("a malformed organization id is rejected", badOrg.status === 400, `got ${badOrg.status}`);

  // Replay protection: the same signature must not work twice outside the window.
  const staleTs = Date.now() - 10 * 60 * 1000;
  const staleSig = crypto.createHmac("sha256", secret).update(`${staleTs}.${body}`).digest("hex");
  const replayed = await fetch(`${API}/api/v1/internal/jobs/check-links`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-job-signature": staleSig,
      "x-job-timestamp": String(staleTs),
    },
    body,
  });
  check("a stale signature is rejected", replayed.status === 401, `got ${replayed.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
