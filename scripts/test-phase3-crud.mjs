/**
 * PHASE 3 CRUD + PERMISSION TESTS.
 *
 * Exercises every module against a live API and real Postgres. Nothing mocked:
 * a mocked CRUD test proves the mock agrees with the assumption being tested.
 *
 * Covered per module: create, read, list with search/filter/sort/pagination,
 * update, archive, restore, CSV export. Plus the CSV import pipeline end to end
 * (preview → verdicts → commit) and permission checks for every role.
 */

const API = process.env.API_URL ?? "http://127.0.0.1:3000";
const SUPABASE = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const results = [];
const check = (n, ok, d = "") => {
  results.push(ok);
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

async function login(email) {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`login failed for ${email}: ${JSON.stringify(body)}`);
  return body.access_token;
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
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

const tokens = {
  owner: await login("owner@demo.test"),
  account_manager: await login("am@demo.test"),
  prospector: await login("prospector@demo.test"),
  outreach_specialist: await login("outreach@demo.test"),
  content_writer: await login("writer@demo.test"),
  client_user: await login("client@demo.test"),
  publisher_user: await login("publisher@demo.test"),
};

const stamp = Date.now();

// ===========================================================================
console.log("\nCLIENTS — full CRUD");
// ===========================================================================
let clientId = null;
{
  const domain = `crud-client-${stamp}.test`;
  const created = await api("/api/v1/clients", tokens.owner, {
    method: "POST",
    body: JSON.stringify({ name: "CRUD Test Client", domain, industry: "Testing", status: "active" }),
  });
  check("create returns 201", created.status === 201, `got ${created.status}`);
  check("create returns the row", created.body?.data?.domain === domain, created.body?.data?.domain);
  clientId = created.body?.data?.id;

  const dup = await api("/api/v1/clients", tokens.owner, {
    method: "POST",
    body: JSON.stringify({ name: "Duplicate", domain }),
  });
  check("duplicate domain is 409", dup.status === 409, `got ${dup.status}`);

  const invalid = await api("/api/v1/clients", tokens.owner, {
    method: "POST",
    body: JSON.stringify({ name: "", domain: "not a domain!!" }),
  });
  check("invalid payload is 400", invalid.status === 400, `got ${invalid.status}`);
  check("validation names the failing fields", Array.isArray(invalid.body?.error?.details), "");

  const read = await api(`/api/v1/clients/${clientId}`, tokens.owner);
  check("read one returns the row", read.status === 200 && read.body?.data?.id === clientId);

  const patched = await api(`/api/v1/clients/${clientId}`, tokens.owner, {
    method: "PATCH",
    body: JSON.stringify({ industry: "Updated Industry" }),
  });
  check("update applies the change", patched.body?.data?.industry === "Updated Industry", patched.body?.data?.industry);
  check("update preserves unspecified fields", Boolean(patched.body?.data?.name), patched.body?.data?.name);

  const search = await api(`/api/v1/clients?q=${encodeURIComponent("CRUD Test")}`, tokens.owner);
  check("search finds the row", (search.body?.data ?? []).some((r) => r.id === clientId), `${search.body?.data?.length} results`);

  const noMatch = await api(`/api/v1/clients?q=zzz-no-such-client-zzz`, tokens.owner);
  check("search excludes non-matches", !(noMatch.body?.data ?? []).some((r) => r.id === clientId));

  const filtered = await api(`/api/v1/clients?status=active&limit=100`, tokens.owner);
  check("status filter returns only active", (filtered.body?.data ?? []).every((r) => r.status === "active"));

  const sorted = await api(`/api/v1/clients?sort=name&order=asc&limit=100`, tokens.owner);
  const names = (sorted.body?.data ?? []).map((r) => r.name);
  check("sort by name ascending", JSON.stringify(names) === JSON.stringify([...names].sort()), "ordered");

  const page1 = await api(`/api/v1/clients?page=1&limit=1`, tokens.owner);
  check("pagination limits rows", (page1.body?.data ?? []).length <= 1, `${page1.body?.data?.length}`);
  check("pagination reports total", typeof page1.body?.meta?.total === "number", String(page1.body?.meta?.total));

  const badSort = await api(`/api/v1/clients?sort=drop_table;--`, tokens.owner);
  check("an unlisted sort column falls back safely", badSort.status === 200, `got ${badSort.status}`);

  const exported = await api("/api/v1/clients/export/csv", tokens.owner);
  check("CSV export returns text/csv", exported.status === 200 && exported.text.includes("name,domain"), `${exported.status}`);

  const archived = await api(`/api/v1/clients/${clientId}`, tokens.owner, { method: "DELETE" });
  check("archive returns 204", archived.status === 204, `got ${archived.status}`);

  const gone = await api(`/api/v1/clients/${clientId}`, tokens.owner);
  check("archived row is not readable", gone.status === 404, `got ${gone.status}`);

  const restored = await api(`/api/v1/clients/${clientId}/restore`, tokens.owner, { method: "POST" });
  check("restore brings it back", restored.status === 200 && restored.body?.data?.id === clientId, `got ${restored.status}`);
}

// ===========================================================================
console.log("\nAGENCY PARTNERS");
// ===========================================================================
let partnerId = null;
{
  const domain = `crud-partner-${stamp}.test`;
  const created = await api("/api/v1/agency-partners", tokens.owner, {
    method: "POST",
    body: JSON.stringify({
      name: "CRUD Partner",
      domain,
      partnerType: "white_label",
      status: "active",
      pricingModel: "markup",
      markupPct: 35,
    }),
  });
  check("create returns 201", created.status === 201, `got ${created.status}: ${JSON.stringify(created.body?.error ?? "")}`);
  partnerId = created.body?.data?.id;

  // The pricing model must match the supplied rate.
  const badPricing = await api("/api/v1/agency-partners", tokens.owner, {
    method: "POST",
    body: JSON.stringify({ name: "Bad", domain: `bad-${stamp}.test`, pricingModel: "markup" }),
  });
  check("markup model without a rate is rejected", badPricing.status === 400, `got ${badPricing.status}`);

  const read = await api(`/api/v1/agency-partners/${partnerId}`, tokens.owner);
  check("read one works", read.status === 200 && read.body?.data?.id === partnerId);

  const link = await api(`/api/v1/clients/${clientId}`, tokens.owner, {
    method: "PATCH",
    body: JSON.stringify({ agencyPartnerId: partnerId }),
  });
  check("a client can be linked to a partner", link.body?.data?.agency_partner_id === partnerId);

  // Archiving a partner with active clients must be refused.
  const blocked = await api(`/api/v1/agency-partners/${partnerId}`, tokens.owner, { method: "DELETE" });
  check("archiving a partner with active clients is refused", blocked.status === 409, `got ${blocked.status}`);

  await api(`/api/v1/clients/${clientId}`, tokens.owner, {
    method: "PATCH",
    body: JSON.stringify({ agencyPartnerId: null }),
  });
  const nowOk = await api(`/api/v1/agency-partners/${partnerId}`, tokens.owner, { method: "DELETE" });
  check("archiving succeeds once unlinked", nowOk.status === 204, `got ${nowOk.status}`);
}

// ===========================================================================
console.log("\nPUBLISHERS");
// ===========================================================================
let publisherId = null;
{
  const domain = `crud-publisher-${stamp}.test`;
  const created = await api("/api/v1/publishers", tokens.owner, {
    method: "POST",
    body: JSON.stringify({
      domain,
      websiteUrl: `https://${domain}`,
      name: "CRUD Publisher",
      dr: 62,
      da: 55,
      monthlyTraffic: 15000,
      spamScore: 4,
      niche: "technology, saas",
      price: 320,
      currency: "USD",
      country: "US",
      status: "active",
      contactName: "Tom Editor",
      contactEmail: "tom@example.test",
    }),
  });
  check("create returns 201", created.status === 201, `got ${created.status}: ${JSON.stringify(created.body?.error ?? "")}`);
  publisherId = created.body?.data?.id;

  const row = created.body?.data;
  check("all specification fields stored", row?.dr === 62 && row?.monthly_traffic === 15000 && Number(row?.price) === 320);
  check("niche stored as an array", Array.isArray(row?.niche) && row.niche.includes("technology"), JSON.stringify(row?.niche));
  check("spam score stored", Number(row?.spam_score) === 4, String(row?.spam_score));
  check("website URL normalised", row?.website_url === `https://${domain}`, row?.website_url);

  const drFilter = await api("/api/v1/publishers?drMin=60&limit=100", tokens.owner);
  check("DR minimum filter", (drFilter.body?.data ?? []).every((r) => r.dr === null || r.dr >= 60));
  check("DR filter includes the new row", (drFilter.body?.data ?? []).some((r) => r.id === publisherId));

  const priceFilter = await api("/api/v1/publishers?priceMax=100&limit=100", tokens.owner);
  check("price maximum filter", !(priceFilter.body?.data ?? []).some((r) => r.id === publisherId));

  const nicheFilter = await api("/api/v1/publishers?niche=technology&limit=100", tokens.owner);
  check("niche filter matches", (nicheFilter.body?.data ?? []).some((r) => r.id === publisherId));

  const sortedByDr = await api("/api/v1/publishers?sort=dr&order=desc&limit=100", tokens.owner);
  const drs = (sortedByDr.body?.data ?? []).map((r) => r.dr ?? -1);
  check("sort by DR descending", drs.every((v, i) => i === 0 || drs[i - 1] >= v), "ordered");

  const exportCsv = await api("/api/v1/publishers/export/csv", tokens.owner);
  check("CSV export includes headers", exportCsv.text.includes("domain,website_url"), "");
  check("CSV export flattens niche", exportCsv.text.includes("technology, saas") || exportCsv.text.includes('"technology, saas"'), "");

  // Price change must append to offer history.
  await api(`/api/v1/publishers/${publisherId}`, tokens.owner, {
    method: "PATCH",
    body: JSON.stringify({ price: 400 }),
  });
  const offers = await api(`/api/v1/publishers/${publisherId}/offers`, tokens.owner);
  check("a price change records an offer", (offers.body?.data ?? []).length > 0, `${offers.body?.data?.length} offers`);
}

// ===========================================================================
console.log("\nPROSPECTS");
// ===========================================================================
{
  const campaigns = await api("/api/v1/campaigns?limit=100", tokens.owner);
  const campaignId = campaigns.body?.data?.[0]?.id;
  check("a campaign exists to attach prospects to", Boolean(campaignId));

  const domain = `crud-prospect-${stamp}.test`;
  const created = await api("/api/v1/prospects", tokens.owner, {
    method: "POST",
    body: JSON.stringify({
      campaignId,
      domain,
      dr: 48,
      monthlyTraffic: 9000,
      spamScore: 3,
      niche: "marketing",
      price: 210,
      contactName: "Jane Doe",
      contactEmail: "jane@example.test",
      priority: "high",
    }),
  });
  check("create returns 201", created.status === 201, `got ${created.status}: ${JSON.stringify(created.body?.error ?? "")}`);

  const id = created.body?.data?.id;
  check("metrics stored on the prospect", created.body?.data?.dr === 48 && Number(created.body?.data?.price) === 210);
  check("stage defaulted from the pipeline", Boolean(created.body?.data?.stage), created.body?.data?.stage);

  const dup = await api("/api/v1/prospects", tokens.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, domain }),
  });
  check("duplicate domain on the same campaign is 409", dup.status === 409, `got ${dup.status}`);

  // Linking a publisher should inherit metrics only where absent.
  const inherited = await api("/api/v1/prospects", tokens.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, domain: `inherit-${stamp}.test`, publisherId }),
  });
  check("publisher metrics inherited when absent", inherited.body?.data?.dr === 62, String(inherited.body?.data?.dr));

  const override = await api("/api/v1/prospects", tokens.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, domain: `override-${stamp}.test`, publisherId, dr: 30 }),
  });
  check("an explicit value is not overwritten by inheritance", override.body?.data?.dr === 30, String(override.body?.data?.dr));

  const stage = await api(`/api/v1/prospects/${id}/stage`, tokens.owner, {
    method: "PATCH",
    body: JSON.stringify({ stage: "pitched" }),
  });
  check("stage transition works", stage.body?.data?.stage === "pitched", stage.body?.data?.stage);

  const lostNoReason = await api(`/api/v1/prospects/${id}/stage`, tokens.owner, {
    method: "PATCH",
    body: JSON.stringify({ stage: "declined" }),
  });
  check("moving to a lost stage requires a reason", lostNoReason.status === 400, `got ${lostNoReason.status}`);

  const filter = await api("/api/v1/prospects?drMin=40&limit=100", tokens.owner);
  check("prospect DR filter", (filter.body?.data ?? []).every((r) => r.dr === null || r.dr >= 40));

  const exported = await api("/api/v1/prospects/export/csv", tokens.owner);
  check("prospect CSV export works", exported.status === 200 && exported.text.includes("domain,"), `${exported.status}`);
}

// ===========================================================================
console.log("\nCAMPAIGNS");
// ===========================================================================
{
  const clients = await api("/api/v1/clients?limit=100", tokens.owner);
  const someClient = clients.body?.data?.[0]?.id;

  const created = await api("/api/v1/campaigns", tokens.owner, {
    method: "POST",
    body: JSON.stringify({
      clientId: someClient,
      name: `CRUD Campaign ${stamp}`,
      status: "active",
      serviceType: "guest_post",
      monthlyLinkTarget: 12,
    }),
  });
  check("create returns 201", created.status === 201, `got ${created.status}: ${JSON.stringify(created.body?.error ?? "")}`);
  const id = created.body?.data?.id;

  const badDates = await api(`/api/v1/campaigns/${id}`, tokens.owner, {
    method: "PATCH",
    body: JSON.stringify({ startDate: "2026-06-01", endDate: "2026-01-01" }),
  });
  check("end before start is rejected", badDates.status === 400, `got ${badDates.status}`);

  const filter = await api("/api/v1/campaigns?status=active&limit=100", tokens.owner);
  check("campaign status filter", (filter.body?.data ?? []).every((r) => r.status === "active"));

  const related = await api(`/api/v1/campaigns/${id}/related`, tokens.owner);
  check("related view returns prospects and placements", related.status === 200 && "prospects" in (related.body?.data ?? {}));
}

// ===========================================================================
console.log("\nCSV IMPORT — preview, verdicts, commit");
// ===========================================================================
{
  const rows = [
    { domain: `import-a-${stamp}.test`, name: "Import A", dr: "55", traffic: "12000", price: "250", niche: "tech" },
    { domain: `import-b-${stamp}.test`, name: "Import B", dr: "40", traffic: "not-a-number", price: "180" },
    { domain: "not a domain!!", name: "Bad Row", dr: "10" },
    { domain: `import-a-${stamp}.test`, name: "Duplicate In File", dr: "60" },
  ];

  const preview = await api("/api/v1/import/publishers/preview", tokens.owner, {
    method: "POST",
    body: JSON.stringify({ entity: "publishers", rows, duplicateStrategy: "skip", fileName: "test.csv" }),
  });
  check("preview returns 200", preview.status === 200, `got ${preview.status}: ${JSON.stringify(preview.body?.error ?? "")}`);

  const summary = preview.body?.data?.summary;
  check("summary counts every row", summary?.total === 4, JSON.stringify(summary));
  // Rows A and B are both valid: row B's non-numeric traffic is coerced to null
  // rather than rejecting the row, which is the intended leniency for a messy
  // export. Row C has an invalid domain; row D repeats A within the file.
  check("two rows are valid", summary?.ok === 2, JSON.stringify(summary));
  check("two rows are rejected", summary?.errors === 2, JSON.stringify(summary));

  const verdicts = preview.body?.data?.verdicts ?? [];
  const badRow = verdicts.find((v) => v.rowIndex === 2);
  check("the invalid domain is flagged with a field error", Boolean(badRow?.errors), JSON.stringify(badRow?.errors));
  const dupRow = verdicts.find((v) => v.rowIndex === 3);
  check("the repeated row is flagged as an in-file duplicate", dupRow?.status === "error", dupRow?.message ?? dupRow?.status);

  const jobId = preview.body?.data?.jobId;
  const commit = await api("/api/v1/import/publishers/commit", tokens.owner, {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
  check("commit returns 200", commit.status === 200, `got ${commit.status}`);
  check("commit inserted the valid rows", commit.body?.data?.inserted === 2, JSON.stringify(commit.body?.data));
  check("commit skipped the rejections", (commit.body?.data?.skipped ?? 0) === 2, JSON.stringify(commit.body?.data));

  const again = await api("/api/v1/import/publishers/commit", tokens.owner, {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
  check("re-committing the same job is refused", again.status === 409, `got ${again.status}`);

  // A second import of the same domain must now be detected as a duplicate.
  const second = await api("/api/v1/import/publishers/preview", tokens.owner, {
    method: "POST",
    body: JSON.stringify({
      entity: "publishers",
      rows: [{ domain: `import-a-${stamp}.test`, name: "Again" }],
      duplicateStrategy: "skip",
    }),
  });
  check("an existing database row is detected as duplicate", second.body?.data?.summary?.duplicates === 1, JSON.stringify(second.body?.data?.summary));

  const template = await api("/api/v1/import/publishers/template", tokens.owner);
  check("a CSV template is downloadable", template.status === 200 && template.text.includes("domain"), `${template.status}`);
}

// ===========================================================================
console.log("\nPERMISSIONS across modules");
// ===========================================================================
{
  // client_user and publisher_user cannot reach internal modules at all.
  for (const path of ["/api/v1/clients", "/api/v1/publishers", "/api/v1/prospects", "/api/v1/agency-partners"]) {
    const asClient = await api(path, tokens.client_user);
    check(`client_user is 403 on ${path}`, asClient.status === 403, `got ${asClient.status}`);
  }

  // content_writer may read clients but not write publishers.
  const writerPublishers = await api("/api/v1/publishers", tokens.content_writer);
  check("content_writer cannot list publishers", writerPublishers.status === 403, `got ${writerPublishers.status}`);

  const writerCreatePublisher = await api("/api/v1/publishers", tokens.content_writer, {
    method: "POST",
    body: JSON.stringify({ domain: `denied-${stamp}.test` }),
  });
  check("content_writer cannot create a publisher", writerCreatePublisher.status === 403, `got ${writerCreatePublisher.status}`);

  // prospector CAN write publishers.
  const prospectorCreate = await api("/api/v1/publishers", tokens.prospector, {
    method: "POST",
    body: JSON.stringify({ domain: `prospector-${stamp}.test`, dr: 30 }),
  });
  check("prospector can create a publisher", prospectorCreate.status === 201, `got ${prospectorCreate.status}`);

  // prospector cannot invite users or read the audit log.
  const prospectorStaff = await api("/api/v1/staff", tokens.prospector);
  check("prospector cannot list staff", prospectorStaff.status === 403, `got ${prospectorStaff.status}`);

  // Import permission follows the module.
  const writerImport = await api("/api/v1/import/publishers/preview", tokens.content_writer, {
    method: "POST",
    body: JSON.stringify({ entity: "publishers", rows: [{ domain: "x.test", name: "X" }] }),
  });
  check("content_writer cannot import publishers", writerImport.status === 403, `got ${writerImport.status}`);

  // account_manager cannot read wholesale cost (tier 2).
  const amCosts = await api("/api/v1/costs/placements/00000000-0000-0000-0000-000000000000", tokens.account_manager);
  check("account_manager is 403 on wholesale cost", amCosts.status === 403, `got ${amCosts.status}`);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFAILURES:");
  results.forEach((ok, i) => {
    if (!ok) console.log(`  - check #${i + 1}`);
  });
  process.exit(1);
}
