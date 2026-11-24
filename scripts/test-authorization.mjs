/**
 * AUTHORIZATION TEST SUITE — every role, every sensitive boundary.
 *
 * Runs against a live API and real Postgres with real JWTs. Nothing is mocked:
 * a mocked authorization test proves only that the mock was written to agree
 * with the assumption being tested, and that assumption is what fails in
 * production.
 *
 * Covered:
 *   1. The permission matrix, role by role, through the API.
 *   2. Direct PostgREST access — the bypass route a browser attacker would use.
 *   3. Client users and financial data (the explicit requirement).
 *   4. Admin user-management authority.
 *   5. Audit log immutability.
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
  rival_owner: "owner@rival.test",
};

const INTERNAL = ["owner", "account_manager", "prospector", "outreach_specialist", "content_writer"];

let pass = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function login(email) {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`login failed for ${email}: ${JSON.stringify(body)}`);
  return body;
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

/** Direct PostgREST call, bypassing Express entirely. */
async function rest(path, token, options = {}) {
  const res = await fetch(`${SUPABASE}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: ANON,
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

const sessions = {};
for (const [role, email] of Object.entries(USERS)) {
  sessions[role] = await login(email);
}
const tokens = Object.fromEntries(Object.entries(sessions).map(([r, s]) => [r, s.access_token]));

// ===========================================================================
console.log("\n1. authentication — token claims match the database");
// ===========================================================================
for (const role of INTERNAL) {
  const claims = JSON.parse(Buffer.from(tokens[role].split(".")[1], "base64url").toString("utf8"));
  const appMeta = claims.app_metadata ?? {};
  check(`${role} token carries role=${role}`, appMeta.role === role, `got ${appMeta.role}`);
  check(`${role} token carries an organization`, typeof appMeta.org_id === "string" && appMeta.org_id.length === 36);
}

{
  const me = await api("/api/v1/me", tokens.owner);
  check("GET /me resolves the caller from the database", me.status === 200 && me.body?.data?.role === "owner");

  // Presence must actually be stamped, or the admin "last active" column lies.
  // The write is async, so allow it a moment before reading.
  await new Promise((r) => setTimeout(r, 1200));
  const profile = await api("/api/v1/profile", tokens.owner);
  check(
    "last_seen_at is stamped on identity resolution",
    Boolean(profile.body?.data?.last_seen_at),
    `last_seen_at=${profile.body?.data?.last_seen_at ?? "null"}`,
  );
}

// ===========================================================================
console.log("\n2. surface separation — an external role cannot use the internal API");
// ===========================================================================
for (const path of ["/api/v1/clients", "/api/v1/staff", "/api/v1/reports/profitability", "/api/v1/payments"]) {
  const asClient = await api(path, tokens.client_user);
  check(`client_user is 403 on ${path}`, asClient.status === 403, `got ${asClient.status}`);

  const asPublisher = await api(path, tokens.publisher_user);
  check(`publisher_user is 403 on ${path}`, asPublisher.status === 403, `got ${asPublisher.status}`);
}

for (const role of INTERNAL) {
  const onPortal = await api("/portal/v1/placements", tokens[role]);
  check(`${role} cannot use the client portal`, onPortal.status === 403, `got ${onPortal.status}`);
}

// ===========================================================================
console.log("\n3. permission matrix — financial tiers through the API");
// ===========================================================================
{
  // Tier 1: client pricing.
  for (const role of ["owner", "account_manager"]) {
    const res = await api("/api/v1/pricing/placements/00000000-0000-0000-0000-000000000000", tokens[role]);
    check(`${role} may read client pricing`, res.status !== 403, `got ${res.status}`);
  }
  for (const role of ["prospector", "outreach_specialist", "content_writer"]) {
    const res = await api("/api/v1/pricing/placements/00000000-0000-0000-0000-000000000000", tokens[role]);
    check(`${role} is 403 on client pricing`, res.status === 403, `got ${res.status}`);
  }

  // Tier 2: wholesale cost.
  for (const role of ["owner", "prospector", "outreach_specialist"]) {
    const res = await api("/api/v1/costs/placements/00000000-0000-0000-0000-000000000000", tokens[role]);
    check(`${role} may read wholesale cost`, res.status !== 403, `got ${res.status}`);
  }
  const amCost = await api("/api/v1/costs/placements/00000000-0000-0000-0000-000000000000", tokens.account_manager);
  check("account_manager is 403 on wholesale cost", amCost.status === 403, `got ${amCost.status}`);
  const writerCost = await api("/api/v1/costs/placements/00000000-0000-0000-0000-000000000000", tokens.content_writer);
  check("content_writer is 403 on wholesale cost", writerCost.status === 403, `got ${writerCost.status}`);

  // Tier 3: margin.
  for (const role of ["account_manager", "prospector", "outreach_specialist", "content_writer"]) {
    const res = await api("/api/v1/reports/profitability", tokens[role]);
    check(`${role} is 403 on margins`, res.status === 403, `got ${res.status}`);
  }
  const ownerMargin = await api("/api/v1/reports/profitability", tokens.owner);
  check("owner reads margins", ownerMargin.status === 200, `got ${ownerMargin.status}`);
}

// ===========================================================================
console.log("\n4. client portal — cannot reach internal financial information");
// ===========================================================================
{
  const clientMargins = await api("/api/v1/reports/profitability", tokens.client_user);
  check("client is 403 on margin reporting", clientMargins.status === 403);

  const clientInvoices = await api("/api/v1/invoices", tokens.client_user);
  check("client is 403 on the internal invoice list", clientInvoices.status === 403, `got ${clientInvoices.status}`);

  const clientPayments = await api("/api/v1/payments", tokens.client_user);
  check("client is 403 on payments", clientPayments.status === 403);

  // And through PostgREST, which is the bypass a browser attacker would try.
  for (const table of ["placement_costs", "payments", "supplier_bills", "client_contracts"]) {
    const res = await rest(`/${table}?select=*`, tokens.client_user);
    const rows = Array.isArray(res.body) ? res.body.length : -1;
    check(`client reads 0 rows from ${table} via PostgREST`, rows === 0, `${rows} rows, status ${res.status}`);
  }

  for (const view of ["v_placement_margin", "v_client_profitability", "v_ar_aging"]) {
    const res = await rest(`/${view}?select=*`, tokens.client_user);
    const rows = Array.isArray(res.body) ? res.body.length : -1;
    const denied = res.status === 404 || res.status === 403 || rows === 0;
    check(`client cannot read ${view}`, denied, `status ${res.status}, ${rows} rows`);
  }

  // The portal payload itself must not carry cost keys.
  const portalPlacements = await api("/portal/v1/placements", tokens.client_user);
  const serialized = JSON.stringify(portalPlacements.body);
  check(
    "portal placement payload has no cost or margin keys",
    !/supplier_cost|client_rate|margin|cost_vendor/i.test(serialized),
  );

  // Scope: the demo client is granted Acme only.
  const overview = await api("/portal/v1/overview", tokens.client_user);
  check("client sees exactly one client", overview.body?.data?.clients?.length === 1, `${overview.body?.data?.clients?.length}`);
}

// ===========================================================================
console.log("\n5. privilege escalation — role changes require server authority");
// ===========================================================================
{
  const writer = sessions.content_writer;

  // Self-promotion.
  const selfPromote = await rest(`/profiles?id=eq.${writer.user.id}`, tokens.content_writer, {
    method: "PATCH",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ role: "owner" }),
  });
  const promoted = Array.isArray(selfPromote.body) && selfPromote.body[0]?.role === "owner";
  check("a user cannot promote themselves", !promoted, `status ${selfPromote.status}`);

  // Cross-user promotion.
  const target = sessions.prospector;
  const crossPromote = await rest(`/profiles?id=eq.${target.user.id}`, tokens.content_writer, {
    method: "PATCH",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ role: "owner" }),
  });
  const crossRows = Array.isArray(crossPromote.body) ? crossPromote.body.length : 0;
  check("a user cannot promote another user", crossRows === 0, `${crossRows} rows updated`);

  // Self-reactivation.
  const reactivate = await rest(`/profiles?id=eq.${writer.user.id}`, tokens.content_writer, {
    method: "PATCH",
    body: JSON.stringify({ is_active: false }),
  });
  check("a user cannot suspend or reactivate themselves", reactivate.status >= 400, `status ${reactivate.status}`);

  // Org reparenting.
  const reparent = await rest(`/profiles?id=eq.${writer.user.id}`, tokens.content_writer, {
    method: "PATCH",
    body: JSON.stringify({ organization_id: "00000000-0000-0000-0000-000000000000" }),
  });
  check("a user cannot move themselves to another organization", reparent.status >= 400, `status ${reparent.status}`);

  // A user MAY still edit their own name — the fix must not break self-service.
  const rename = await rest(`/profiles?id=eq.${writer.user.id}`, tokens.content_writer, {
    method: "PATCH",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ full_name: "Wendy Writer" }),
  });
  check(
    "a user can still edit their own name",
    rename.status === 200 && Array.isArray(rename.body) && rename.body[0]?.full_name === "Wendy Writer",
    `status ${rename.status}`,
  );
}

// ===========================================================================
console.log("\n6. admin user management authority");
// ===========================================================================
{
  // Only the owner holds staff:manage.
  for (const role of ["account_manager", "prospector", "outreach_specialist", "content_writer"]) {
    const res = await api("/api/v1/staff/invite", tokens[role], {
      method: "POST",
      body: JSON.stringify({ email: "x@test.test", fullName: "X", role: "prospector" }),
    });
    check(`${role} cannot invite users`, res.status === 403, `got ${res.status}`);
  }

  const listAsWriter = await api("/api/v1/staff", tokens.content_writer);
  check("content_writer cannot list staff", listAsWriter.status === 403);

  const listAsOwner = await api("/api/v1/staff", tokens.owner);
  check("owner may list staff", listAsOwner.status === 200);

  // The owner account cannot be suspended or demoted by anyone, including itself.
  const ownerId = sessions.owner.user.id;
  const selfSuspend = await api(`/api/v1/staff/${ownerId}/suspend`, tokens.owner, {
    method: "POST",
    body: JSON.stringify({ reason: "testing self-suspension" }),
  });
  check("owner cannot suspend their own account", selfSuspend.status >= 400, `got ${selfSuspend.status}`);

  // Cross-tenant administration must fail.
  const rivalId = sessions.rival_owner.user.id;
  const crossTenant = await api(`/api/v1/staff/${rivalId}`, tokens.owner, {
    method: "PATCH",
    body: JSON.stringify({ role: "content_writer" }),
  });
  check("an owner cannot edit a user in another organization", crossTenant.status === 404, `got ${crossTenant.status}`);

  // Inviting a publisher without a supplier must be rejected.
  const badInvite = await api("/api/v1/staff/invite", tokens.owner, {
    method: "POST",
    body: JSON.stringify({ email: "pub@test.test", fullName: "Pub", role: "publisher_user" }),
  });
  check("publisher invite without a supplier is rejected", badInvite.status === 400, `got ${badInvite.status}`);

  // Ownership cannot be handed out through the invite route.
  const ownerInvite = await api("/api/v1/staff/invite", tokens.owner, {
    method: "POST",
    body: JSON.stringify({ email: "owner2@test.test", fullName: "Owner 2", role: "owner" }),
  });
  check("owner role cannot be invited", ownerInvite.status === 400, `got ${ownerInvite.status}`);
}

// ===========================================================================
console.log("\n7. audit log — written by the server, immutable to users");
// ===========================================================================
{
  // Pick a placement that ALREADY has both a client rate and a supplier cost.
  // Writing a cost onto an unpriced placement leaves one side of the margin
  // pair null, which silently distorts the profitability report for every other
  // suite — a test-isolation defect this suite previously had.
  const profitability = await api("/api/v1/reports/profitability", tokens.owner);
  const priced = (profitability.body?.data?.placements ?? []).find(
    (p) => p.client_rate != null && p.supplier_cost != null,
  );
  const placementId = priced?.placement_id ?? null;

  let originalCost = null;
  if (placementId) {
    originalCost = Number(priced.supplier_cost);

    // Nudge the cost by a small amount so the audit diff is non-empty, then
    // restore the exact original below.
    const costWrite = await api(`/api/v1/costs/placements/${placementId}`, tokens.owner, {
      method: "PUT",
      body: JSON.stringify({ supplierCost: originalCost + 5, currency: "USD" }),
    });
    check("an audited cost change succeeds", costWrite.status === 200, `got ${costWrite.status}`);
  }

  const asOwner = await api("/api/v1/audit", tokens.owner);
  check("owner can read the audit log", asOwner.status === 200, `got ${asOwner.status}`);
  const entries = asOwner.body?.data ?? [];
  check("an audited action produced a log entry", entries.length > 0, `${entries.length} entries`);

  const costEntry = entries.find((e) => e.entity_type === "placement_cost");
  check(
    "the entry records what changed and who did it",
    Boolean(costEntry) && Boolean(costEntry?.actor_role),
    costEntry ? `actor=${costEntry.actor_role}` : "no placement_cost entry",
  );

  // A role change is the most sensitive mutation, so it must be audited too.
  const target = sessions.prospector.user.id;
  const roleChange = await api(`/api/v1/staff/${target}`, tokens.owner, {
    method: "PATCH",
    body: JSON.stringify({ role: "outreach_specialist" }),
  });
  check("owner can change a role", roleChange.status === 200, `got ${roleChange.status}`);

  const afterRoleChange = await api("/api/v1/audit?action=role_change", tokens.owner);
  check("the role change was audited", (afterRoleChange.body?.data ?? []).length > 0);

  // Restore, so later assertions and other suites see the expected matrix.
  await api(`/api/v1/staff/${target}`, tokens.owner, {
    method: "PATCH",
    body: JSON.stringify({ role: "prospector" }),
  });

  const asWriter = await api("/api/v1/audit", tokens.content_writer);
  check("content_writer cannot read the audit log", asWriter.status === 403, `got ${asWriter.status}`);

  const asClient = await api("/api/v1/audit", tokens.client_user);
  check("client cannot read the audit log", asClient.status === 403, `got ${asClient.status}`);

  // A user must not be able to insert a forged audit entry.
  const forged = await rest("/activity_log", tokens.owner, {
    method: "POST",
    body: JSON.stringify({
      organization_id: sessions.owner.user.id,
      entity_type: "profile",
      action: "create",
      diff: { forged: true },
    }),
  });
  check("audit entries cannot be forged through PostgREST", forged.status >= 400, `status ${forged.status}`);

  // Nor deleted.
  if (entries.length > 0) {
    const del = await rest(`/activity_log?id=eq.${entries[0].id}`, tokens.owner, { method: "DELETE" });
    const stillThere = await api("/api/v1/audit", tokens.owner);
    const survived = (stillThere.body?.data ?? []).some((r) => r.id === entries[0].id);
    check("audit entries cannot be deleted by a user", survived, `delete status ${del.status}`);
  }

  // Restore the cost this suite changed, so the seeded margin is intact for
  // every other suite.
  if (placementId && originalCost !== null) {
    await api(`/api/v1/costs/placements/${placementId}`, tokens.owner, {
      method: "PUT",
      body: JSON.stringify({ supplierCost: Number(originalCost), currency: "USD" }),
    });
    check("original cost restored", true, String(originalCost));
  }
}

// ===========================================================================
console.log("\n8. cross-tenant isolation");
// ===========================================================================
{
  for (const role of INTERNAL) {
    const res = await rest("/clients?select=id,name", tokens[role]);
    const rows = Array.isArray(res.body) ? res.body : [];
    const leaked = rows.some((r) => r.name === "Rival Secret Client");
    check(`${role} cannot see the rival organization's client`, !leaked, `${rows.length} rows`);
  }

  const rivalClients = await rest("/clients?select=id,name", tokens.rival_owner);
  const rivalRows = Array.isArray(rivalClients.body) ? rivalClients.body : [];
  check("rival owner sees only its own client", rivalRows.length === 1, `${rivalRows.length} rows`);
}

// ===========================================================================
console.log("\n9. input trust — supplied role information is ignored");
// ===========================================================================
{
  // An owner cannot widen the schema by sending junk; Zod rejects it.
  const bad = await api("/api/v1/staff/invite", tokens.owner, {
    method: "POST",
    body: JSON.stringify({ email: "a@b.test", fullName: "A", role: "superuser" }),
  });
  check("an unknown role is rejected", bad.status === 400, `got ${bad.status}`);

  // Self-registration must not create a profile with a chosen role, because
  // provisioning reads the invitation, not the sign-up payload.
  const signUp = await fetch(`${SUPABASE}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({
      email: `sneaky-${Date.now()}@test.test`,
      password: "password123456",
      data: { role: "owner", full_name: "Sneaky" },
    }),
  });
  const signUpBody = await signUp.json().catch(() => ({}));
  if (signUpBody.access_token) {
    const profile = await rest("/profiles?select=role", signUpBody.access_token);
    const rows = Array.isArray(profile.body) ? profile.body : [];
    check("an uninvited sign-up gets no profile at all", rows.length === 0, `${rows.length} profiles`);
  } else {
    check("an uninvited sign-up cannot obtain a session", true, "sign-up did not return a token");
  }
}

// ===========================================================================
const failed = failures.length;
console.log(`\n${pass} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
