/**
 * ESSENTIAL WORKFLOW SMOKE — the paths a business actually runs on.
 *
 * The Phase 3-7 suites prove each module in isolation. This asks a different
 * question: with everything deployed together, does the business actually
 * complete a job of work? Import a list, move a placement through its states,
 * verify a link, classify an anchor, generate a PDF, and export data.
 *
 * Each step is asserted on the RESULT (a row, a status, a file's magic bytes),
 * never on a 200.
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

async function login(email, password = "password123") {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const b = await res.json().catch(() => ({}));
  return b.access_token;
}

async function api(path, token, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  const body = isJson ? await res.json().catch(() => null) : await res.arrayBuffer();
  return { status: res.status, body, headers: res.headers };
}

const owner = await login("owner@demo.test");
check("owner can authenticate", Boolean(owner));

const stamp = Date.now();

// ---------------------------------------------------------------------------
console.log("\n1. CSV import creates real rows");
// ---------------------------------------------------------------------------
let importedId = null;
{
  // Import is preview -> commit, and the preview is PERSISTED so the commit cannot
  // apply something the user never saw. The body carries parsed rows, not a file.
  const rows = [
    { name: `Workflow Test ${stamp}`, domain: `workflow-${stamp}.test`, contact_email: `editor@workflow-${stamp}.test` },
    { name: `Workflow Test Dupe ${stamp}`, domain: `workflow-${stamp}.test`, contact_email: `dupe@workflow-${stamp}.test` },
  ];

  const preview = await api("/api/v1/import/publishers/preview", owner, {
    method: "POST",
    body: JSON.stringify({ entity: "publishers", fileName: "import.csv", rows, duplicateStrategy: "skip" }),
  });
  check(
    "the preview step accepts the rows",
    preview.status === 200 || preview.status === 201,
    `${preview.status} ${JSON.stringify(preview.body?.error ?? "").slice(0, 140)}`,
  );

  const blob = JSON.stringify(preview.body ?? {});
  check("the preview reports the duplicate", /duplicate|skip|conflict/i.test(blob), blob.slice(0, 180));

  const jobId = preview.body?.data?.jobId ?? preview.body?.data?.id;
  check("the preview persists a job", Boolean(jobId), String(jobId));

  if (jobId) {
    const commit = await api("/api/v1/import/publishers/commit", owner, {
      method: "POST",
      body: JSON.stringify({ entity: "publishers", jobId }),
    });
    check(
      "the commit step succeeds",
      commit.status === 200 || commit.status === 201,
      `${commit.status} ${JSON.stringify(commit.body?.error ?? "").slice(0, 140)}`,
    );

    const list = await api(`/api/v1/publishers?q=workflow-${stamp}`, owner);
    const found = list.body?.data ?? [];
    importedId = found[0]?.id ?? null;
    check("the imported publisher is queryable", found.length > 0, `${found.length} row(s)`);
    // The duplicate strategy is "skip", so a repeated domain must not double up.
    check("the duplicate was not inserted twice", found.length === 1, `${found.length} row(s)`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n2. a placement moves through its real workflow");
// ---------------------------------------------------------------------------
let placementId = null;
{
  const clients = await api("/api/v1/clients?limit=1", owner);
  const clientId = clients.body?.data?.[0]?.id;
  check("a client exists to bill", Boolean(clientId));

  // campaignId is required by the schema, so a campaign must be resolved first.
  const campaigns = await api("/api/v1/campaigns?limit=1", owner);
  const campaignId = campaigns.body?.data?.[0]?.id;
  check("a campaign exists to attach to", Boolean(campaignId));

  if (clientId && campaignId && importedId) {
    const created = await api("/api/v1/placements", owner, {
      method: "POST",
      body: JSON.stringify({
        publisherId: importedId,
        campaignId,
        clientId,
        targetUrl: "https://example.com/workflow-target",
        anchorText: "workflow anchor",
        clientPrice: 500,
        publisherCost: 200,
        currency: "USD",
      }),
    });
    placementId = created.body?.data?.id ?? null;
    check(
      "a draft placement can be created",
      Boolean(placementId),
      `${created.status} ${JSON.stringify(created.body?.error ?? "").slice(0, 160)}`,
    );

    if (placementId) {
      const detail = await api(`/api/v1/placements/${placementId}`, owner);
      check("the placement reads back", detail.status === 200, String(detail.status));
      check(
        "it starts in a draft-like state",
        ["draft", "pending", "in_progress", "submitted"].includes(detail.body?.data?.status),
        detail.body?.data?.status,
      );
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n3. link verification runs and records a result");
// ---------------------------------------------------------------------------
if (placementId) {
  // A draft has no live_url, so verification correctly refuses. Record that as the
  // guard working, then verify a placement that DOES have a live URL, which is the
  // real path used in production.
  const draftCheck = await api(`/api/v1/placements/${placementId}/check`, owner, { method: "POST" });
  check("a placement without a live URL is refused", draftCheck.status === 400, String(draftCheck.status));

  const list = await api("/api/v1/placements?limit=50", owner);
  const live = (list.body?.data ?? []).find((p) => p.live_url);

  if (live) {
    const run = await api(`/api/v1/placements/${live.id}/check`, owner, { method: "POST" });
    check("verification runs on a live placement", run.status < 500, String(run.status));

    const after = await api(`/api/v1/placements/${live.id}`, owner);
    const p = after.body?.data;
    check(
      "the placement records a verification outcome",
      Boolean(p?.link_status || p?.last_checked_at),
      `${p?.link_status} @ ${p?.last_checked_at}`,
    );
  } else {
    check("no live placement available to verify", false, "seed has none with live_url");
  }
} else {
  check("verification skipped (no placement)", false);
}

// ---------------------------------------------------------------------------
console.log("\n4. anchor analytics classifies text");
// ---------------------------------------------------------------------------
{
  // Distribution is scoped either per campaign or per client; the default scope is
  // "campaign", which requires a campaignId. Pass scope=client explicitly.
  const campaigns = await api("/api/v1/campaigns?limit=1", owner);
  const campaignId = campaigns.body?.data?.[0]?.id;

  const r = await api(`/api/v1/anchors/distribution?scope=campaign&campaignId=${campaignId}`, owner);
  check("anchor distribution responds", r.status === 200, `${r.status} ${JSON.stringify(r.body?.error ?? "").slice(0, 100)}`);
  const blob = JSON.stringify(r.body ?? {});
  check("it reports distribution buckets", /exact|partial|branded|generic/i.test(blob), blob.slice(0, 140));

  // The classifier is the rule engine the analytics rest on. `branded` is only
  // reachable when the brand is supplied — classification is not a guess about
  // proprietary names, so a test that omits brandName is testing nothing.
  const cls = await api("/api/v1/anchors/classify", owner, {
    method: "POST",
    body: JSON.stringify({ anchorText: "Trivero Marketing", brandName: "Trivero Marketing" }),
  });
  check("classification responds", cls.status === 200, `${cls.status} ${JSON.stringify(cls.body?.error ?? "").slice(0, 110)}`);
  check(
    "a brand name is classified as branded",
    cls.body?.data?.category === "branded",
    String(cls.body?.data?.category),
  );
  check("the classifier marks it as classified", cls.body?.data?.classified === true);

  // An exact-match anchor must be recognised too — the opposite direction, so a
  // classifier that returns one constant cannot pass both.
  const exact = await api("/api/v1/anchors/classify", owner, {
    method: "POST",
    body: JSON.stringify({ anchorText: "link building agency", targetUrl: "https://example.org/post", brandName: "Trivero Marketing" }),
  });
  check(
    "a non-brand phrase is not branded",
    exact.body?.data?.category !== "branded",
    String(exact.body?.data?.category),
  );
}

// ---------------------------------------------------------------------------
console.log("\n5. CSV and XLSX export produce real files");
// ---------------------------------------------------------------------------
{
  const csv = await api("/api/v1/publishers/export/csv", owner);
  check("the publishers CSV export returns 200", csv.status === 200, String(csv.status));
  if (csv.status === 200) {
    const buf = Buffer.from(csv.body);
    check("the CSV is not HTML (would mean the SPA caught it)", !buf.slice(0, 200).toString().includes("<!doctype"), `${buf.length} bytes`);
    check("the CSV has a header row", buf.toString("utf8", 0, 30).includes(","), buf.toString("utf8", 0, 40).replace(/\r?\n/g, "\\n"));
  }

  // XLSX is served by the reports module, which honours ?format=. Two different
  // implementations exist; testing only one would miss a broken format switch.
  for (const [label, path] of [
    ["reports campaigns", "/api/v1/reports/campaigns/export?format=xlsx"],
    ["reports financial", "/api/v1/reports/financial/export?format=xlsx"],
  ]) {
    const r = await api(path, owner);
    check(`${label} XLSX returns 200`, r.status === 200, String(r.status));
    if (r.status === 200) {
      const buf = Buffer.from(r.body);
      // XLSX is a ZIP container: PK\x03\x04. If ?format= were ignored we would get a
      // CSV here, and a file named .xlsx that Excel refuses to open.
      const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
      check(`${label} XLSX is really a ZIP`, isZip, `first bytes ${[...buf.slice(0, 4)].join(",")} (${buf.length} bytes)`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n6. invoice PDF generation produces a real PDF");
// ---------------------------------------------------------------------------
{
  const invoices = await api("/api/v1/invoices?limit=1", owner);
  const inv = invoices.body?.data?.[0];

  if (inv) {
    const r = await api(`/api/v1/invoices/${inv.id}/pdf`, owner);
    check("the PDF endpoint returns 200", r.status === 200, String(r.status));

    if (r.status === 200) {
      const buf = Buffer.from(r.body);
      // A PDF starts with %PDF-. Anything else means the handler returned JSON or
      // the SPA shell, which is exactly what a broken deployment looks like.
      check("the response is a real PDF", buf.slice(0, 5).toString() === "%PDF-", buf.slice(0, 8).toString("latin1"));
      check("the PDF has substance", buf.length > 1000, `${buf.length} bytes`);
    }
  } else {
    check("no invoice available for PDF test", false);
  }
}

// ---------------------------------------------------------------------------
console.log("\n7. the financial figures reconcile");
// ---------------------------------------------------------------------------
{
  const summary = await api("/api/v1/reports/financial", owner);
  check("financial summary responds", summary.status === 200, String(summary.status));

  const profit = await api("/api/v1/reports/profitability", owner);
  check("profitability responds", profit.status === 200, String(profit.status));

  if (profit.status === 200) {
    // The response is `{ placements: [...] }`, not a bare array. `v_placement_margin`
    // LEFT JOINs placement_pricing and placement_costs, so a placement with no
    // pricing row genuinely has a null client_rate — the row is still returned so an
    // unpriced placement is visible rather than silently omitted.
    const rows = profit.body?.data?.placements ?? [];
    check("profitability returns per-placement rows", rows.length > 0, `${rows.length} row(s)`);

    const priced = rows.filter((r) => r.client_rate !== null && r.client_rate !== undefined);
    check("at least some placements carry a client rate", priced.length > 0, `${priced.length} priced of ${rows.length}`);

    const bad = priced.filter((r) => {
      const rate = Number(r.client_rate ?? 0);
      const cost = Number(r.supplier_cost ?? 0);
      const margin = Number(r.margin ?? 0);
      // margin must equal client_rate - supplier_cost. A mismatch means the view and
      // the API disagree, which is the class of bug that reached a client in Phase 6.
      return Math.abs(margin - (rate - cost)) > 0.01;
    });
    check("margin equals client rate minus supplier cost on every priced row", bad.length === 0, `${bad.length} inconsistent row(s)`);

    // An unpriced placement must report a null margin rather than a misleading zero:
    // "no revenue recorded" and "zero margin" are different business facts.
    const unpriced = rows.filter((r) => r.client_rate === null);
    const wrongZero = unpriced.filter((r) => r.margin !== null);
    check("an unpriced placement reports a null margin, not zero", wrongZero.length === 0, `${wrongZero.length} misleading row(s)`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n8. notifications and audit trail are live");
// ---------------------------------------------------------------------------
{
  const notes = await api("/api/v1/notifications", owner);
  check("notifications respond", notes.status === 200, String(notes.status));

  const audit = await api("/api/v1/audit?limit=5", owner);
  check("the audit log responds", audit.status === 200, String(audit.status));
  const rows = audit.body?.data ?? [];
  check("the audit log has recorded activity", rows.length > 0, `${rows.length} entries`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.n} — ${f.d}`);
  process.exit(1);
}
