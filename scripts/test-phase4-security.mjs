/**
 * PHASE 4 SECURITY REGRESSIONS.
 *
 * Each check here corresponds to a defect found during the Phase 4 review. They
 * are kept separate from the feature tests so a future change that reintroduces
 * one of these holes fails loudly with a name that says what it broke.
 */
const API = process.env.API_URL ?? "http://127.0.0.1:3000";
const SUPABASE = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d });
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

const owner = await login("owner@demo.test");
const am = await login("am@demo.test");
const writer = await login("writer@demo.test");
const outreach = await login("outreach@demo.test");

const camps = await api("/api/v1/campaigns?limit=1", owner);
const campaignId = camps.body.data[0].id;

// ===========================================================================
console.log("\n1. wholesale cost stays in tier 2");
// ===========================================================================
{
  const created = await api("/api/v1/placements", owner, {
    method: "POST",
    body: JSON.stringify({
      campaignId,
      targetUrl: `https://tier-probe-${Date.now()}.test`,
      negotiatedCost: 975,
    }),
  });
  const id = created.body?.data?.id;
  check("owner can record a negotiated cost", created.status === 201, String(created.status));

  const ownerDetail = await api(`/api/v1/placements/${id}`, owner);
  check("owner reads the agreed cost", Number(ownerDetail.body?.data?.agreed_cost) === 975, String(ownerDetail.body?.data?.agreed_cost));

  // The regression: this used to return 975 to both of these roles.
  const amList = await api("/api/v1/placements?limit=200", am);
  const amRow = (amList.body?.data ?? []).find((p) => p.id === id);
  check("account_manager list has no cost", amRow?.agreed_cost === undefined, JSON.stringify(amRow?.agreed_cost));

  const amDetail = await api(`/api/v1/placements/${id}`, am);
  check("account_manager detail has no cost", amDetail.body?.data?.agreed_cost === undefined);

  const amBoard = await api("/api/v1/placements/board", am);
  const onBoard = (amBoard.body?.data?.stages ?? []).flatMap((s) => s.placements).find((p) => p.id === id);
  check("account_manager board has no cost", onBoard?.agreed_cost === undefined);

  const wDetail = await api(`/api/v1/placements/${id}`, writer);
  check("content_writer cannot read the cost", wDetail.body?.data?.agreed_cost === undefined);

  // A raw column named negotiated_cost must not exist anywhere in the payload.
  check("no negotiated_cost field is serialised at all", !/negotiated_cost/.test(amList.text));
  check("no supplier_cost leaks into the placement payload", !/supplier_cost/.test(amList.text));

  // Writing it is a tier-2 privilege.
  const wWrite = await api(`/api/v1/placements/${id}`, writer, {
    method: "PATCH",
    body: JSON.stringify({ negotiatedCost: 1 }),
  });
  check("content_writer cannot write the cost", wWrite.status === 403, String(wWrite.status));

  const wCreate = await api("/api/v1/placements", writer, {
    method: "POST",
    body: JSON.stringify({ campaignId, targetUrl: `https://w-${Date.now()}.test`, negotiatedCost: 50 }),
  });
  check("content_writer cannot set a cost at creation", wCreate.status === 403, String(wCreate.status));

  const amWrite = await api(`/api/v1/placements/${id}`, am, {
    method: "PATCH",
    body: JSON.stringify({ negotiatedCost: 2 }),
  });
  check("account_manager cannot write the cost", amWrite.status === 403, String(amWrite.status));

  const outRead = await api(`/api/v1/placements/${id}`, outreach);
  check("outreach_specialist can read the cost (tier 2 holder)", Number(outRead.body?.data?.agreed_cost) === 975);
}

// ===========================================================================
console.log("\n2. a placement cannot be created past the start of the pipeline");
// ===========================================================================
{
  for (const stage of ["live", "submitted", "content_writing", "client_approved"]) {
    const res = await api("/api/v1/placements", owner, {
      method: "POST",
      body: JSON.stringify({ campaignId, targetUrl: `https://skip-${stage}-${Date.now()}.test`, pipelineStage: stage }),
    });
    check(`cannot create at ${stage}`, res.status === 400, String(res.status));
  }

  const ok = await api("/api/v1/placements", owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, targetUrl: `https://start-ok-${Date.now()}.test` }),
  });
  check("can still create at prospected", ok.status === 201 && ok.body.data.pipeline_stage === "prospected");
}

// ===========================================================================
console.log("\n3. a live placement must have a URL");
// ===========================================================================
{
  const created = await api("/api/v1/placements", owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, targetUrl: `https://live-url-${Date.now()}.test` }),
  });
  const id = created.body.data.id;
  await api(`/api/v1/placements/${id}/transition`, owner, { method: "POST", body: JSON.stringify({ toStage: "pitched" }) });
  await api(`/api/v1/placements/${id}/client-decision`, owner, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", note: "Approved for the URL test" }),
  });
  await api(`/api/v1/placements/${id}/transition`, owner, { method: "POST", body: JSON.stringify({ toStage: "content_writing" }) });
  await api(`/api/v1/placements/${id}/transition`, owner, { method: "POST", body: JSON.stringify({ toStage: "submitted" }) });

  const noUrl = await api(`/api/v1/placements/${id}/transition`, owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "live" }),
  });
  check("submitted → live is refused without a URL", noUrl.status === 400, String(noUrl.status));

  const withUrl = await api(`/api/v1/placements/${id}/transition`, owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "live", liveUrl: "https://publisher.test/live-url-test" }),
  });
  check("submitted → live succeeds with a URL", withUrl.status === 200, String(withUrl.status));
  check("live row carries the URL", Boolean(withUrl.body?.data?.live_url));
}

// ===========================================================================
console.log("\n4. granting a client approval needs placements:approve");
// ===========================================================================
{
  const created = await api("/api/v1/placements", owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, targetUrl: `https://approve-${Date.now()}.test` }),
  });
  const id = created.body.data.id;
  await api(`/api/v1/placements/${id}/transition`, owner, { method: "POST", body: JSON.stringify({ toStage: "pitched" }) });

  const writerDecision = await api(`/api/v1/placements/${id}/client-decision`, writer, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", note: "A writer should not be able to do this" }),
  });
  check("content_writer cannot record a client decision", writerDecision.status === 403, String(writerDecision.status));

  const writerTransition = await api(`/api/v1/placements/${id}/transition`, writer, {
    method: "POST",
    body: JSON.stringify({ toStage: "client_approved", clientApprovalNote: "smuggled approval" }),
  });
  check("content_writer cannot reach client_approved by transition", writerTransition.status === 403, String(writerTransition.status));

  // The regression this fixes: account_manager holds approve but not write, so
  // gating on write locked them out of their own role.
  const amDecision = await api(`/api/v1/placements/${id}/client-decision`, am, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", note: "Client approved on a call" }),
  });
  check("account_manager CAN record a client decision", amDecision.status === 200, String(amDecision.status));
  check("approval is attributed to the caller", Boolean(amDecision.body?.data?.client_approved_at));
}

// ===========================================================================
console.log("\n5. transition errors name only reachable stages");
// ===========================================================================
{
  const created = await api("/api/v1/placements", owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, targetUrl: `https://msg-${Date.now()}.test` }),
  });
  const id = created.body.data.id;
  const res = await api(`/api/v1/placements/${id}/transition`, owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "live" }),
  });
  const message = res.body?.error?.message ?? "";
  check("error mentions the reachable stage", /pitched/.test(message), message);
  check("error does not enumerate the whole pipeline as if all were allowed", !/live,/.test(message), message);
  check("error carries structured detail", Array.isArray(res.body?.error?.details?.allowed), JSON.stringify(res.body?.error?.details));
}

// ===========================================================================
console.log("\n6. history and audit still record what happened");
// ===========================================================================
{
  const created = await api("/api/v1/placements", owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, targetUrl: `https://hist-${Date.now()}.test`, negotiatedCost: 300 }),
  });
  const id = created.body.data.id;

  await api(`/api/v1/placements/${id}`, owner, { method: "PATCH", body: JSON.stringify({ negotiatedCost: 350 }) });

  const history = await api(`/api/v1/placements/${id}/history`, owner);
  const events = history.body?.data ?? [];
  check("creation is recorded", events.some((e) => e.event_type === "created"));
  check("a cost change is recorded", events.some((e) => e.event_type === "cost_agreed"));

  const costEvent = events.find((e) => e.event_type === "cost_agreed");
  check("cost history has from/to", costEvent?.detail?.from === 300 && costEvent?.detail?.to === 350,
    JSON.stringify(costEvent?.detail));

  const audit = await api("/api/v1/audit?limit=50", owner);
  check("audit log records the placement update", (audit.body?.data ?? []).some((a) => a.entity_type === "placement"));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
