/**
 * Round-trip and related-record probes.
 *
 * The brief asks for CSV import AND export. An export that cannot be re-imported
 * is a support ticket generator, so this checks the round trip explicitly.
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

const api = async (p, o = {}) => {
  const x = await fetch(`http://127.0.0.1:3000${p}`, {
    ...o,
    headers: { authorization: `Bearer ${T}`, "content-type": "application/json", ...(o.headers ?? {}) },
  });
  // Read the text ONCE and derive the parsed body from it: awaiting both
  // .json() and .text() on the same response fails, the body can only be
  // consumed once.
  const text = await x.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: x.status, body, text };
};

/** Minimal RFC-4180 reader so the round trip is tested with real parsing. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch === "\r") { /* handled by \n */ }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const clean = rows.filter((x) => x.some((c) => c.trim() !== ""));
  const headers = clean[0].map((h) => h.trim());
  return clean.slice(1).map((cells) =>
    Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? "").trim()])),
  );
}

console.log("\npublishers CSV round trip");
{
  const exported = await api("/api/v1/publishers/export/csv");
  check("export succeeded", exported.status === 200, `${exported.status}`);

  const rows = parseCsv(exported.text);
  check("export produced rows", rows.length > 0, `${rows.length} rows`);

  // Re-import the exported rows with the update strategy: every row should be
  // recognised as an existing publisher, not as new.
  const preview = await api("/api/v1/import/publishers/preview", {
    method: "POST",
    body: JSON.stringify({ entity: "publishers", rows, duplicateStrategy: "skip" }),
  });

  const summary = preview.body?.data?.summary;
  check("every exported row is recognised as existing", summary?.ok === 0, JSON.stringify(summary));
  check("no exported row is treated as a parse error", summary?.errors === 0, JSON.stringify(summary));
  check(
    "rows matched as duplicates",
    summary?.duplicates === rows.length,
    `${summary?.duplicates} of ${rows.length}`,
  );

  // The niche array must survive the export/import cycle.
  const withNiche = rows.find((x) => (x.niche ?? "").includes(","));
  check("niche arrays are flattened for CSV", Boolean(withNiche), withNiche?.niche ?? "no multi-niche row");
}

console.log("\nclients CSV round trip");
{
  const exported = await api("/api/v1/clients/export/csv");
  const rows = parseCsv(exported.text);
  check("export produced rows", rows.length > 0, `${rows.length}`);

  const preview = await api("/api/v1/import/clients/preview", {
    method: "POST",
    body: JSON.stringify({ entity: "clients", rows, duplicateStrategy: "skip" }),
  });
  const summary = preview.body?.data?.summary;
  check("round-tripped clients are all recognised", summary?.ok === 0 && summary?.errors === 0, JSON.stringify(summary));
}

console.log("\nrelated-record views");
{
  const clients = await api("/api/v1/clients?limit=1");
  const clientId = clients.body.data[0].id;
  const related = await api(`/api/v1/clients/${clientId}/related`);
  check("client related view returns all three collections",
    related.status === 200 && "campaigns" in related.body.data && "placements" in related.body.data && "invoices" in related.body.data,
    `${related.status}`);
  check("related view reports counts", typeof related.body?.data?.counts?.campaigns === "number");

  const camps = await api("/api/v1/campaigns?limit=1");
  const campId = camps.body.data[0].id;
  const campRelated = await api(`/api/v1/campaigns/${campId}/related`);
  check("campaign related view works", campRelated.status === 200 && "prospects" in campRelated.body.data, `${campRelated.status}`);

  const pubs = await api("/api/v1/publishers?limit=1");
  const pubId = pubs.body.data[0].id;
  const pubRelated = await api(`/api/v1/publishers/${pubId}/related`);
  check("publisher related view works", pubRelated.status === 200 && "prospects" in pubRelated.body.data, `${pubRelated.status}`);

  const pros = await api("/api/v1/prospects?limit=1");
  const prosId = pros.body.data[0].id;
  const prosRelated = await api(`/api/v1/prospects/${prosId}/related`);
  check("prospect related view works", prosRelated.status === 200 && "touchpoints" in prosRelated.body.data, `${prosRelated.status}`);
}

console.log("\nsort allowlist and injection safety");
{
  for (const bad of ["drop table clients", "'; --", "id; select 1", "created_at desc, (select 1)"]) {
    const res = await api(`/api/v1/clients?sort=${encodeURIComponent(bad)}`);
    check(`sort "${bad.slice(0, 20)}" is neutralised`, res.status === 200, `${res.status}`);
  }

  const searchInjection = await api(`/api/v1/clients?q=${encodeURIComponent("' or 1=1 --")}`);
  check("search term with SQL metacharacters is safe", searchInjection.status === 200, `${searchInjection.status}`);
  check(
    "injection search does not return everything",
    (searchInjection.body?.data ?? []).length < 10,
    `${searchInjection.body?.data?.length} rows`,
  );

  const commaSearch = await api(`/api/v1/clients?q=${encodeURIComponent("a,b(c)")}`);
  check("search term with PostgREST metacharacters does not error", commaSearch.status === 200, `${commaSearch.status}`);
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
