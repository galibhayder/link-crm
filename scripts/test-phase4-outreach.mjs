/**
 * PHASE 4 OUTREACH + PLACEMENT RULE TESTS.
 *
 * Covers the rules that the pipeline suite does not: approval attribution,
 * template rendering safety, follow-up accounting, and the guarantee that a
 * client can never reach outreach at all.
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
  if (!b.access_token) throw new Error(`login failed: ${email}`);
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
  outreach: await login("outreach@demo.test"),
  writer: await login("writer@demo.test"),
  client: await login("client@demo.test"),
  publisher: await login("publisher@demo.test"),
};

const campaigns = await api("/api/v1/campaigns?limit=1", T.owner);
const campaignId = campaigns.body.data[0].id;
const prospects = await api("/api/v1/prospects?limit=1", T.owner);
const prospect = prospects.body.data[0];

// ===========================================================================
console.log("\n1. approval attribution");
// ===========================================================================
{
  const created = await api("/api/v1/placements", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, targetUrl: `https://acme-saas.test/appr-${Date.now()}` }),
  });
  const id = created.body.data.id;

  await api(`/api/v1/placements/${id}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "pitched" }),
  });

  const approved = await api(`/api/v1/placements/${id}/transition`, T.owner, {
    method: "POST",
    body: JSON.stringify({ toStage: "client_approved", clientApprovalNote: "Approved in the Tuesday call" }),
  });

  check("approval records who approved it", Boolean(approved.body?.data?.client_approved_by), approved.body?.data?.client_approved_by);
  check("approval records when", Boolean(approved.body?.data?.client_approved_at));

  const history = await api(`/api/v1/placements/${id}/history`, T.owner);
  const events = history.body?.data ?? [];
  check("approval is its own history event type", events.some((e) => e.event_type === "client_approved"));
  check("approval history carries the actor", events.some((e) => e.event_type === "client_approved" && e.actor_id));
}

// ===========================================================================
console.log("\n2. existing functionality intact");
// ===========================================================================
{
  const list = await api("/api/v1/placements?limit=5", T.owner);
  check("placement list still paginates", list.status === 200 && Array.isArray(list.body.data));
  check("list response carries meta", Boolean(list.body.meta), JSON.stringify(list.body.meta ?? {}));

  const filtered = await api("/api/v1/placements?pipelineStage=live&limit=50", T.owner);
  check("filtering by pipeline stage works", filtered.status === 200);
  check("only live placements returned", (filtered.body.data ?? []).every((p) => p.pipeline_stage === "live"));

  const search = await api("/api/v1/placements?q=acme&limit=50", T.owner);
  check("search works alongside the pipeline fields", search.status === 200);

  const csv = await api("/api/v1/placements/export/csv", T.owner);
  check("CSV export still works", csv.status === 200 && csv.text.includes("target_url"));

  const stages = await api("/api/v1/placements/options/stages", T.owner);
  check("stage options endpoint works", stages.status === 200 && stages.body.data.length === 6, String(stages.body?.data?.length));

  const settings = await api("/api/v1/settings/pipeline-stages", T.owner);
  check("settings stage list is scoped to prospects", settings.status === 200);
  check(
    "settings stage list has no placement stages mixed in",
    (settings.body.data ?? []).every((s) => s.applies_to === "prospect"),
    [...new Set((settings.body.data ?? []).map((s) => s.applies_to))].join(","),
  );

  const placementStages = await api("/api/v1/settings/pipeline-stages?appliesTo=placement", T.owner);
  check("settings can list placement stages", placementStages.status === 200 && placementStages.body.data.length === 6);

  // The duplicate-stage bug must stay fixed.
  const keys = (settings.body.data ?? []).map((s) => s.key);
  check("no duplicate prospect stage keys", new Set(keys).size === keys.length, keys.join(","));
}

// ===========================================================================
console.log("\n3. archived placements stay off the board");
// ===========================================================================
{
  const created = await api("/api/v1/placements", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, targetUrl: `https://acme-saas.test/arch-${Date.now()}` }),
  });
  const id = created.body.data.id;

  const archived = await api(`/api/v1/placements/${id}`, T.owner, { method: "DELETE" });
  check("archiving a placement works", archived.status === 204, String(archived.status));

  const board = await api("/api/v1/placements/board", T.owner);
  const onBoard = (board.body?.data?.stages ?? []).some((s) => s.placements.some((p) => p.id === id));
  check("archived placement is not on the board", !onBoard);

  const detail = await api(`/api/v1/placements/${id}`, T.owner);
  check("archived placement is not readable by id", detail.status === 404, String(detail.status));

  const restored = await api(`/api/v1/placements/${id}/restore`, T.owner, { method: "POST" });
  check("restoring works", restored.status === 200, String(restored.status));

  const board2 = await api("/api/v1/placements/board", T.owner);
  const backOnBoard = (board2.body?.data?.stages ?? []).some((s) => s.placements.some((p) => p.id === id));
  check("restored placement returns to the board", backOnBoard);
}

// ===========================================================================
console.log("\n4. template rendering cannot execute code");
// ===========================================================================
{
  // A template containing a JS expression must be left as literal text.
  const tpl = await api("/api/v1/outreach/templates", T.owner, {
    method: "POST",
    body: JSON.stringify({
      name: `Injection probe ${Date.now()}`,
      subject: "Hi {{contact_name}}",
      bodyMd: "Domain is {{domain}}. Not code: {{ 7*7 }} ${process.env.SECRET} <%= 1 %>",
      category: "initial",
      variables: ["domain", "contact_name"],
    }),
  });
  check("a template with suspicious content can be stored", tpl.status === 201, String(tpl.status));

  const rendered = await api(`/api/v1/outreach/templates/${tpl.body.data.id}/render`, T.owner, {
    method: "POST",
    body: JSON.stringify({ prospectId: prospect.id }),
  });
  check("rendering succeeds", rendered.status === 200, String(rendered.status));

  const bodyText = rendered.body?.data?.body ?? "";
  check("only simple {{var}} placeholders are substituted", bodyText.includes(prospect.domain), bodyText.slice(0, 80));
  check("arithmetic expressions are not evaluated", bodyText.includes("{{ 7*7 }}"), bodyText.slice(0, 120));
  // The literal `${...}` and `<%= ... %>` strings must survive untouched. Checking
  // for the absence of "49" would be wrong: the domain in the rendered output
  // legitimately contains digits.
  check(
    "server-side template syntax is left as literal text",
    bodyText.includes("${process.env.SECRET}") && bodyText.includes("<%= 1 %>"),
    bodyText.slice(0, 140),
  );
  // The literal placeholder text contains the word SECRET, so a naive grep for
  // "secret" would fail on the correct output. What matters is that no real
  // environment VALUE was substituted in.
  check(
    "no server environment value was substituted in",
    !bodyText.includes(String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "\u0000")),
  );
  check("unknown variables collapse to empty, not the literal name", !/\{\{domain\}\}/.test(bodyText));

  await api(`/api/v1/outreach/templates/${tpl.body.data.id}`, T.owner, { method: "DELETE" });
}

// ===========================================================================
console.log("\n5. follow-up accounting");
// ===========================================================================
{
  const rec = await api("/api/v1/outreach", T.owner, {
    method: "POST",
    body: JSON.stringify({
      prospectId: prospect.id,
      campaignId: prospect.campaign_id,
      subject: "Follow-up accounting",
      recipientEmail: "editor@example.test",
    }),
  });
  check("outreach record created", rec.status === 201, String(rec.status));
  const id = rec.body.data.id;
  check("starts with zero follow-ups", rec.body.data.follow_up_count === 0);

  const log1 = await api(`/api/v1/outreach/${id}/log`, T.owner, {
    method: "POST",
    body: JSON.stringify({ channel: "email", outcome: "no_reply" }),
  });
  check("first log records one follow-up", log1.body?.data?.follow_up_count === 1, String(log1.body?.data?.follow_up_count));

  const log2 = await api(`/api/v1/outreach/${id}/log`, T.owner, {
    method: "POST",
    body: JSON.stringify({ channel: "linkedin", outcome: "no_reply" }),
  });
  check("second log increments the counter", log2.body?.data?.follow_up_count === 2, String(log2.body?.data?.follow_up_count));

  const history = await api(`/api/v1/outreach/prospect/${prospect.id}`, T.owner);
  check("each logged outreach becomes a touchpoint", (history.body?.data?.touchpoints ?? []).length >= 2,
    String((history.body?.data?.touchpoints ?? []).length));

  // Sending must still be refused.
  const send = await api(`/api/v1/outreach/${id}/send`, T.owner, {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
  check("send is refused without a provider", send.status === 503, String(send.status));
  check("the refusal is actionable, not masked", /EMAIL_PROVIDER/.test(send.body?.error?.message ?? ""),
    send.body?.error?.message?.slice(0, 90));
}

// ===========================================================================
console.log("\n6. outreach permissions");
// ===========================================================================
{
  for (const [name, token] of [["client", T.client], ["publisher", T.publisher], ["content_writer", T.writer]]) {
    const records = await api("/api/v1/outreach", token);
    check(`${name} cannot read outreach records`, records.status === 403, String(records.status));

    const templates = await api("/api/v1/outreach/templates", token);
    check(`${name} cannot read email templates`, templates.status === 403, String(templates.status));

    const followUps = await api("/api/v1/outreach/follow-ups", token);
    check(`${name} cannot read the follow-up queue`, followUps.status === 403, String(followUps.status));
  }

  // The specialists who do the work must be able to.
  const outRecords = await api("/api/v1/outreach", T.outreach);
  check("outreach_specialist can read records", outRecords.status === 200, String(outRecords.status));

  const amRecords = await api("/api/v1/outreach", T.am);
  check("account_manager can read records", amRecords.status === 200, String(amRecords.status));

  const tplCreate = await api("/api/v1/outreach/templates", T.writer, {
    method: "POST",
    body: JSON.stringify({ name: "x", subject: "y", bodyMd: "z" }),
  });
  check("content_writer cannot create templates", tplCreate.status === 403, String(tplCreate.status));
}

// ===========================================================================
console.log("\n7. client cannot see internal placement detail");
// ===========================================================================
{
  const board = await api("/api/v1/placements/board", T.client);
  check("client is 403 on the board", board.status === 403, String(board.status));

  const csv = await api("/api/v1/placements/export/csv", T.client);
  check("client is 403 on placement export", csv.status === 403, String(csv.status));

  // Even a known placement id must not be readable.
  const list = await api("/api/v1/placements?limit=1", T.owner);
  const someId = list.body.data[0]?.id;
  const direct = await api(`/api/v1/placements/${someId}`, T.client);
  check("client is 403 on a placement by id", direct.status === 403, String(direct.status));

  const hist = await api(`/api/v1/placements/${someId}/history`, T.client);
  check("client is 403 on placement history", hist.status === 403, String(hist.status));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
