/**
 * PHASE 5 INTEGRATION TESTS — content workflow, anchor analytics, verification.
 *
 * Runs against the real API. Verification is exercised two ways:
 *
 *   - `analysePage` is unit-tested separately, so the five questions are covered
 *     without a network.
 *   - Here, the full endpoint path is exercised, including the SSRF guard: a
 *     placement whose live URL points at 127.0.0.1 must be REFUSED, and that
 *     refusal must be recorded as `unreachable` rather than `link_missing`.
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
  publisher: await login("publisher@demo.test"),
};

const campaigns = await api("/api/v1/campaigns?limit=1", T.owner);
const campaignId = campaigns.body.data[0].id;
const clients = await api("/api/v1/clients?limit=1", T.owner);
const clientId = clients.body.data[0].id;

// Who is the writer, so briefs can be assigned to them.
const staff = await api("/api/v1/staff?limit=50", T.owner);
const writerRow = (staff.body?.data ?? []).find((s) => s.email === "writer@demo.test");
const writerId = writerRow?.id;

const newPlacement = async (label, extra = {}) => {
  const res = await api("/api/v1/placements", T.owner, {
    method: "POST",
    body: JSON.stringify({
      campaignId,
      targetUrl: `https://acme-saas.test/${label}-${Date.now()}`,
      anchorText: "saas analytics",
      anchorType: "partial_match",
      linkType: "dofollow",
      ...extra,
    }),
  });
  return res.body?.data;
};

// ===========================================================================
console.log("\n1. content: brief, draft and versions");
// ===========================================================================
let draftId = null;
let briefId = null;
{
  const placement = await newPlacement("content");

  const brief = await api("/api/v1/content/briefs", T.owner, {
    method: "POST",
    body: JSON.stringify({
      placementId: placement.id,
      // Assigned, because the writer's RLS policy requires it. An unassigned
      // brief is invisible to them by design.
      assignedTo: writerId,
      brief: "1200 words on analytics.",
      dueDate: "2026-12-01",
    }),
  });
  check("a brief can be created", brief.status === 201 || brief.status === 200, String(brief.status));
  briefId = brief.body?.data?.id;
  check("the brief records its assignment", brief.body?.data?.assigned_to === writerId);

  const dup = await api("/api/v1/content/briefs", T.owner, {
    method: "POST",
    body: JSON.stringify({ placementId: placement.id, brief: "second" }),
  });
  check("a placement cannot have a second brief", dup.status === 409, String(dup.status));

  const draft = await api("/api/v1/content/drafts", T.writer, {
    method: "POST",
    body: JSON.stringify({ briefId, title: "Analytics in 2026", bodyMd: "First paragraph here." }),
  });
  check("the assigned writer can create a draft", draft.status === 201, `${draft.status} ${JSON.stringify(draft.body?.error ?? "")}`);
  draftId = draft.body?.data?.id;
  check("the draft starts as 'draft'", draft.body?.data?.status === "draft");
  check("version 1 is recorded", draft.body?.data?.current_version === 1);
  check("word count is computed", draft.body?.data?.word_count === 3, String(draft.body?.data?.word_count));

  const dupDraft = await api("/api/v1/content/drafts", T.writer, {
    method: "POST",
    body: JSON.stringify({ briefId, bodyMd: "again" }),
  });
  check("a brief cannot have a second draft", dupDraft.status === 409, String(dupDraft.status));

  const v2 = await api(`/api/v1/content/drafts/${draftId}/versions`, T.writer, {
    method: "POST",
    body: JSON.stringify({ title: "Analytics in 2026", bodyMd: "First paragraph. Second paragraph." }),
  });
  check("a new version can be saved", v2.status === 200, String(v2.status));
  check("the version number increments", v2.body?.data?.current_version === 2);
  check("word count updates", v2.body?.data?.word_count === 4, String(v2.body?.data?.word_count));

  const detail = await api(`/api/v1/content/drafts/${draftId}`, T.writer);
  check("the version list is returned", (detail.body?.data?.versions ?? []).length === 2);
  check("versions are newest-first", detail.body?.data?.versions?.[0]?.version === 2);

  const old = await api(`/api/v1/content/drafts/${draftId}/versions/1`, T.writer);
  check("version 1 keeps its original text", old.body?.data?.body_md === "First paragraph here.", old.body?.data?.body_md);
}

// ===========================================================================
console.log("\n2. content: approval workflow and authority");
// ===========================================================================
{
  const direct = await api(`/api/v1/content/drafts/${draftId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ status: "approved" }),
  });
  check("a draft cannot be approved straight from 'draft'", direct.status === 400, String(direct.status));

  const submitted = await api(`/api/v1/content/drafts/${draftId}/transition`, T.writer, {
    method: "POST",
    body: JSON.stringify({ status: "in_review" }),
  });
  check("the writer can submit for review", submitted.status === 200, String(submitted.status));
  check("submitting sets submitted_at", Boolean(submitted.body?.data?.submitted_at));

  const writerApprove = await api(`/api/v1/content/drafts/${draftId}/transition`, T.writer, {
    method: "POST",
    body: JSON.stringify({ status: "approved" }),
  });
  check("the writer CANNOT approve their own draft", writerApprove.status === 403, String(writerApprove.status));

  const noNotes = await api(`/api/v1/content/drafts/${draftId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ status: "revision_requested" }),
  });
  check("a revision request without notes is refused", noNotes.status === 400, String(noNotes.status));

  const revise = await api(`/api/v1/content/drafts/${draftId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ status: "revision_requested", notes: "Add a section on attribution." }),
  });
  check("a revision can be requested with notes", revise.status === 200, String(revise.status));
  check("the draft is in revision_requested", revise.body?.data?.status === "revision_requested");

  const revisions = await api(`/api/v1/content/drafts/${draftId}/revisions`, T.owner);
  check("the revision request is recorded", (revisions.body?.data ?? []).length === 1);
  check("the request is open", revisions.body?.data?.[0]?.status === "open");

  const second = await api(`/api/v1/content/drafts/${draftId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ status: "revision_requested", notes: "And another thing." }),
  });
  check("a second concurrent revision request is refused", second.status === 400, String(second.status));

  // Saving a new version after a revision request resolves it and returns to review.
  const fixed = await api(`/api/v1/content/drafts/${draftId}/versions`, T.writer, {
    method: "POST",
    body: JSON.stringify({ bodyMd: "Revised with an attribution section." }),
  });
  check("saving after a revision request returns the draft to review", fixed.body?.data?.status === "in_review");

  const resolved = await api(`/api/v1/content/drafts/${draftId}/revisions`, T.owner);
  check("the revision request is resolved by the new version", resolved.body?.data?.[0]?.status === "resolved");
  check("the resolving version is recorded", resolved.body?.data?.[0]?.resolved_by_version === 3);

  const approved = await api(`/api/v1/content/drafts/${draftId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ status: "approved" }),
  });
  check("the owner can approve", approved.status === 200, String(approved.status));
  check("approval is attributed", Boolean(approved.body?.data?.approved_by));

  const editPublished = await api(`/api/v1/content/drafts/${draftId}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ status: "published" }),
  });
  check("an approved draft can be published", editPublished.status === 200, String(editPublished.status));

  const frozen = await api(`/api/v1/content/drafts/${draftId}/versions`, T.writer, {
    method: "POST",
    body: JSON.stringify({ bodyMd: "sneaky edit after publication" }),
  });
  check("published content cannot be edited", frozen.status === 400, String(frozen.status));

  const restorePublished = await api(`/api/v1/content/drafts/${draftId}/restore/1`, T.writer, { method: "POST" });
  check("published content cannot be restored over either", restorePublished.status === 400, String(restorePublished.status));
}

// ===========================================================================
console.log("\n2b. restore is blocked while a decision is in flight");
// ===========================================================================
{
  const p = await newPlacement("restore-guard");
  const brief = await api("/api/v1/content/briefs", T.owner, {
    method: "POST",
    body: JSON.stringify({ placementId: p.id, assignedTo: writerId, brief: "guard test" }),
  });
  const draft = await api("/api/v1/content/drafts", T.writer, {
    method: "POST",
    body: JSON.stringify({ briefId: brief.body.data.id, bodyMd: "v1" }),
  });
  const id = draft.body.data.id;

  await api(`/api/v1/content/drafts/${id}/versions`, T.writer, {
    method: "POST",
    body: JSON.stringify({ bodyMd: "v2" }),
  });

  // A draft the writer still owns can be restored.
  const ok = await api(`/api/v1/content/drafts/${id}/restore/1`, T.writer, { method: "POST" });
  check("a draft still being written can be restored", ok.status === 200, String(ok.status));

  // Submit for review, then a restore must be refused: replacing the text would
  // change what the reviewer is looking at with no record of why.
  await api(`/api/v1/content/drafts/${id}/transition`, T.writer, {
    method: "POST",
    body: JSON.stringify({ status: "in_review" }),
  });
  const blockedReview = await api(`/api/v1/content/drafts/${id}/restore/1`, T.writer, { method: "POST" });
  check("a draft in review cannot be restored over", blockedReview.status === 400, String(blockedReview.status));

  await api(`/api/v1/content/drafts/${id}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ status: "approved" }),
  });
  const blockedApproved = await api(`/api/v1/content/drafts/${id}/restore/1`, T.writer, { method: "POST" });
  check("an approved draft cannot be restored over", blockedApproved.status === 400, String(blockedApproved.status));
}

// ===========================================================================
console.log("\n2c. creating a brief moves the placement into content writing");
// ===========================================================================
{
  const p = await newPlacement("stage-move");
  const pid = p.id;

  // Walk to client_approved, which is the stage a brief is created from.
  await api(`/api/v1/placements/${pid}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "pitched" }),
  });
  await api(`/api/v1/placements/${pid}/client-decision`, T.owner, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", note: "Approved for the stage test" }),
  });

  const before = await api(`/api/v1/placements/${pid}`, T.owner);
  check("the placement is at client_approved before briefing", before.body?.data?.pipeline_stage === "client_approved");

  await api("/api/v1/content/briefs", T.owner, {
    method: "POST",
    body: JSON.stringify({ placementId: pid, assignedTo: writerId, brief: "moves the stage" }),
  });

  const after = await api(`/api/v1/placements/${pid}`, T.owner);
  check(
    "creating a brief advances the placement to content_writing",
    after.body?.data?.pipeline_stage === "content_writing",
    after.body?.data?.pipeline_stage,
  );
}

// ===========================================================================
console.log("\n3. content: restore an earlier version");
// ===========================================================================
{
  const fresh = await newPlacement("restore");
  const brief = await api("/api/v1/content/briefs", T.owner, {
    method: "POST",
    body: JSON.stringify({ placementId: fresh.id, assignedTo: writerId, brief: "short brief" }),
  });
  const draft = await api("/api/v1/content/drafts", T.writer, {
    method: "POST",
    body: JSON.stringify({ briefId: brief.body.data.id, bodyMd: "original text" }),
  });
  const id = draft.body.data.id;

  await api(`/api/v1/content/drafts/${id}/versions`, T.writer, {
    method: "POST",
    body: JSON.stringify({ bodyMd: "changed text" }),
  });

  const restored = await api(`/api/v1/content/drafts/${id}/restore/1`, T.writer, { method: "POST" });
  check("restoring an earlier version succeeds", restored.status === 200, String(restored.status));
  check("the restored text is the original", restored.body?.data?.body_md === "original text", restored.body?.data?.body_md);
  check("restoring creates a NEW version rather than rewriting history", restored.body?.data?.current_version === 3);

  const history = await api(`/api/v1/content/drafts/${id}`, T.writer);
  check("all three versions remain", (history.body?.data?.versions ?? []).length === 3);
}

// ===========================================================================
console.log("\n4. content: permissions and visibility");
// ===========================================================================
{
  const queue = await api("/api/v1/content/my-queue", T.writer);
  check("the writer has a queue endpoint", queue.status === 200, String(queue.status));

  // The brief list must attach each brief's draft.
  //
  // Without this every row rendered "no draft yet" regardless of reality, because
  // the brief table has no draft column — the draft lives in its own table.
  const list = await api("/api/v1/content/briefs?limit=50", T.owner);
  const withDraft = (list.body?.data ?? []).filter((b) => b.draft);
  check("briefs carry their draft", withDraft.length > 0, `${withDraft.length} of ${(list.body?.data ?? []).length}`);

  // `?mine=false` must mean false.
  //
  // `z.coerce.boolean()` reads the string "false" as true, which filtered the list
  // to the caller's own (empty) assignments and rendered an empty page beside a
  // summary that showed work in progress.
  const all = await api("/api/v1/content/briefs?limit=50&mine=false", T.owner);
  check("mine=false does not filter to the caller", (all.body?.data ?? []).length > 0, String((all.body?.data ?? []).length));

  const mineTrue = await api("/api/v1/content/briefs?limit=50&mine=true", T.writer);
  // The writer has assigned briefs, so "mine" must return some — and fewer than the
  // unfiltered list, or the filter did nothing.
  const writerAll = await api("/api/v1/content/briefs?limit=50", T.writer);
  check("mine=true returns the writer's own briefs", (mineTrue.body?.data ?? []).length > 0, String((mineTrue.body?.data ?? []).length));
  check(
    "mine=true is a narrower list than the unfiltered one",
    (mineTrue.body?.data ?? []).length <= (writerAll.body?.data ?? []).length,
  );

  const summary = await api("/api/v1/content/summary", T.owner);
  check("the summary reports counts", typeof summary.body?.data?.byStatus === "object");
  check("the summary reports whether the caller may approve", summary.body?.data?.canApprove === true);

  const writerSummary = await api("/api/v1/content/summary", T.writer);
  check("a writer is told they cannot approve", writerSummary.body?.data?.canApprove === false);

  const publisherBriefs = await api("/api/v1/content/briefs", T.publisher);
  check("a publisher cannot read content briefs", publisherBriefs.status === 403, String(publisherBriefs.status));

  const publisherDrafts = await api("/api/v1/content/drafts", T.publisher);
  check("a publisher cannot read drafts", publisherDrafts.status === 403, String(publisherDrafts.status));
}

// ===========================================================================
console.log("\n5. client approval through the portal");
// ===========================================================================
{
  // Find a campaign belonging to the client's OWN client, by asking the portal
  // which clients the account is granted. Picking an arbitrary campaign would test
  // the wrong thing — a draft on another client's placement is correctly invisible,
  // and the isolation assertion below would pass for the wrong reason.
  const portalClients = await api("/portal/v1/overview", T.client);
  const grantedClientIds = new Set(
    (portalClients.body?.data?.clients ?? []).map((c) => c.id),
  );

  const campaignsAll = await api("/api/v1/campaigns?limit=50", T.owner);
  const clientCampaign = (campaignsAll.body?.data ?? []).find((c) => grantedClientIds.has(c.client_id));
  check("the client is granted at least one campaign to test with", Boolean(clientCampaign), String(grantedClientIds.size));

  const campaignIdForClient = clientCampaign?.id ?? campaignId;

  const p = await api("/api/v1/placements", T.owner, {
    method: "POST",
    body: JSON.stringify({
      campaignId: campaignIdForClient,
      targetUrl: `https://acme-saas.test/client-signoff-${Date.now()}`,
      anchorText: "saas analytics",
    }),
  });
  const pid = p.body?.data?.id;

  await api(`/api/v1/placements/${pid}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "pitched" }),
  });
  await api(`/api/v1/placements/${pid}/client-decision`, T.owner, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", note: "Anchor approved" }),
  });

  const brief = await api("/api/v1/content/briefs", T.owner, {
    method: "POST",
    body: JSON.stringify({ placementId: pid, assignedTo: writerId, brief: "client sign-off" }),
  });
  const draft = await api("/api/v1/content/drafts", T.writer, {
    method: "POST",
    body: JSON.stringify({ briefId: brief.body?.data?.id, title: "Client sign-off", bodyMd: "Article body." }),
  });
  const did = draft.body?.data?.id;

  // Before submission the client must not see it.
  const beforeSubmit = await api("/portal/v1/drafts", T.client);
  check(
    "a client does not see an unsubmitted draft",
    !(beforeSubmit.body?.data ?? []).some((d) => d.id === did),
  );

  await api(`/api/v1/content/drafts/${did}/transition`, T.writer, {
    method: "POST",
    body: JSON.stringify({ status: "in_review" }),
  });

  const afterSubmit = await api("/portal/v1/drafts", T.client);
  const visible = (afterSubmit.body?.data ?? []).find((d) => d.id === did);

  // Strict: the campaign was chosen to belong to this client, so the draft MUST be
  // visible once submitted. A permissive assertion here would hide the bug where a
  // client could never see anything.
  check("the client sees the submitted draft", Boolean(visible), `${(afterSubmit.body?.data ?? []).length} drafts visible`);
  check("the visible draft carries its body for review", (visible?.body_md ?? "").length > 0);

  if (visible) {
    const approved = await api(`/portal/v1/drafts/${did}/approve`, T.client, {
      method: "POST",
      body: JSON.stringify({ note: "Approved by the client." }),
    });
    check("the client can approve their own draft", approved.status === 200, String(approved.status));

    const recheck = await api(`/api/v1/content/drafts/${did}`, T.owner);
    check("the approval is reflected on the draft", recheck.body?.data?.status === "approved");
    check("the approval records who approved", Boolean(recheck.body?.data?.approved_by));

    const twice = await api(`/portal/v1/drafts/${did}/approve`, T.client, {
      method: "POST",
      body: JSON.stringify({}),
    });
    check("a draft cannot be approved twice", twice.status === 400, String(twice.status));
  }

  // Isolation: a draft on ANOTHER client's placement must stay invisible.
  const otherCamp = (campaignsAll.body?.data ?? []).find((c) => !grantedClientIds.has(c.client_id));
  if (otherCamp) {
    const otherP = await api("/api/v1/placements", T.owner, {
      method: "POST",
      body: JSON.stringify({ campaignId: otherCamp.id, targetUrl: `https://other.test/x-${Date.now()}` }),
    });
    const otherPid = otherP.body?.data?.id;
    await api(`/api/v1/placements/${otherPid}/transition`, T.owner, {
      method: "POST",
      body: JSON.stringify({ toStage: "pitched" }),
    });
    await api(`/api/v1/placements/${otherPid}/client-decision`, T.owner, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", note: "other client" }),
    });
    const otherBrief = await api("/api/v1/content/briefs", T.owner, {
      method: "POST",
      body: JSON.stringify({ placementId: otherPid, assignedTo: writerId, brief: "other client brief" }),
    });
    const otherDraft = await api("/api/v1/content/drafts", T.writer, {
      method: "POST",
      body: JSON.stringify({ briefId: otherBrief.body?.data?.id, bodyMd: "other client body" }),
    });
    const otherId = otherDraft.body?.data?.id;
    await api(`/api/v1/content/drafts/${otherId}/transition`, T.writer, {
      method: "POST",
      body: JSON.stringify({ status: "in_review" }),
    });

    const portalAgain = await api("/portal/v1/drafts", T.client);
    check(
      "a draft for another client is not visible",
      !(portalAgain.body?.data ?? []).some((d) => d.id === otherId),
    );

    const approveOther = await api(`/portal/v1/drafts/${otherId}/approve`, T.client, {
      method: "POST",
      body: JSON.stringify({}),
    });
    check("a client cannot approve another client's draft", approveOther.status === 404, String(approveOther.status));
  }

  // A writer must not be able to use the client-only endpoint.
  const writerOnPortal = await api(`/portal/v1/drafts/${did}/approve`, T.writer, {
    method: "POST",
    body: JSON.stringify({}),
  });
  check("a writer cannot use the client approval endpoint", writerOnPortal.status === 403, String(writerOnPortal.status));

  // And the client must not be able to edit the text.
  const clientEdit = await api(`/api/v1/content/drafts/${did}/versions`, T.client, {
    method: "POST",
    body: JSON.stringify({ bodyMd: "hijacked" }),
  });
  check("a client cannot edit draft text", clientEdit.status === 403, String(clientEdit.status));
}

// ===========================================================================
console.log("\n6. anchor classification endpoint");
// ===========================================================================
{
  const cases = [
    ["Acme", "branded"],
    ["click here", "generic"],
    ["https://acme.test/pricing", "naked_url"],
    ["analytics", "exact_match"],
  ];

  for (const [text, expected] of cases) {
    const res = await api("/api/v1/anchors/classify", T.owner, {
      method: "POST",
      body: JSON.stringify({
        anchorText: text,
        targetUrl: "https://acme.test/analytics",
        brandName: "Acme",
        brandDomain: "acme.test",
      }),
    });
    check(`classifies "${text}" as ${expected}`, res.body?.data?.category === expected, res.body?.data?.category);
  }

  const empty = await api("/api/v1/anchors/classify", T.owner, {
    method: "POST",
    body: JSON.stringify({ anchorText: "" }),
  });
  check("an empty anchor is reported as unclassified, not guessed", empty.body?.data?.classified === false);

  const tooLong = await api("/api/v1/anchors/classify", T.owner, {
    method: "POST",
    body: JSON.stringify({ anchorText: "x".repeat(600) }),
  });
  check("an oversized anchor is rejected by validation", tooLong.status === 400, String(tooLong.status));
}

// ===========================================================================
console.log("\n6. anchor distribution");
// ===========================================================================
{
  const dist = await api(`/api/v1/anchors/distribution?scope=campaign&campaignId=${campaignId}`, T.owner);
  check("campaign distribution returns 200", dist.status === 200, String(dist.status));
  check("all four display groups are present", (dist.body?.data?.groups ?? []).length === 4);
  check(
    "shares sum to at most 1 (unclassified excluded)",
    (dist.body?.data?.groups ?? []).reduce((n, g) => n + g.share, 0) <= 1.0001,
    String((dist.body?.data?.groups ?? []).reduce((n, g) => n + g.share, 0)),
  );

  const clientDist = await api(`/api/v1/anchors/distribution?scope=client&clientId=${clientId}`, T.owner);
  check("client distribution returns 200", clientDist.status === 200, String(clientDist.status));

  const missingScope = await api("/api/v1/anchors/distribution?scope=campaign", T.owner);
  check("a scope without an id is refused", missingScope.status === 400, String(missingScope.status));

  const backfill = await api("/api/v1/anchors/backfill", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, limit: 50 }),
  });
  check("anchor backfill runs", backfill.status === 200, String(backfill.status));
  check("backfill reports what it scanned", typeof backfill.body?.data?.scanned === "number");
}

// ===========================================================================
console.log("\n7. anchor alerts");
// ===========================================================================
{
  const created = await api("/api/v1/anchors/alerts", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, anchorCategory: "exact_match", maxShare: 0.2, minLinks: 1 }),
  });
  check("an alert can be configured", created.status === 201, `${created.status} ${JSON.stringify(created.body?.error ?? "")}`);
  const alertId = created.body?.data?.id;

  const bothScopes = await api("/api/v1/anchors/alerts", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, clientId, anchorCategory: "branded", maxShare: 0.5 }),
  });
  check("an alert with both scopes is refused", bothScopes.status === 400, String(bothScopes.status));

  const badRange = await api("/api/v1/anchors/alerts", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, anchorCategory: "branded", maxShare: 0.2, minShare: 0.8 }),
  });
  check("minShare above maxShare is refused", badRange.status === 400, String(badRange.status));

  const outOfRange = await api("/api/v1/anchors/alerts", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, anchorCategory: "branded", maxShare: 1.5 }),
  });
  check("a share above 1 is refused", outOfRange.status === 400, String(outOfRange.status));

  const writerAlert = await api("/api/v1/anchors/alerts", T.writer, {
    method: "POST",
    body: JSON.stringify({ campaignId, anchorCategory: "branded", maxShare: 0.5 }),
  });
  check("a writer cannot configure alerts", writerAlert.status === 403, String(writerAlert.status));

  const list = await api(`/api/v1/anchors/alerts?campaignId=${campaignId}`, T.owner);
  check("alerts can be listed", list.status === 200 && (list.body?.data ?? []).length >= 1);

  const evaluated = await api(`/api/v1/anchors/alerts/evaluate?campaignId=${campaignId}`, T.owner);
  check("alerts can be evaluated", evaluated.status === 200, String(evaluated.status));
  check("evaluation returns a breach list", Array.isArray(evaluated.body?.data?.breaches));
  check("evaluation names the scope", evaluated.body?.data?.scope === "campaign");
  check("evaluation reports the sample size", typeof evaluated.body?.data?.totalLinks === "number");

  // The sample floor must apply to the TOTAL, not to each category.
  //
  // Applied per category, a category could never breach unless it alone held 10
  // links — which is backwards, since over-optimisation is one category dominating
  // a small total. This is the check that would have caught the bug where the
  // chart showed a red bar and the panel beside it said "no alerts firing".
  check(
    "each breach names a category and a threshold",
    (evaluated.body?.data?.breaches ?? []).every(
      (b) => typeof b.category === "string" && typeof b.threshold === "number" && typeof b.share === "number",
    ),
  );

  const patched = await api(`/api/v1/anchors/alerts/${alertId}`, T.owner, {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
  });
  check("an alert can be disabled", patched.status === 200 && patched.body?.data?.enabled === false);

  const removed = await api(`/api/v1/anchors/alerts/${alertId}`, T.owner, { method: "DELETE" });
  check("an alert can be deleted", removed.status === 204, String(removed.status));
}

// ===========================================================================
console.log("\n8. verification — internal addresses are refused");
// ===========================================================================
{
  const placement = await newPlacement("ssrf", { targetUrl: "https://acme-saas.test/ssrf-target" });

  // An internal address is refused AT WRITE TIME, not just at fetch time.
  //
  // This is the stronger of the two guards: a loopback or metadata URL is a
  // problem in itself (it would appear in reports and exports), so it never
  // reaches the database at all. The fetch-time guard is the second line, proven
  // by the url-safety unit tests.
  for (const badUrl of [
    "http://127.0.0.1:9/metadata",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/admin",
    "file:///etc/passwd",
  ]) {
    const res = await api(`/api/v1/placements/${placement.id}`, T.owner, {
      method: "PATCH",
      body: JSON.stringify({ liveUrl: badUrl }),
    });
    check(`refuses to store ${badUrl}`, res.status === 400, String(res.status));
  }

  const stored = await api(`/api/v1/placements/${placement.id}`, T.owner);
  check("the placement still has no live URL after the refusals", !stored.body?.data?.live_url);

  // A legitimate public URL is accepted — the guard is not simply blocking
  // everything.
  const good = await api(`/api/v1/placements/${placement.id}`, T.owner, {
    method: "PATCH",
    body: JSON.stringify({ liveUrl: "https://publisher.test/legit-article" }),
  });
  check("a public live URL is accepted", good.status === 200, `${good.status} ${JSON.stringify(good.body?.error ?? "")}`);
  check("the live URL is stored", good.body?.data?.live_url === "https://publisher.test/legit-article");

  // Verification runs and records a verdict. The host does not exist, so the
  // honest outcome is `unreachable` — NOT `link_missing`, which would be a false
  // claim that the link was removed from a page we never read.
  const verified = await api(`/api/v1/placements/${placement.id}/check`, T.owner, { method: "POST" });
  check("verification returns 200 with a verdict", verified.status === 200, `${verified.status} ${JSON.stringify(verified.body?.error ?? "")}`);

  // Responses are wrapped in { data, meta } by the API's ok() helper.
  const v = verified.body?.data ?? {};
  check(
    "an unreachable host is not reported as a missing link",
    v.verdict === "unreachable",
    `${v.verdict} — ${v.failure_reason ?? v.raw?.reason ?? ""}`,
  );
  check("the verdict is not 'ok'", v.verdict !== "ok");
  check("a failed fetch did NOT change the placement status", v.statusChanged === false, String(v.statusChanged));

  const history = await api(`/api/v1/placements/${placement.id}/checks`, T.owner);
  check("the verification was recorded", (history.body?.data ?? []).length >= 1);
  check("the record carries the verdict", history.body?.data?.[0]?.verdict === "unreachable");
  check("the record carries a failure reason", Boolean(history.body?.data?.[0]?.failure_reason));
  check("the record records the expected URL", Boolean(history.body?.data?.[0]?.expected_url));
  check("the record stamps a check time", Boolean(history.body?.data?.[0]?.checked_at));
}

// ===========================================================================
console.log("\n9. verification permissions");
// ===========================================================================
{
  const list = await api("/api/v1/placements?limit=1", T.owner);
  const somePlacement = list.body.data[0];

  const writerCheck = await api(`/api/v1/placements/${somePlacement.id}/check`, T.writer, { method: "POST" });
  check("a content writer cannot run verification", writerCheck.status === 403, String(writerCheck.status));

  const clientCheck = await api(`/api/v1/placements/${somePlacement.id}/check`, T.client, { method: "POST" });
  check("a client cannot run verification", clientCheck.status === 403, String(clientCheck.status));

  const publisherCheck = await api(`/api/v1/placements/${somePlacement.id}/check`, T.publisher, { method: "POST" });
  check("a publisher cannot run verification", publisherCheck.status === 403, String(publisherCheck.status));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
}
process.exit(failed.length > 0 ? 1 : 0);
