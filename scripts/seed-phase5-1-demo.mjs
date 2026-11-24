/**
 * Seed one draft in `in_review` for the demo client, so the portal's review flow is
 * demonstrable straight after `db:reset`. Wired to the real API — not a static
 * fixture — so the row behaves exactly like one a writer submitted.
 */
const API = "http://127.0.0.1:3000";
const SUPABASE = "http://127.0.0.1:54321";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const login = async (email) => {
  const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  return (await r.json()).access_token;
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
  } catch {}
  return { status: res.status, body };
};

const owner = await login("owner@demo.test");
const writer = await login("writer@demo.test");
const client = await login("client@demo.test");

// Which campaign does the demo client actually have? Ask the portal.
const overview = await api("/portal/v1/overview", client);
const campaignId = overview.body?.data?.campaigns?.[0]?.id;
if (!campaignId) {
  console.error("No campaign is granted to the demo client — run the seed first.");
  process.exit(1);
}

const staff = await api("/api/v1/staff?limit=50", owner);
const writerId = (staff.body?.data ?? []).find((s) => s.email === "writer@demo.test")?.id;

const stamp = Date.now();

const placement = await api("/api/v1/placements", owner, {
  method: "POST",
  body: JSON.stringify({
    campaignId,
    targetUrl: `https://acme-saas.test/analytics-guide-${stamp}`,
    anchorText: "saas analytics platform",
  }),
});
const placementId = placement.body?.data?.id;
if (!placementId) {
  console.error("Could not create a placement:", JSON.stringify(placement.body?.error ?? placement.body));
  process.exit(1);
}

await api(`/api/v1/placements/${placementId}/transition`, owner, {
  method: "POST",
  body: JSON.stringify({ toStage: "pitched" }),
});
await api(`/api/v1/placements/${placementId}/client-decision`, owner, {
  method: "POST",
  body: JSON.stringify({ decision: "approve", note: "Anchor approved — good match for the target page." }),
});

const brief = await api("/api/v1/content/briefs", owner, {
  method: "POST",
  body: JSON.stringify({
    placementId,
    assignedTo: writerId,
    brief: "1,200 word comparison of analytics platforms for mid-market SaaS, one link to the target page.",
  }),
});

const body = [
  "## Choosing an analytics platform in 2026",
  "",
  "Analytics tooling for mid-market SaaS has changed considerably over the past few",
  "years. The decision is rarely about the feature list any more; most platforms cover",
  "the basics, and the difference shows up in what it costs to operate them.",
  "",
  "### What actually matters",
  "",
  "The first question is where the data lives. A platform that keeps event data in your",
  "own warehouse is a different commitment from one that holds it for you, and that",
  "choice constrains everything that follows — retention, joins across sources, and who",
  "you have to ask when you need a new report.",
  "",
  "The second is the cost of ownership. A generous free tier becomes a large bill once",
  "volume grows, and the reporting on that growth is usually less clear than the",
  "marketing page. Ask for the pricing at five times your current volume before you",
  "commit.",
  "",
  "### The comparison",
  "",
  "Across the three configurations we evaluated, the deciding factor was consistently",
  "operational: how much work is required to keep the pipeline healthy, and who is",
  "responsible when it breaks. The teams that were happiest had chosen the option that",
  "matched their existing on-call capacity rather than the one with the best demo.",
  "",
  "### A note on migration",
  "",
  "Moving between platforms is more expensive than the comparison tables suggest. Plan",
  "for the historical data to be lossy, and decide up front which reports you are",
  "willing to stop producing.",
].join("\n");

const draft = await api("/api/v1/content/drafts", writer, {
  method: "POST",
  body: JSON.stringify({
    briefId: brief.body?.data?.id,
    title: "Choosing an analytics platform in 2026",
    bodyMd: body,
  }),
});
const draftId = draft.body?.data?.id;
if (!draftId) {
  console.error("Could not create the draft:", JSON.stringify(draft.body?.error ?? draft.body));
  process.exit(1);
}

const submit = await api(`/api/v1/content/drafts/${draftId}/transition`, writer, {
  method: "POST",
  body: JSON.stringify({ status: "in_review" }),
});

const check = await api("/portal/v1/drafts", client);
const visible = (check.body?.data ?? []).find((d) => d.id === draftId);

console.log(`draft ${draftId}`);
console.log(`  submit status: ${submit.status}`);
console.log(`  status:        ${visible?.status ?? "NOT VISIBLE"}`);
console.log(`  words:         ${visible?.word_count ?? "?"}`);
console.log(`  awaiting review for the client: ${(check.body?.data ?? []).filter((d) => d.status === "in_review").length}`);

if (visible?.status !== "in_review") process.exit(1);
