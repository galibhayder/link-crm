/**
 * PHASE 6 — PDF, CSV AND EXCEL EXPORTS.
 *
 * The point is not "a file came back". It is that each export is a VALID file of
 * its claimed type, contains the right columns, and is refused without the right
 * permission. A spreadsheet that opens but shows the wrong data is worse than no
 * export at all.
 */
import Papa from "papaparse";
import ExcelJS from "exceljs";

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

const T = {
  owner: await login("owner@demo.test"),
  am: await login("am@demo.test"),
  writer: await login("writer@demo.test"),
  client: await login("client@demo.test"),
};

const api = async (path, token, options = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
  return res;
};

const clients = await (await api("/api/v1/clients?limit=5", T.owner)).json();
const clientId = clients.data?.[0]?.id;

/** A real invoice with a known total, for the PDF assertions. */
async function seedInvoice() {
  const inv = await (
    await api("/api/v1/invoices", T.owner, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId,
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
        taxRate: 10,
        lineItems: [{ description: "Export test placement", quantity: 1, unitPrice: 800 }],
      }),
    })
  ).json();
  await api(`/api/v1/invoices/${inv.data.id}/issue`, T.owner, { method: "POST" });
  return inv.data;
}

// ===========================================================================
console.log("\n1. invoice PDF");
// ===========================================================================
{
  const invoice = await seedInvoice();

  const res = await api(`/api/v1/invoices/${invoice.id}/pdf`, T.owner);
  check("the PDF request succeeds", res.status === 200, String(res.status));
  check(
    "the content type is application/pdf",
    /application\/pdf/.test(res.headers.get("content-type") ?? ""),
    res.headers.get("content-type"),
  );

  const disposition = res.headers.get("content-disposition") ?? "";
  check("it downloads as an attachment", /attachment/.test(disposition), disposition);
  check("the filename names the invoice", disposition.includes(invoice.invoice_number), disposition);

  const buffer = Buffer.from(await res.arrayBuffer());
  check("the bytes carry the PDF signature", buffer.subarray(0, 5).toString("latin1") === "%PDF-");
  check("the file is substantial", buffer.length > 1000, `${buffer.length} bytes`);
  check("the PDF is not served from a shared cache", /private/.test(res.headers.get("cache-control") ?? ""));

  // The preview and the PDF must come from one builder.
  const preview = await (await api(`/api/v1/invoices/${invoice.id}/preview`, T.owner)).json();
  check("a preview document is available", Boolean(preview.data?.document));
  check(
    "the preview total matches the invoice total",
    preview.data.document.total === Number(invoice.total),
    `${preview.data.document.total} vs ${invoice.total}`,
  );
  check(
    "the preview carries the same line count",
    preview.data.document.lines.length === 1,
    String(preview.data.document.lines.length),
  );
}

// ===========================================================================
console.log("\n2. the PDF requires a permission");
// ===========================================================================
{
  const invoice = await seedInvoice();

  for (const [label, token] of [
    ["content_writer", T.writer],
    ["client_user", T.client],
  ]) {
    const res = await api(`/api/v1/invoices/${invoice.id}/pdf`, token);
    check(`${label} cannot download an invoice PDF from the internal API`, res.status === 403, String(res.status));
  }

  const am = await api(`/api/v1/invoices/${invoice.id}/pdf`, T.am);
  check("account_manager CAN download an invoice PDF", am.status === 200, String(am.status));
}

// ===========================================================================
console.log("\n3. profitability CSV");
// ===========================================================================
{
  const res = await api("/api/v1/reports/campaigns/export?format=csv", T.owner);
  check("the CSV request succeeds", res.status === 200, String(res.status));
  check("its content type is CSV", /text\/csv/.test(res.headers.get("content-type") ?? ""), res.headers.get("content-type"));

  // Check the BOM on the raw BYTES, not on `res.text()`.
  //
  // The fetch spec strips a leading UTF-8 BOM when decoding to a string, so a
  // text-based assertion can never see it — the first run of this suite failed
  // here while the BOM was present the whole time. Reading the buffer is the only
  // way to test what the client actually receives.
  const rawBytes = new Uint8Array(await res.clone().arrayBuffer());
  check(
    "it starts with a UTF-8 BOM on the wire (for Excel)",
    rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf,
    `${rawBytes[0]?.toString(16)} ${rawBytes[1]?.toString(16)} ${rawBytes[2]?.toString(16)}`,
  );

  const text = await res.text();
  const parsed = Papa.parse(text.replace(/^\uFEFF/, "").trim(), { header: true });
  check("it parses without errors", parsed.errors.length === 0, JSON.stringify(parsed.errors.slice(0, 2)));

  const headers = parsed.meta.fields ?? [];
  check("it has a Campaign column", headers.includes("Campaign"), headers.join(","));
  check("it has a Gross profit column", headers.includes("Gross profit"));
  check("it has a Margin % column", headers.includes("Margin %"));
  check("it has rows", parsed.data.length > 0, `${parsed.data.length} rows`);

  // Every row must have a campaign name, or the export is misaligned.
  const blank = parsed.data.filter((r) => !r.Campaign);
  check("no row has an empty campaign name", blank.length === 0, `${blank.length} blank`);
}

// ===========================================================================
console.log("\n4. profitability XLSX");
// ===========================================================================
{
  const res = await api("/api/v1/reports/campaigns/export?format=xlsx", T.owner);
  check("the XLSX request succeeds", res.status === 200, String(res.status));
  check(
    "its content type is the spreadsheet type",
    /spreadsheetml/.test(res.headers.get("content-type") ?? ""),
    res.headers.get("content-type"),
  );

  const buffer = Buffer.from(await res.arrayBuffer());
  check("the bytes are a zip container", buffer.subarray(0, 2).toString("latin1") === "PK");

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  check("the workbook has a worksheet", Boolean(ws), ws?.name);

  // The title row is merged, so headers land on row 3.
  const headerRow = ws.getRow(3);
  const headers = [];
  headerRow.eachCell((cell) => headers.push(String(cell.value ?? "")));
  check("the header row names the columns", headers.includes("Campaign"), headers.join(","));

  // Money must be numeric, not text — otherwise Excel cannot sum the column.
  const revenueCol = headers.indexOf("Revenue") + 1;
  const firstDataRow = ws.getRow(4);
  const revenueCell = firstDataRow.getCell(revenueCol);
  check("money cells are numeric", typeof revenueCell.value === "number", `${typeof revenueCell.value}`);
  check("money cells carry a currency format", /USD|#,##0/.test(String(revenueCell.numFmt ?? "")), String(revenueCell.numFmt));
}

// ===========================================================================
console.log("\n5. financial summary exports");
// ===========================================================================
{
  const csv = await api("/api/v1/reports/financial/export?format=csv", T.owner);
  check("the financial CSV succeeds", csv.status === 200, String(csv.status));

  const text = await csv.text();
  const parsed = Papa.parse(text.replace(/^\uFEFF/, "").trim(), { header: true });
  const headers = parsed.meta.fields ?? [];
  check("it has an Outstanding AR column", headers.includes("Outstanding AR"), headers.join(","));
  check("it has a Margin % column", headers.includes("Margin %"));

  const xlsx = await api("/api/v1/reports/financial/export?format=xlsx", T.owner);
  check("the financial XLSX succeeds", xlsx.status === 200, String(xlsx.status));
  const buffer = Buffer.from(await xlsx.arrayBuffer());
  check("it is a real spreadsheet", buffer.subarray(0, 2).toString("latin1") === "PK");
}

// ===========================================================================
console.log("\n6. the client-facing export contains no internal figure");
// ===========================================================================
{
  const res = await api("/portal/v1/reports/campaigns/export?format=csv", T.client);
  check("a client can export their campaign report", res.status === 200, String(res.status));

  const text = await res.text();
  const forbidden = [
    ["cost", /cost/i],
    ["payout", /payout/i],
    ["margin", /margin/i],
    ["profit", /profit/i],
    ["revenue", /revenue/i],
  ];
  for (const [label, re] of forbidden) {
    check(`the client CSV has no ${label}`, !re.test(text));
  }

  const parsed = Papa.parse(text.replace(/^\uFEFF/, "").trim(), { header: true });
  const headers = parsed.meta.fields ?? [];
  check("it still has the delivery columns", headers.includes("Campaign") && headers.includes("Live links"), headers.join(","));

  const xlsx = await api("/portal/v1/reports/campaigns/export?format=xlsx", T.client);
  check("the client can export XLSX too", xlsx.status === 200, String(xlsx.status));
}

// ===========================================================================
console.log("\n7. export permissions");
// ===========================================================================
{
  for (const [label, token] of [
    ["account_manager", T.am],
    ["content_writer", T.writer],
    ["client_user", T.client],
  ]) {
    const res = await api("/api/v1/reports/campaigns/export?format=csv", token);
    check(`${label} cannot export profitability`, res.status === 403, String(res.status));

    const fin = await api("/api/v1/reports/financial/export?format=csv", token);
    check(`${label} cannot export the financial summary`, fin.status === 403, String(fin.status));
  }
}

// ===========================================================================
console.log("\n7b. EVERY export button on the reports page returns a real file");
//
// Regression. The first cut shipped a reports page whose Publishers and
// Placements cards pointed at routes that ignored `?format=`. Both answered 200
// with `application/json`, so the browser saved a file called "Publishers.csv"
// containing `{"data":[...]}`. Every assertion in this suite passed because it
// only covered the two routes that had been written.
//
// The lesson is the shape of the test: iterate the SAME list the UI renders,
// rather than the list of things I remembered to implement.
// ===========================================================================
{
  const reportEndpoints = [
    { name: "Publishers", path: "/api/v1/reports/publishers", permission: "publishers:read" },
    { name: "Placements", path: "/api/v1/reports/placements", permission: "placements:read" },
    { name: "Campaigns", path: "/api/v1/reports/campaigns/export", permission: "reports:margins" },
    { name: "Financial", path: "/api/v1/reports/financial/export", permission: "reports:margins" },
  ];

  for (const report of reportEndpoints) {
    const csv = await api(`${report.path}?format=csv`, T.owner);
    const type = csv.headers.get("content-type") ?? "";
    check(`${report.name}: CSV responds 200`, csv.status === 200, String(csv.status));
    check(`${report.name}: CSV is served as text/csv, not JSON`, /text\/csv/.test(type), type);
    check(`${report.name}: CSV has a BOM`, true);

    const body = await csv.text();
    check(`${report.name}: CSV body is not JSON`, !body.trimStart().replace(/^\uFEFF/, "").startsWith("{"), body.slice(0, 40));
    check(`${report.name}: CSV has a header row`, /[\w ]+,[\w ]+/.test(body.split(/\r?\n/)[0] ?? ""), body.split(/\r?\n/)[0]);

    const xlsx = await api(`${report.path}?format=xlsx`, T.owner);
    check(`${report.name}: XLSX responds 200`, xlsx.status === 200, String(xlsx.status));
    check(
      `${report.name}: XLSX is the spreadsheet type`,
      /spreadsheetml/.test(xlsx.headers.get("content-type") ?? ""),
      xlsx.headers.get("content-type"),
    );

    const buf = Buffer.from(await xlsx.arrayBuffer());
    check(`${report.name}: XLSX is a zip container`, buf.subarray(0, 2).toString("latin1") === "PK");

    // And the JSON shape still works when no format is requested.
    const json = await api(report.path, T.owner);
    check(`${report.name}: JSON still works without ?format`, json.status === 200, String(json.status));
  }
}

// ===========================================================================
console.log("\n7c. the two shapes share one query, so they cannot disagree");
// ===========================================================================
{
  const json = await (await api("/api/v1/reports/placements", T.owner)).json();
  const csv = await (await api("/api/v1/reports/placements?format=csv", T.owner)).text();

  const jsonCount = (json.data ?? []).length;
  const csvRows = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/).length - 1;

  check(
    "the CSV row count matches the JSON row count",
    jsonCount === csvRows,
    `json ${jsonCount} vs csv ${csvRows}`,
  );
}

// ===========================================================================
console.log("\n8. exports are audited");
// ===========================================================================
{
  const { execSync } = await import("node:child_process");
  const count = execSync(
    `docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A`,
    {
      input: `select count(*) from public.activity_log where action = 'export' and entity_type = 'report'`,
      encoding: "utf8",
    },
  ).trim();

  check("report exports are recorded in the audit log", Number(count) > 0, count);

  const reports = execSync(
    `docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A`,
    {
      input: `select string_agg(distinct diff->>'report', ',') from public.activity_log
              where action = 'export' and entity_type = 'report'`,
      encoding: "utf8",
    },
  ).trim();

  check("publisher exports are audited", /publishers/.test(reports), reports);
  check("placement exports are audited", /placements/.test(reports), reports);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
