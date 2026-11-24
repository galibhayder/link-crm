/**
 * PHASE 5.1 — ROLE GUARD SEPARATION.
 *
 * Proves that the Account Manager can do their actual job (approve) and cannot do
 * things outside it, and that the client is confined to the portal. This is the
 * separation the review asked for, tested at the API layer where it is enforced.
 */
const API = process.env.API_URL ?? "http://127.0.0.1:3000";
const SUPABASE = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d: String(d) });
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

const login = async (email) => {
  const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const b = await r.json();
  if (!b.access_token) throw new Error(`login failed: ${email}`);
  return b.access_token;
};

const api = async (path, token, options = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
};

const T = {
  owner: await login("owner@demo.test"),
  am: await login("am@demo.test"),
  writer: await login("writer@demo.test"),
  client: await login("client@demo.test"),
};

const amPerms = await api("/api/v1/me/permissions", T.am);
const held = new Set(amPerms.body?.data?.permissions ?? []);

// ===========================================================================
console.log("\n1. the Account Manager's permission set is what the UI assumes");
// ===========================================================================
{
  check("account_manager holds placements:approve", held.has("placements:approve"));
  check("account_manager holds briefs:approve", held.has("briefs:approve"));
  check(
    "account_manager does NOT hold placements:write",
    !held.has("placements:write"),
    "this is why the approvals page uses client-decision, not /transition",
  );
  check("account_manager does NOT hold briefs:write", !held.has("briefs:write"));
  check("account_manager cannot read margins", !held.has("reports:margins") && !held.has("costs:read"));
}

// ===========================================================================
console.log("\n2. the AM can work the approval queues");
// ===========================================================================
{
  const placements = await api("/api/v1/placements?pipelineStage=pitched&limit=10", T.am);
  check("AM can read the placement approval queue", placements.status === 200, String(placements.status));

  const drafts = await api("/api/v1/content/drafts?status=in_review&limit=10", T.am);
  check("AM can read the draft approval queue", drafts.status === 200, String(drafts.status));

  const prospects = await api("/api/v1/prospects?priority=high&limit=10", T.am);
  check("AM can read the prospect queue", prospects.status === 200, String(prospects.status));

  const publishers = await api("/api/v1/publishers?status=active&limit=10", T.am);
  check("AM can read the publisher queue", publishers.status === 200, String(publishers.status));

  const notifications = await api("/api/v1/notifications", T.am);
  check("AM can read notifications (the bell)", notifications.status === 200, String(notifications.status));
}

// ===========================================================================
console.log("\n3. the AM can record a client decision but cannot drive the pipeline");
// ===========================================================================
{
  const campaigns = await api("/api/v1/campaigns?limit=1", T.owner);
  const campaignId = campaigns.body?.data?.[0]?.id;

  const p = await api("/api/v1/placements", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, targetUrl: `https://acme-saas.test/guard-${Date.now()}` }),
  });
  const pid = p.body?.data?.id;

  await api(`/api/v1/placements/${pid}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "pitched" }),
  });

  // The AM's job: record what the client decided. This endpoint needs
  // placements:approve, which they hold.
  const decision = await api(`/api/v1/placements/${pid}/client-decision`, T.am, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", note: "Client approved on a call" }),
  });
  check("AM CAN record a client decision", decision.status === 200, `${decision.status} ${JSON.stringify(decision.body?.error ?? "")}`);
  check("the decision moved the placement", decision.body?.data?.pipeline_stage === "client_approved", decision.body?.data?.pipeline_stage);

  // Not their job: moving the pipeline itself needs placements:write.
  const transition = await api(`/api/v1/placements/${pid}/transition`, T.am, {
    method: "POST",
    body: JSON.stringify({ toStage: "content_writing" }),
  });
  check("AM cannot drive the pipeline via /transition", transition.status === 403, String(transition.status));

  const createPlacement = await api("/api/v1/placements", T.am, {
    method: "POST",
    body: JSON.stringify({ campaignId, targetUrl: `https://acme-saas.test/am-${Date.now()}` }),
  });
  check("AM cannot create a placement", createPlacement.status === 403, String(createPlacement.status));

  const patchPlacement = await api(`/api/v1/placements/${pid}`, T.am, {
    method: "PATCH",
    body: JSON.stringify({ anchorText: "hijacked" }),
  });
  check("AM cannot edit a placement", patchPlacement.status === 403, String(patchPlacement.status));
}

// ===========================================================================
console.log("\n4. the AM can review content but cannot write it");
// ===========================================================================
{
  const staff = await api("/api/v1/staff?limit=50", T.owner);
  const writerId = (staff.body?.data ?? []).find((s) => s.email === "writer@demo.test")?.id;
  const campaigns = await api("/api/v1/campaigns?limit=1", T.owner);
  const campaignId = campaigns.body?.data?.[0]?.id;

  const p = await api("/api/v1/placements", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, targetUrl: `https://acme-saas.test/amcontent-${Date.now()}` }),
  });
  const pid = p.body?.data?.id;
  await api(`/api/v1/placements/${pid}/transition`, T.owner, { method: "POST", body: JSON.stringify({ toStage: "pitched" }) });
  await api(`/api/v1/placements/${pid}/client-decision`, T.owner, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", note: "ok" }),
  });
  const brief = await api("/api/v1/content/briefs", T.owner, {
    method: "POST",
    body: JSON.stringify({ placementId: pid, assignedTo: writerId, brief: "guard test" }),
  });
  const draft = await api("/api/v1/content/drafts", T.writer, {
    method: "POST",
    body: JSON.stringify({ briefId: brief.body?.data?.id, bodyMd: "text" }),
  });
  const did = draft.body?.data?.id;

  await api(`/api/v1/content/drafts/${did}/transition`, T.writer, {
    method: "POST",
    body: JSON.stringify({ status: "in_review" }),
  });

  const approve = await api(`/api/v1/content/drafts/${did}/transition`, T.am, {
    method: "POST",
    body: JSON.stringify({ status: "approved" }),
  });
  check("AM CAN approve a draft", approve.status === 200, `${approve.status} ${JSON.stringify(approve.body?.error ?? "")}`);

  const writeDraft = await api(`/api/v1/content/drafts/${did}/versions`, T.am, {
    method: "POST",
    body: JSON.stringify({ bodyMd: "am rewrite" }),
  });
  check("AM cannot write draft content", writeDraft.status === 403, String(writeDraft.status));
}

// ===========================================================================
console.log("\n5. the client is confined to the portal");
// ===========================================================================
{
  const portalPerms = await api("/portal/v1/me/permissions", T.client);
  check("client resolves on the portal", portalPerms.status === 200, String(portalPerms.status));
  check("client surface is portal", portalPerms.body?.data?.surface === "portal", portalPerms.body?.data?.surface);

  const clientPerms = new Set(portalPerms.body?.data?.permissions ?? []);
  check("client does NOT hold placements:write", !clientPerms.has("placements:write"));
  check("client does NOT hold briefs:write", !clientPerms.has("briefs:write"));
  check("client does NOT hold staff:read", !clientPerms.has("staff:read"));
  check("client does NOT hold reports:margins", !clientPerms.has("reports:margins"));

  // The approval queue is an internal route.
  const queue = await api("/api/v1/placements?pipelineStage=pitched", T.client);
  check("client cannot reach the approval queue", queue.status === 403, String(queue.status));

  // And the internal identity endpoint, which the web app calls for staff.
  const me = await api("/api/v1/me", T.client);
  check("client cannot reach /api/v1/me", me.status === 403, String(me.status));
}

// ===========================================================================
console.log("\n6. the writer cannot approve");
// ===========================================================================
{
  const writerPerms = await api("/api/v1/me/permissions", T.writer);
  const wHeld = new Set(writerPerms.body?.data?.permissions ?? []);
  check("content_writer does NOT hold briefs:approve", !wHeld.has("briefs:approve"));
  check("content_writer does NOT hold placements:approve", !wHeld.has("placements:approve"));

  const drafts = await api("/api/v1/content/drafts?limit=5", T.owner);
  const inReview = (drafts.body?.data ?? []).find((d) => d.status === "in_review" || d.status === "approved");

  if (inReview) {
    // Whatever its current state, a transition to approved must be refused.
    const attempt = await api(`/api/v1/content/drafts/${inReview.id}/transition`, T.writer, {
      method: "POST",
      body: JSON.stringify({ status: "approved" }),
    });
    check(
      "content_writer cannot approve a draft",
      attempt.status === 403 || attempt.status === 400,
      `${attempt.status} ${attempt.body?.error?.code ?? ""}`,
    );
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
