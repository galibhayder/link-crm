/**
 * Verifies the three import bugs found in review are fixed:
 *
 *   1. Campaign import detects a duplicate by name within the same client.
 *   2. Campaign import does NOT flag the same name under a DIFFERENT client.
 *   3. Prospect import allows the same domain in a different campaign.
 */
const S = "http://127.0.0.1:54321";
const A =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const results = [];
const check = (n, ok, d = "") => {
  results.push(ok);
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

const r = await fetch(`${S}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: A, "content-type": "application/json" },
  body: JSON.stringify({ email: "owner@demo.test", password: "password123" }),
});
const T = (await r.json()).access_token;

const api = (p, o = {}) =>
  fetch(`http://127.0.0.1:3000${p}`, {
    ...o,
    headers: { authorization: `Bearer ${T}`, "content-type": "application/json", ...(o.headers ?? {}) },
  }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));

const clients = await api("/api/v1/clients?limit=10");
const [clientA, clientB] = clients.body.data;
console.log(`clients: ${clientA.name}, ${clientB.name}`);

console.log("\n1. campaign duplicate within the same client");
{
  const existing = await api(`/api/v1/campaigns?clientId=${clientA.id}&limit=5`);
  const name = existing.body.data[0].name;

  const preview = await api("/api/v1/import/campaigns/preview", {
    method: "POST",
    body: JSON.stringify({
      entity: "campaigns",
      rows: [{ name, status: "active" }],
      duplicateStrategy: "skip",
      defaults: { clientId: clientA.id },
    }),
  });

  const summary = preview.body?.data?.summary;
  check("detected as duplicate, not ok", summary?.duplicates === 1 && summary?.ok === 0, JSON.stringify(summary));

  const jobId = preview.body?.data?.jobId;
  const commit = await api("/api/v1/import/campaigns/commit", {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
  check("commit inserts nothing", commit.body?.data?.inserted === 0, JSON.stringify(commit.body?.data));

  const after = await api(`/api/v1/campaigns?clientId=${clientA.id}&limit=20`);
  const same = (after.body?.data ?? []).filter((c) => c.name === name);
  check("no duplicate row was created", same.length === 1, `${same.length} with that name`);
}

console.log("\n2. the same campaign name under a DIFFERENT client is allowed");
{
  const existing = await api(`/api/v1/campaigns?clientId=${clientA.id}&limit=5`);
  const name = existing.body.data[0].name;

  const preview = await api("/api/v1/import/campaigns/preview", {
    method: "POST",
    body: JSON.stringify({
      entity: "campaigns",
      rows: [{ name, status: "draft" }],
      duplicateStrategy: "skip",
      defaults: { clientId: clientB.id },
    }),
  });

  const summary = preview.body?.data?.summary;
  check("treated as new for the other client", summary?.ok === 1, JSON.stringify(summary));
}

console.log("\n3. the same prospect domain in a DIFFERENT campaign is allowed");
{
  const pros = await api("/api/v1/prospects?limit=5");
  const existing = pros.body.data[0];
  console.log(`prospect ${existing.domain} lives in campaign ${existing.campaign_id}`);

  const created = await api("/api/v1/campaigns", {
    method: "POST",
    body: JSON.stringify({ clientId: clientA.id, name: `Dedupe Scope ${Date.now()}`, status: "draft" }),
  });
  const campB = created.body?.data?.id;

  const preview = await api("/api/v1/import/prospects/preview", {
    method: "POST",
    body: JSON.stringify({
      entity: "prospects",
      rows: [{ domain: existing.domain, dr: "44" }],
      duplicateStrategy: "skip",
      defaults: { campaignId: campB },
    }),
  });

  const summary = preview.body?.data?.summary;
  check("allowed as a new prospect in the other campaign", summary?.ok === 1, JSON.stringify(summary));

  // And still detected as a duplicate within its OWN campaign.
  const sameCampaign = await api("/api/v1/import/prospects/preview", {
    method: "POST",
    body: JSON.stringify({
      entity: "prospects",
      rows: [{ domain: existing.domain, dr: "44" }],
      duplicateStrategy: "skip",
      defaults: { campaignId: existing.campaign_id },
    }),
  });
  check(
    "still a duplicate within its own campaign",
    sameCampaign.body?.data?.summary?.duplicates === 1,
    JSON.stringify(sameCampaign.body?.data?.summary),
  );
}

console.log("\n4. in-file duplicates still caught");
{
  const stamp = String(Date.now());
  const preview = await api("/api/v1/import/clients/preview", {
    method: "POST",
    body: JSON.stringify({
      entity: "clients",
      rows: [
        { domain: `dup-${stamp}.test`, name: "One" },
        { domain: `DUP-${stamp}.TEST`, name: "Two" },
      ],
      duplicateStrategy: "skip",
    }),
  });
  const summary = preview.body?.data?.summary;
  check("case-insensitive in-file duplicate caught", summary?.errors === 1, JSON.stringify(summary));
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
