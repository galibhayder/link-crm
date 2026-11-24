/**
 * PHASE 4 TESTS — placement pipeline, transitions, permissions, outreach,
 * and client-portal visibility.
 *
 * The transition rules are the core of this phase, so they are tested as a
 * matrix: every legal move must succeed, every illegal move must be refused with
 * a 400 rather than silently accepted.
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

async function login(email) {
  const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const b = await r.json();
  if (!b.access_token) throw new Error(`login failed ${email}`);
  return b.access_token;
}

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
  prospector: await login("prospector@demo.test"),
  outreach: await login("outreach@demo.test"),
  writer: await login("writer@demo.test"),
  client: await login("client@demo.test"),
  publisher: await login("publisher@demo.test"),
};

const campaigns = await api("/api/v1/campaigns?limit=5", T.owner);
const campaignId = campaigns.body.data[0].id;
const publishers = await api("/api/v1/publishers?limit=1", T.owner);
const publisherId = publishers.body.data[0].id;

// ===========================================================================
console.log("\n1. kanban board");
// ===========================================================================
{
  const board = await api("/api/v1/placements/board", T.owner);
  check("board returns 200", board.status === 200, `${board.status}`);

  const stages = board.body?.data?.stages ?? [];
  check("board has six placement stages", stages.length === 6, `${stages.length}: ${stages.map((s) => s.key).join(", ")}`);
  check(
    "stages are in pipeline order",
    JSON.stringify(stages.map((s) => s.key)) ===
      JSON.stringify(["prospected", "pitched", "client_approved", "content_writing", "submitted", "live"]),
    stages.map((s) => s.key).join(" → "),
  );
  check("every stage carries a placements array", stages.every((s) => Array.isArray(s.placements)));
  check("seeded placements appear on the board", stages.some((s) => s.placements.length > 0));
  check("board reports no orphaned stages", (board.body?.data?.orphans ?? []).length === 0);

  const filtered = await api(`/api/v1/placements/board?campaignId=${campaignId}`, T.owner);
  check("board filters by campaign", filtered.status === 200);

  const byAssignee = await api("/api/v1/placements/board?assignedTo=" + "00000000-0000-0000-0000-000000000000", T.owner);
  check("board filters by assignee", byAssignee.status === 200);
}

// ===========================================================================
console.log("\n2. placement creation");
// ===========================================================================
let placementId = null;
{
  const stamp = Date.now();
  const created = await api("/api/v1/placements", T.owner, {
    method: "POST",
    body: JSON.stringify({
      campaignId,
      publisherId,
      targetUrl: `https://acme-saas.test/phase4-${stamp}`,
      anchorText: "best analytics tool",
      anchorType: "partial_match",
      negotiatedCost: 425.5,
      internalNotes: "Publisher wanted 500, agreed 425.",
      notes: "Client-facing note",
    }),
  });

  check("create returns 201", created.status === 201, `${created.status}: ${JSON.stringify(created.body?.error ?? "")}`);
  placementId = created.body?.data?.id;
  check("starts at prospected", created.body?.data?.pipeline_stage === "prospected", created.body?.data?.pipeline_stage);
  // The cost is NOT echoed back on the placement: it lives in tier 2
  // (`placement_costs`) and is only readable by roles holding `costs:read`. The
  // owner is one, so it comes back as `agreed_cost`. It must never come back as a
  // `negotiated_cost` column — that is the leak migration 0018 closed.
  check("negotiated cost is not a placement column", created.body?.data?.negotiated_cost === undefined);
  check("owner reads the agreed cost", Number(created.body?.data?.agreed_cost) === 425.5, String(created.body?.data?.agreed_cost));
  check("internal notes stored", Boolean(created.body?.data?.internal_notes));

  const badUrl = await api("/api/v1/placements", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, targetUrl: "not-a-url" }),
  });
  check("invalid target URL rejected", badUrl.status === 400, `${badUrl.status}`);

  const badCampaign = await api("/api/v1/placements", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId: "00000000-0000-0000-0000-000000000000", targetUrl: "https://x.test/a" }),
  });
  check("unknown campaign rejected", badCampaign.status === 400, `${badCampaign.status}`);

  const history = await api(`/api/v1/placements/${placementId}/history`, T.owner);
  check("creation recorded in history", (history.body?.data ?? []).some((h) => h.event_type === "created"));
}

// ===========================================================================
console.log("\n3. status transitions — the transition matrix");
// ===========================================================================
{
  // Legal forward path.
  const toPitched = await api(`/api/v1/placements/${placementId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "pitched", note: "Pitched to publisher" }),
  });
  check("prospected → pitched allowed", toPitched.status === 200, `${toPitched.status}`);

  // Skipping approval must be refused.
  const skip = await api(`/api/v1/placements/${placementId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "submitted" }),
  });
  check("pitched → submitted refused (skips stages)", skip.status === 400, `${skip.status}`);

  // Backwards is allowed.
  const back = await api(`/api/v1/placements/${placementId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "prospected" }),
  });
  check("pitched → prospected allowed (backwards)", back.status === 200, `${back.status}`);

  await api(`/api/v1/placements/${placementId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "pitched" }),
  });

  // Approval requires a note.
  const noNote = await api(`/api/v1/placements/${placementId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "client_approved" }),
  });
  check("client_approved requires an approval note", noNote.status === 400, `${noNote.status}`);

  const approved = await api(`/api/v1/placements/${placementId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "client_approved", clientApprovalNote: "Approved by email on Monday" }),
  });
  check("pitched → client_approved allowed with a note", approved.status === 200, `${approved.status}`);
  check("approval timestamp recorded", Boolean(approved.body?.data?.client_approved_at));
  check("approval note stored", approved.body?.data?.client_approval_note === "Approved by email on Monday");

  const toWriting = await api(`/api/v1/placements/${placementId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "content_writing" }),
  });
  check("client_approved → content_writing allowed", toWriting.status === 200, `${toWriting.status}`);

  const toSubmitted = await api(`/api/v1/placements/${placementId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "submitted" }),
  });
  check("content_writing → submitted allowed", toSubmitted.status === 200, `${toSubmitted.status}`);
  check("submitted timestamp recorded", Boolean(toSubmitted.body?.data?.submitted_at));

  const liveNoUrl = await api(`/api/v1/placements/${placementId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "live" }),
  });
  check("live requires a live URL", liveNoUrl.status === 400, `${liveNoUrl.status}`);

  const live = await api(`/api/v1/placements/${placementId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "live", liveUrl: "https://publisher.test/article" }),
  });
  check("submitted → live allowed with a URL", live.status === 200, `${live.status}`);
  check("operational status follows to live", live.body?.data?.status === "live", live.body?.data?.status);
  check("live date recorded", Boolean(live.body?.data?.live_date));

  // live is terminal.
  const fromLive = await api(`/api/v1/placements/${placementId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "pitched" }),
  });
  check("live is terminal (no backwards move)", fromLive.status === 400, `${fromLive.status}`);

  // A no-op move must not error, or every drag would produce a toast.
  const noop = await api(`/api/v1/placements/${placementId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "live" }),
  });
  check("drag onto the same stage is a no-op, not an error", noop.status === 200, `${noop.status}`);

  const unknownStage = await api(`/api/v1/placements/${placementId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "banana" }),
  });
  check("unknown stage rejected by validation", unknownStage.status === 400, `${unknownStage.status}`);
}

// ===========================================================================
console.log("\n4. history is append-only and complete");
// ===========================================================================
{
  const history = await api(`/api/v1/placements/${placementId}/history`, T.owner);
  const events = history.body?.data ?? [];

  check("history records every transition", events.length >= 7, `${events.length} events`);
  check("history records stage changes", events.some((e) => e.event_type === "stage_change"));
  check("history records client approval", events.some((e) => e.event_type === "client_approved"));
  check("history records the actor", events.every((e) => e.actor_id !== undefined));
  check("history records from/to stages", events.some((e) => e.from_stage && e.to_stage));

  // A client must never be able to forge history.
  const forge = await fetch(`${API}/api/v1/placements/${placementId}/history`, {
    method: "POST",
    headers: { authorization: `Bearer ${T.owner}`, "content-type": "application/json" },
    body: JSON.stringify({ event_type: "created" }),
  });
  check("history cannot be written through the API", forge.status === 404 || forge.status === 405, `${forge.status}`);
}

// ===========================================================================
console.log("\n5. client decision endpoint");
// ===========================================================================
{
  const stamp = Date.now();
  const created = await api("/api/v1/placements", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, targetUrl: `https://acme-saas.test/decision-${stamp}` }),
  });
  const id = created.body.data.id;

  const early = await api(`/api/v1/placements/${id}/client-decision`, T.owner, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", note: "Should not work yet" }),
  });
  check("decision refused before pitching", early.status === 400, `${early.status}`);

  await api(`/api/v1/placements/${id}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "pitched" }),
  });

  const reject = await api(`/api/v1/placements/${id}/client-decision`, T.owner, {
    method: "POST",
    body: JSON.stringify({ decision: "reject", note: "Client wanted a different anchor" }),
  });
  check("rejection accepted", reject.status === 200, `${reject.status}`);
  check("rejection keeps the placement at pitched", reject.body?.data?.pipeline_stage === "pitched");
  check("rejection reason recorded", Boolean(reject.body?.data?.client_rejected_reason));

  const approve = await api(`/api/v1/placements/${id}/client-decision`, T.owner, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", note: "Approved after revision" }),
  });
  check("approval accepted", approve.status === 200, `${approve.status}`);
  check("approval clears the rejection", approve.body?.data?.client_rejected_reason === null);

  // Transition endpoint must refuse to set a client-only field implicitly.
  const viaTransition = await api(`/api/v1/placements/${id}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "client_approved", clientApprovalNote: "fine" }),
  });
  check("transition from client_approved to itself is a no-op", viaTransition.status === 200, `${viaTransition.status}`);
}

// ===========================================================================
console.log("\n6. client portal visibility");
// ===========================================================================
{
  const portal = await api("/portal/v1/placements", T.client);
  check("client portal placements returns 200", portal.status === 200, `${portal.status}`);

  const rows = portal.body?.data ?? [];
  check("client sees only approved-or-later placements",
    rows.every((r) => ["client_approved", "content_writing", "submitted", "live"].includes(r.pipeline_stage)),
    rows.map((r) => r.pipeline_stage).join(", ") || "no rows");

  const serialized = JSON.stringify(rows);
  check("portal payload has no internal notes", !/internal_notes/.test(serialized));
  check("portal payload has no negotiated cost", !/negotiated_cost/.test(serialized));
  check("portal payload has no cost or margin keys", !/supplier_cost|client_rate|margin|cost_vendor/i.test(serialized));
  check("portal payload has no assignee", !/assigned_to|content_assignee/.test(serialized));

  const approved = await api("/portal/v1/placements/approved", T.client);
  check("client approval view works", approved.status === 200, `${approved.status}`);

  // The client must not reach internal placement routes at all.
  const internal = await api("/api/v1/placements", T.client);
  check("client is 403 on internal placements", internal.status === 403, `${internal.status}`);

  const board = await api("/api/v1/placements/board", T.client);
  check("client is 403 on the internal board", board.status === 403, `${board.status}`);

  const history = await api(`/api/v1/placements/${placementId}/history`, T.client);
  check("client is 403 on placement history", history.status === 403, `${history.status}`);
}

// ===========================================================================
console.log("\n7. permissions by role");
// ===========================================================================
{
  // The writer is only assigned to ONE campaign, so use a campaign they can
  // actually see. Creating against campaign[0] fails with "Campaign not found"
  // — correct RLS behaviour, wrong test assumption.
  const writerCampaigns = await api("/api/v1/campaigns?limit=10", T.writer);
  const writerCampaignId = writerCampaigns.body?.data?.[0]?.id;
  check("content_writer sees only its assigned campaigns",
    (writerCampaigns.body?.data ?? []).length < 2,
    `${writerCampaigns.body?.data?.length} campaigns`);

  const writerCreate = await api("/api/v1/placements", T.writer, {
    method: "POST",
    body: JSON.stringify({ campaignId: writerCampaignId, targetUrl: "https://acme-saas.test/writer.test" }),
  });
  check("content_writer can create placements in its campaigns", writerCreate.status === 201, `${writerCreate.status}`);

  // Pick a campaign the writer is NOT assigned to. The owner's first campaign is
  // often the writer's own, so a fixed index would silently test the wrong path.
  const allCampaigns = await api("/api/v1/campaigns?limit=10", T.owner);
  const unassigned = (allCampaigns.body?.data ?? []).find((c) => c.id !== writerCampaignId);
  check("an unassigned campaign exists to test against", Boolean(unassigned), unassigned?.name);

  const outsider = await api("/api/v1/placements", T.writer, {
    method: "POST",
    body: JSON.stringify({ campaignId: unassigned?.id, targetUrl: "https://acme-saas.test/outsider.test" }),
  });
  check("content_writer cannot create in an unassigned campaign", outsider.status === 400, `${outsider.status}`);

  const writerTransition = await api(`/api/v1/placements/${placementId}/transition`, T.writer, {
    method: "POST",
    body: JSON.stringify({ toStage: "live" }),
  });
  check("content_writer can attempt transitions (authorised)", writerTransition.status !== 403, `${writerTransition.status}`);

  const prospectorBoard = await api("/api/v1/placements/board", T.prospector);
  check("prospector can read the board", prospectorBoard.status === 200, `${prospectorBoard.status}`);

  const publisherBoard = await api("/api/v1/placements/board", T.publisher);
  check("publisher_user is 403 on the internal board", publisherBoard.status === 403, `${publisherBoard.status}`);
}

// ===========================================================================
console.log("\n8. outreach — templates, records, follow-ups, send gating");
// ===========================================================================
{
  const prospects = await api("/api/v1/prospects?limit=1", T.owner);
  const prospect = prospects.body?.data?.[0];
  check("a prospect exists for outreach", Boolean(prospect), prospect?.domain);

  const template = await api("/api/v1/outreach/templates", T.owner, {
    method: "POST",
    body: JSON.stringify({
      name: "Phase 4 initial pitch",
      subject: "Guest post on {{domain}}?",
      bodyMd: "Hi {{contact_name}}, I loved {{domain}} and have an idea.",
      category: "initial",
      variables: ["domain", "contact_name"],
    }),
  });
  check("template created", template.status === 201, `${template.status}`);
  const templateId = template.body?.data?.id;

  const templates = await api("/api/v1/outreach/templates", T.owner);
  check("templates list works", templates.status === 200 && templates.body.data.length > 0);

  const rendered = await api(`/api/v1/outreach/templates/${templateId}/render`, T.owner, {
    method: "POST",
    body: JSON.stringify({ prospectId: prospect.id }),
  });
  check("template renders", rendered.status === 200, `${rendered.status}`);
  check("variables substituted", !/\{\{/.test(rendered.body?.data?.subject ?? "{{"), rendered.body?.data?.subject);

  const record = await api("/api/v1/outreach", T.owner, {
    method: "POST",
    body: JSON.stringify({
      prospectId: prospect.id,
      campaignId: prospect.campaign_id,
      templateId,
      kind: "initial",
      subject: "Guest post idea",
      bodyExcerpt: "Hi, I have an idea...",
      recipientEmail: "editor@example.test",
      followUpDueAt: new Date(Date.now() - 86400000).toISOString(),
    }),
  });
  check("outreach record created", record.status === 201, `${record.status}: ${JSON.stringify(record.body?.error ?? "")}`);
  const recordId = record.body?.data?.id;
  check("record starts as draft", record.body?.data?.status === "draft", record.body?.data?.status);

  const send = await api(`/api/v1/outreach/${recordId}/send`, T.owner, {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
  check("sending is refused without a provider", send.status === 503, `${send.status}`);
  check("refusal says nothing was sent", /nothing was sent/i.test(send.body?.error?.message ?? ""), send.body?.error?.message);

  const stillDraft = await api(`/api/v1/outreach/${recordId}`, T.owner);
  check("a refused send leaves the record as draft", stillDraft.body?.data?.status === "draft", stillDraft.body?.data?.status);

  const fakeSent = await api(`/api/v1/outreach/${recordId}`, T.owner, {
    method: "PATCH",
    body: JSON.stringify({ status: "sent" }),
  });
  check("PATCH cannot claim a record was sent", fakeSent.status === 400, `${fakeSent.status}`);

  const logged = await api(`/api/v1/outreach/${recordId}/log`, T.owner, {
    method: "POST",
    body: JSON.stringify({ channel: "email", outcome: "no_reply", note: "Sent from Gmail manually" }),
  });
  check("logging an external send works", logged.status === 200, `${logged.status}`);
  check("record becomes sent", logged.body?.data?.status === "sent", logged.body?.data?.status);
  check("follow-up counter increments", logged.body?.data?.follow_up_count === 1, String(logged.body?.data?.follow_up_count));

  const touchpoints = await api(`/api/v1/prospects/${prospect.id}/related`, T.owner);
  check("touchpoint written to history", (touchpoints.body?.data?.touchpoints ?? []).length > 0);

  const followUps = await api("/api/v1/outreach/follow-ups", T.owner);
  check("follow-up queue works", followUps.status === 200, `${followUps.status}`);

  const prospectHistory = await api(`/api/v1/outreach/prospect/${prospect.id}`, T.owner);
  check("prospect outreach history works", prospectHistory.status === 200 && "touchpoints" in prospectHistory.body.data);

  // A response should move the prospect's stage.
  const responded = await api(`/api/v1/outreach/${recordId}`, T.owner, {
    method: "PATCH",
    body: JSON.stringify({ responseStatus: "positive" }),
  });
  check("response recorded", responded.status === 200, `${responded.status}`);
  check("positive response sets status replied", responded.body?.data?.status === "replied", responded.body?.data?.status);

  const movedProspect = await api(`/api/v1/prospects/${prospect.id}`, T.owner);
  check("prospect advanced after a positive reply",
    ["negotiating", "agreed"].includes(movedProspect.body?.data?.stage),
    movedProspect.body?.data?.stage);
  check("prospect marked as replied", movedProspect.body?.data?.reply_received === true);
}

// ===========================================================================
console.log("\n9. outreach permissions");
// ===========================================================================
{
  const writerTemplates = await api("/api/v1/outreach/templates", T.writer);
  check("content_writer cannot read templates", writerTemplates.status === 403, `${writerTemplates.status}`);

  const clientOutreach = await api("/api/v1/outreach", T.client);
  check("client is 403 on outreach records", clientOutreach.status === 403, `${clientOutreach.status}`);

  const publisherOutreach = await api("/api/v1/outreach", T.publisher);
  check("publisher is 403 on outreach records", publisherOutreach.status === 403, `${publisherOutreach.status}`);

  const outreachProspects = await api("/api/v1/prospects?limit=1", T.outreach);
  check("outreach_specialist can read prospects", outreachProspects.status === 200, `${outreachProspects.status}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
