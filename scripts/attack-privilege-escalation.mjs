/**
 * Proof-of-concept: can a low-privileged user escalate their own role by calling
 * PostgREST directly, bypassing the Express API entirely?
 *
 * Runs against the CURRENT schema. Expected to FAIL the security assertion
 * before the fix and pass after it.
 */

const SUPABASE = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const results = [];
const check = (n, ok, d = "") => {
  results.push(ok);
  console.log(`${ok ? "  ✓ SAFE  " : "  ✗ VULNERABLE"} ${n}${d ? ` — ${d}` : ""}`);
};

async function login(email) {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`login failed: ${JSON.stringify(body)}`);
  return body;
}

function authed(token) {
  return { apikey: ANON, authorization: `Bearer ${token}`, "content-type": "application/json" };
}

// --- Attack 1: a content writer promotes themselves to owner -----------------
console.log("\nattack 1 — self-promotion to owner");
{
  const session = await login("writer@demo.test");
  const headers = authed(session.access_token);

  const res = await fetch(`${SUPABASE}/rest/v1/profiles?id=eq.${session.user.id}`, {
    method: "PATCH",
    headers: { ...headers, prefer: "return=representation" },
    body: JSON.stringify({ role: "owner" }),
  });
  const body = await res.json().catch(() => null);

  const escalated = Array.isArray(body) && body[0]?.role === "owner";

  // Refresh the token so the Custom Access Token Hook re-stamps app_metadata.
  let newRoleClaim = null;
  if (escalated) {
    const refreshed = await fetch(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: ANON, "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    const refreshedBody = await refreshed.json();
    if (refreshedBody.access_token) {
      const payload = JSON.parse(
        Buffer.from(refreshedBody.access_token.split(".")[1], "base64url").toString("utf8"),
      );
      newRoleClaim = payload.app_metadata?.role ?? null;
    }
  }

  check(
    "content_writer cannot set their own role",
    !escalated,
    escalated ? `role is now ${body[0].role}, token claim became ${newRoleClaim}` : `status ${res.status}`,
  );
  check(
    "refreshed token does not carry an escalated role",
    newRoleClaim !== "owner",
    `claim: ${newRoleClaim}`,
  );
}

// --- Attack 2: reactivate a suspended account --------------------------------
console.log("\nattack 2 — unsuspend self");
{
  // Use a writer still active, then try to flip is_active on themselves.
  const session = await login("outreach@demo.test");
  const headers = authed(session.access_token);

  const res = await fetch(`${SUPABASE}/rest/v1/profiles?id=eq.${session.user.id}`, {
    method: "PATCH",
    headers: { ...headers, prefer: "return=representation" },
    body: JSON.stringify({ is_active: true, role: "account_manager" }),
  });
  const body = await res.json().catch(() => null);
  const changed = Array.isArray(body) && body[0]?.role === "account_manager";

  check("outreach_specialist cannot change their own role", !changed, `status ${res.status}`);
}

// --- Attack 3: read another user's profile ----------------------------------
console.log("\nattack 3 — cross-user profile write");
{
  const writer = await login("writer@demo.test");
  const target = await login("prospector@demo.test");

  const res = await fetch(`${SUPABASE}/rest/v1/profiles?id=eq.${target.user.id}`, {
    method: "PATCH",
    headers: { ...authed(writer.access_token), prefer: "return=representation" },
    body: JSON.stringify({ role: "owner" }),
  });
  const body = await res.json().catch(() => null);
  const changedRows = Array.isArray(body) ? body.length : 0;

  check("a user cannot modify another user's row", changedRows === 0, `${changedRows} rows updated`);
}

// --- Attack 4: read the payment ledger -------------------------------------
console.log("\nattack 4 — client reads financial data directly");
{
  const client = await login("client@demo.test");
  const res = await fetch(`${SUPABASE}/rest/v1/payments?select=*`, {
    headers: authed(client.access_token),
  });
  const body = await res.json().catch(() => []);
  const rows = Array.isArray(body) ? body.length : -1;
  check("client_user reads zero payment rows via PostgREST", rows === 0, `${rows} rows`);

  const costs = await fetch(`${SUPABASE}/rest/v1/placement_costs?select=*`, {
    headers: authed(client.access_token),
  });
  const costBody = await costs.json().catch(() => []);
  const costRows = Array.isArray(costBody) ? costBody.length : -1;
  check("client_user reads zero wholesale costs via PostgREST", costRows === 0, `${costRows} rows`);

  const pricing = await fetch(`${SUPABASE}/rest/v1/placement_pricing?select=*`, {
    headers: authed(client.access_token),
  });
  const pricingBody = await pricing.json().catch(() => []);
  const pricingRows = Array.isArray(pricingBody) ? pricingBody.length : -1;
  check(
    "client_user only reads pricing for their OWN placements",
    pricingRows <= 1,
    `${pricingRows} rows`,
  );
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} safe, ${failed} vulnerabilities`);
if (failed > 0) process.exit(1);
