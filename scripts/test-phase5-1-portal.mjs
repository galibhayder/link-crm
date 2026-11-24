/**
 * PHASE 5.1 — CLIENT PORTAL AUTHORIZATION AND ISOLATION.
 *
 * The portal is the one place a customer sees the agency's data, so every check
 * here is about what they must NOT reach. The surface guard is the boundary: a
 * `client_user` token is rejected on `/api/v1` before any handler runs, which is
 * why the route and UI layers are convenience rather than security.
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

// Which client is the portal user granted? Ask the portal, not the internal API.
const portalOverview = await api("/portal/v1/overview", T.client);
const grantedClients = portalOverview.body?.data?.clients ?? [];
const grantedCampaigns = portalOverview.body?.data?.campaigns ?? [];

// ===========================================================================
console.log("\n1. portal identity");
// ===========================================================================
{
  const me = await api("/portal/v1/me", T.client);
  check("portal /me returns 200", me.status === 200, String(me.status));
  check("portal /me identifies a client_user", me.body?.data?.role === "client_user", me.body?.data?.role);

  const perms = await api("/portal/v1/me/permissions", T.client);
  check("portal /me/permissions returns 200", perms.status === 200, String(perms.status));
  check("the surface is reported as portal", perms.body?.data?.surface === "portal", perms.body?.data?.surface);
  check(
    "the client holds briefs:approve (so they can sign off content)",
    (perms.body?.data?.permissions ?? []).includes("briefs:approve"),
  );
  check(
    "the client does NOT hold staff-only permissions",
    !(perms.body?.data?.permissions ?? []).includes("placements:write") &&
      !(perms.body?.data?.permissions ?? []).includes("briefs:write"),
  );
}

// ===========================================================================
console.log("\n2. the surface guard — a client cannot reach /api/v1 at all");
// ===========================================================================
{
  const internalRoutes = [
    "/api/v1/me",
    "/api/v1/content/drafts",
    "/api/v1/content/briefs",
    "/api/v1/placements",
    "/api/v1/placements/board",
    "/api/v1/clients",
    "/api/v1/campaigns",
    "/api/v1/publishers",
    "/api/v1/prospects",
    "/api/v1/anchors/distribution?scope=campaign&campaignId=" + (grantedCampaigns[0]?.id ?? "00000000-0000-0000-0000-000000000000"),
    "/api/v1/notifications",
    "/api/v1/audit",
    "/api/v1/staff",
    "/api/v1/reports/profitability",
    "/api/v1/costs/placements/00000000-0000-0000-0000-000000000000",
  ];

  for (const path of internalRoutes) {
    const res = await api(path, T.client);
    check(`client is refused ${path}`, res.status === 403 || res.status === 404, String(res.status));
  }
}

// ===========================================================================
console.log("\n3. a client sees only their own client, campaigns and placements");
// ===========================================================================
{
  check("the portal reports at least one granted client", grantedClients.length >= 1, String(grantedClients.length));

  // Internal truth: how many clients exist in the org?
  const allClients = await api("/api/v1/clients?limit=50", T.owner);
  const orgClientCount = (allClients.body?.data ?? []).length;
  check(
    "the client sees fewer clients than the organisation has",
    grantedClients.length < orgClientCount || orgClientCount <= 1,
    `${grantedClients.length} of ${orgClientCount}`,
  );

  const placements = await api("/portal/v1/placements", T.client);
  check("portal placements returns 200", placements.status === 200, String(placements.status));

  // Every placement must belong to one of the granted campaigns.
  const grantedCampaignIds = new Set(grantedCampaigns.map((c) => c.id));
  const foreign = (placements.body?.data ?? []).filter((p) => !grantedCampaignIds.has(p.campaign_id));
  check("every visible placement is on a granted campaign", foreign.length === 0, `${foreign.length} foreign`);

  // And nothing internal may appear in the payload.
  const leaks = [
    ["internal_notes", /internal_notes/i],
    ["negotiated_cost", /negotiated_cost/i],
    ["supplier_cost", /supplier_cost/i],
    ["client_rate", /client_rate/i],
    ["margin", /margin/i],
    ["assigned_to", /assigned_to/i],
    ["content_assignee", /content_assignee/i],
  ];
  for (const [label, re] of leaks) {
    check(`portal placements payload has no ${label}`, !re.test(placements.text));
  }

  const drafts = await api("/portal/v1/drafts", T.client);
  check("portal drafts returns 200", drafts.status === 200, String(drafts.status));
  check("portal drafts payload has no internal notes", !/internal_notes/i.test(drafts.text));
  check("portal drafts payload has no writer identity", !/created_by|writer_id/i.test(drafts.text));

  // The dashboard counters must agree with the list beneath them.
  //
  // Regression: the overview originally counted `placements` directly. A client_user
  // has NO policy on that table, so it returned zero rows and the page reported
  // "0 live links, 0 placements" directly above a table showing several of each.
  const overview = await api("/portal/v1/overview", T.client);
  check("portal /overview returns 200", overview.status === 200, String(overview.status));

  const listCount = (placements.body?.data ?? []).length;
  const liveCount = (placements.body?.data ?? []).filter((p) => p.status === "live").length;

  check(
    "the overview total matches the placement list",
    overview.body?.data?.totalPlacements === listCount,
    `overview ${overview.body?.data?.totalPlacements} vs list ${listCount}`,
  );
  check(
    "the overview live count matches the list",
    overview.body?.data?.livePlacements === liveCount,
    `overview ${overview.body?.data?.livePlacements} vs list ${liveCount}`,
  );
  check(
    "the counts are not silently zeroed by the missing table policy",
    listCount === 0 || overview.body?.data?.totalPlacements > 0,
    `${overview.body?.data?.totalPlacements} of ${listCount}`,
  );
}

// ===========================================================================
console.log("\n4. draft approval end to end");
// ===========================================================================
{
  const campaignId = grantedCampaigns[0]?.id;
  check("the client has a campaign to work with", Boolean(campaignId), campaignId);

  if (campaignId) {
    // Build a placement on the CLIENT's campaign, walk it to content_writing.
    const staff = await api("/api/v1/staff?limit=50", T.owner);
    const writerId = (staff.body?.data ?? []).find((s) => s.email === "writer@demo.test")?.id;

    const p = await api("/api/v1/placements", T.owner, {
      method: "POST",
      body: JSON.stringify({
        campaignId,
        targetUrl: `https://acme-saas.test/p51-${Date.now()}`,
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
      body: JSON.stringify({ decision: "approve", note: "Anchor approved for the portal test" }),
    });

    const brief = await api("/api/v1/content/briefs", T.owner, {
      method: "POST",
      body: JSON.stringify({ placementId: pid, assignedTo: writerId, brief: "Portal approval test" }),
    });
    const draft = await api("/api/v1/content/drafts", T.writer, {
      method: "POST",
      body: JSON.stringify({ briefId: brief.body?.data?.id, title: "Portal approval test", bodyMd: "Body text." }),
    });
    const did = draft.body?.data?.id;
    check("a draft was created for the approval flow", Boolean(did), String(draft.status));

    // Not submitted → invisible.
    const beforeSubmit = await api("/portal/v1/drafts", T.client);
    check(
      "an unsubmitted draft is not visible",
      !(beforeSubmit.body?.data ?? []).some((d) => d.id === did),
    );

    await api(`/api/v1/content/drafts/${did}/transition`, T.writer, {
      method: "POST",
      body: JSON.stringify({ status: "in_review" }),
    });

    const afterSubmit = await api("/portal/v1/drafts", T.client);
    const visible = (afterSubmit.body?.data ?? []).find((d) => d.id === did);
    check("the submitted draft becomes visible", Boolean(visible));
    check("the draft body is readable for review", (visible?.body_md ?? "").length > 0);

    // Revision request.
    const shortNote = await api(`/portal/v1/drafts/${did}/revision`, T.client, {
      method: "POST",
      body: JSON.stringify({ note: "x" }),
    });
    check("a too-short revision note is rejected", shortNote.status === 400, String(shortNote.status));

    const revision = await api(`/portal/v1/drafts/${did}/revision`, T.client, {
      method: "POST",
      body: JSON.stringify({ note: "Please add a statistic to the intro." }),
    });
    check("the client can request a revision", revision.status === 200, `${revision.status} ${JSON.stringify(revision.body?.error ?? "")}`);
    check("the draft is now in revision_requested", revision.body?.data?.status === "revision_requested", revision.body?.data?.status);

    // The revision is recorded as a row the writer sees.
    const revisions = await api(`/api/v1/content/drafts/${did}/revisions`, T.owner);
    const open = (revisions.body?.data ?? []).find((r) => r.status === "open");
    check("the revision request is recorded", Boolean(open));
    check("the note is preserved", (open?.notes ?? "").includes("statistic"), open?.notes);

    // A second open request is refused.
    const second = await api(`/portal/v1/drafts/${did}/revision`, T.client, {
      method: "POST",
      body: JSON.stringify({ note: "And another thing entirely." }),
    });
    check("a second open revision request is refused", second.status === 409 || second.status === 400, String(second.status));

    // The writer fixes it, returns to review, the client approves.
    await api(`/api/v1/content/drafts/${did}/versions`, T.writer, {
      method: "POST",
      body: JSON.stringify({ bodyMd: "Revised with a statistic." }),
    });
    const backInReview = await api("/portal/v1/drafts", T.client);
    check(
      "the draft returns to review after the writer saves",
      (backInReview.body?.data ?? []).find((d) => d.id === did)?.status === "in_review",
    );

    const approve = await api(`/portal/v1/drafts/${did}/approve`, T.client, {
      method: "POST",
      body: JSON.stringify({ note: "Approved, thanks." }),
    });
    check("the client can approve", approve.status === 200, `${approve.status} ${JSON.stringify(approve.body?.error ?? "")}`);
    check("approval sets the status", approve.body?.data?.status === "approved", approve.body?.data?.status);

    const verify = await api(`/api/v1/content/drafts/${did}`, T.owner);
    check("approval is attributed", Boolean(verify.body?.data?.approved_by));
    check("the client's note is stored", (verify.body?.data?.client_approval_note ?? "").includes("Approved"));

    const twice = await api(`/portal/v1/drafts/${did}/approve`, T.client, {
      method: "POST",
      body: JSON.stringify({}),
    });
    check("a draft cannot be approved twice", twice.status === 400, String(twice.status));
  }
}

// ===========================================================================
console.log("\n5. a client cannot modify draft content");
// ===========================================================================
{
  const campaignId = grantedCampaigns[0]?.id;
  const drafts = await api("/portal/v1/drafts", T.client);
  const anyDraft = (drafts.body?.data ?? [])[0];

  if (anyDraft) {
    const writeVersion = await api(`/api/v1/content/drafts/${anyDraft.id}/versions`, T.client, {
      method: "POST",
      body: JSON.stringify({ bodyMd: "client rewrite" }),
    });
    check("a client cannot write a draft version", writeVersion.status === 403, String(writeVersion.status));

    const patchDraft = await api(`/api/v1/content/drafts/${anyDraft.id}`, T.client, {
      method: "PATCH",
      body: JSON.stringify({ body_md: "client rewrite" }),
    });
    check("a client cannot PATCH a draft", patchDraft.status === 404 || patchDraft.status === 403, String(patchDraft.status));

    const transition = await api(`/api/v1/content/drafts/${anyDraft.id}/transition`, T.client, {
      method: "POST",
      body: JSON.stringify({ status: "approved" }),
    });
    check("a client cannot use the internal transition endpoint", transition.status === 403, String(transition.status));
  } else {
    check("a draft exists to attempt a client write against", false, "no drafts visible");
  }
  void campaignId;
}

// ===========================================================================
console.log("\n6. cross-client isolation");
// ===========================================================================
{
  // Build a draft on a campaign the client is NOT granted.
  const allCampaigns = await api("/api/v1/campaigns?limit=50", T.owner);
  const grantedIds = new Set(grantedCampaigns.map((c) => c.id));
  const foreignCampaign = (allCampaigns.body?.data ?? []).find((c) => !grantedIds.has(c.id));

  if (foreignCampaign) {
    const staff = await api("/api/v1/staff?limit=50", T.owner);
    const writerId = (staff.body?.data ?? []).find((s) => s.email === "writer@demo.test")?.id;

    const p = await api("/api/v1/placements", T.owner, {
      method: "POST",
      body: JSON.stringify({ campaignId: foreignCampaign.id, targetUrl: `https://other-client.test/${Date.now()}` }),
    });
    const pid = p.body?.data?.id;
    await api(`/api/v1/placements/${pid}/transition`, T.owner, { method: "POST", body: JSON.stringify({ toStage: "pitched" }) });
    await api(`/api/v1/placements/${pid}/client-decision`, T.owner, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", note: "other client" }),
    });
    const brief = await api("/api/v1/content/briefs", T.owner, {
      method: "POST",
      body: JSON.stringify({ placementId: pid, assignedTo: writerId, brief: "other client brief" }),
    });
    const draft = await api("/api/v1/content/drafts", T.writer, {
      method: "POST",
      body: JSON.stringify({ briefId: brief.body?.data?.id, title: "Other client secret", bodyMd: "secret" }),
    });
    const did = draft.body?.data?.id;
    await api(`/api/v1/content/drafts/${did}/transition`, T.writer, {
      method: "POST",
      body: JSON.stringify({ status: "in_review" }),
    });

    const portal = await api("/portal/v1/drafts", T.client);
    check(
      "another client's draft is not listed",
      !(portal.body?.data ?? []).some((d) => d.id === did),
    );

    const approveForeign = await api(`/portal/v1/drafts/${did}/approve`, T.client, {
      method: "POST",
      body: JSON.stringify({}),
    });
    check("another client's draft cannot be approved", approveForeign.status === 404, String(approveForeign.status));

    const reviseForeign = await api(`/portal/v1/drafts/${did}/revision`, T.client, {
      method: "POST",
      body: JSON.stringify({ note: "trying to touch another client" }),
    });
    check("another client's draft cannot be revised", reviseForeign.status === 404, String(reviseForeign.status));

    const portalPlacements = await api("/portal/v1/placements", T.client);
    check(
      "another client's placement is not visible",
      !(portalPlacements.body?.data ?? []).some((pl) => pl.id === pid),
    );
  } else {
    check("a foreign campaign exists to test isolation", false, "only one client in the org");
  }
}

// ===========================================================================
console.log("\n7. other roles on the portal surface");
// ===========================================================================
{
  for (const [label, token] of [
    ["owner", T.owner],
    ["account_manager", T.am],
    ["content_writer", T.writer],
  ]) {
    const res = await api("/portal/v1/drafts", token);
    check(`${label} is refused on the portal`, res.status === 403, String(res.status));
  }

  // A publisher is on the supplier surface, not the portal.
  const pub = await api("/portal/v1/drafts", T.publisher);
  check("publisher_user is refused on the portal", pub.status === 403, String(pub.status));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
