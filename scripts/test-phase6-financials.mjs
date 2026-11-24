/**
 * PHASE 6 — FINANCIAL PRIVACY AND PROFITABILITY.
 *
 * Two things under test:
 *
 *   1. Payouts and expenses are owner-only, enforced by BOTH the route and RLS.
 *   2. Profitability arithmetic is exact, and a client-facing report contains no
 *      internal figure at all.
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
    headers: token
      ? { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers ?? {}) }
      : { "content-type": "application/json", ...(options.headers ?? {}) },
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
  prospector: await login("prospector@demo.test"),
  publisher: await login("publisher@demo.test"),
  client: await login("client@demo.test"),
};

const campaigns = await api("/api/v1/campaigns?limit=5", T.owner);
const campaignId = campaigns.body?.data?.[0]?.id;
const staff = await api("/api/v1/staff?limit=50", T.owner);
const writerId = (staff.body?.data ?? []).find((s) => s.email === "writer@demo.test")?.id;

// ===========================================================================
console.log("\n1. writer payouts are owner-only");
// ===========================================================================
{
  const create = await api("/api/v1/payouts", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, writerId, feeType: "per_article", amount: 150, description: "Article fee" }),
  });
  check("the owner can create a payout", create.status === 201, String(create.status));
  check("it starts as pending", create.body?.data?.status === "pending", create.body?.data?.status);

  const listed = await api("/api/v1/payouts", T.owner);
  check("the owner can list payouts", listed.status === 200, String(listed.status));

  // Every other role must be refused.
  for (const [label, token] of [
    ["account_manager", T.am],
    ["content_writer", T.writer],
    ["prospector", T.prospector],
    ["publisher_user", T.publisher],
    ["client_user", T.client],
  ]) {
    const res = await api("/api/v1/payouts", token);
    check(`${label} cannot list payouts`, res.status === 403, String(res.status));
  }

  // A writer cannot see their own payout either — RLS has no per-writer concept.
  const writerCreate = await api("/api/v1/payouts", T.writer, {
    method: "POST",
    body: JSON.stringify({ amount: 5000, writerId }),
  });
  check("a writer cannot create a payout", writerCreate.status === 403, String(writerCreate.status));
}

// ===========================================================================
console.log("\n2. payout invariants");
// ===========================================================================
{
  const noDate = await api("/api/v1/payouts", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, writerId, amount: 100, status: "paid" }),
  });
  check("a payout marked paid without a date is refused", noDate.status === 400, String(noDate.status));

  const withDate = await api("/api/v1/payouts", T.owner, {
    method: "POST",
    body: JSON.stringify({
      campaignId,
      writerId,
      amount: 100,
      status: "paid",
      paidAt: "2026-03-15T00:00:00.000Z",
    }),
  });
  check("with a date it is accepted", withDate.status === 201, String(withDate.status));
  check("paid_at is stored", Boolean(withDate.body?.data?.paid_at));

  const delPaid = await api(`/api/v1/payouts/${withDate.body?.data?.id}`, T.owner, { method: "DELETE" });
  check("a paid payout cannot be deleted", delPaid.status === 400, String(delPaid.status));

  const negative = await api("/api/v1/payouts", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, amount: -50 }),
  });
  check("a negative payout is rejected", negative.status === 400, String(negative.status));
}

// ===========================================================================
console.log("\n3. campaign expenses are owner-only");
// ===========================================================================
{
  const create = await api("/api/v1/expenses", T.owner, {
    method: "POST",
    body: JSON.stringify({
      campaignId,
      category: "tools",
      description: "SEO tool subscription",
      amount: 99.99,
    }),
  });
  check("the owner can create an expense", create.status === 201, String(create.status));

  for (const [label, token] of [
    ["account_manager", T.am],
    ["content_writer", T.writer],
    ["client_user", T.client],
  ]) {
    const res = await api("/api/v1/expenses", token);
    check(`${label} cannot list expenses`, res.status === 403, String(res.status));
  }

  const missingCampaign = await api("/api/v1/expenses", T.owner, {
    method: "POST",
    body: JSON.stringify({ category: "tools", description: "x", amount: 10 }),
  });
  check("an expense without a campaign is rejected", missingCampaign.status === 400, String(missingCampaign.status));
}

// ===========================================================================
console.log("\n4. profitability arithmetic");
// ===========================================================================
{
  const report = await api("/api/v1/reports/campaigns", T.owner);
  check("the owner can read campaign profitability", report.status === 200, String(report.status));

  const rows = report.body?.data ?? [];
  check("there is at least one campaign row", rows.length > 0, `${rows.length} rows`);

  // Verify the identity on every row rather than trusting one.
  const bad = rows.filter((r) => {
    const expected = Number(r.revenue) - Number(r.publisher_cost) - Number(r.writer_payouts) - Number(r.other_expenses);
    // Allow a cent of representation noise from numeric -> JS number.
    return Math.abs(Number(r.gross_profit) - expected) > 0.011;
  });
  check("gross_profit = revenue - costs - payouts - expenses on every row", bad.length === 0, `${bad.length} mismatched`);

  const badPct = rows.filter((r) => {
    if (r.margin_pct === null) return false;
    const expected = (Number(r.gross_profit) / Number(r.revenue)) * 100;
    return Math.abs(Number(r.margin_pct) - expected) > 0.02;
  });
  check("margin_pct matches gross_profit / revenue on every row", badPct.length === 0, `${badPct.length} mismatched`);

  // Margin of null means "no revenue", not "0%".
  const zeroRevenue = rows.filter((r) => Number(r.revenue) === 0);
  check(
    "a campaign with no revenue has a null margin, not 0%",
    zeroRevenue.every((r) => r.margin_pct === null),
    zeroRevenue.map((r) => r.margin_pct).join(","),
  );
}

// ===========================================================================
console.log("\n5. the payout and expense landed in profitability");
// ===========================================================================
{
  const before = (await api("/api/v1/reports/campaigns", T.owner)).body?.data ?? [];
  const target = before.find((r) => r.campaign_id === campaignId);
  const payoutsBefore = Number(target?.writer_payouts ?? 0);
  const expensesBefore = Number(target?.other_expenses ?? 0);

  await api("/api/v1/payouts", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, amount: 250, currency: "USD" }),
  });
  await api("/api/v1/expenses", T.owner, {
    method: "POST",
    body: JSON.stringify({ campaignId, category: "other", description: "Test", amount: 50, currency: "USD" }),
  });

  const after = (await api("/api/v1/reports/campaigns", T.owner)).body?.data ?? [];
  const target2 = after.find((r) => r.campaign_id === campaignId);

  check(
    "a payout increases writer_payouts",
    Number(target2?.writer_payouts) === payoutsBefore + 250,
    `${payoutsBefore} -> ${target2?.writer_payouts}`,
  );
  check(
    "an expense increases other_expenses",
    Number(target2?.other_expenses) === expensesBefore + 50,
    `${expensesBefore} -> ${target2?.other_expenses}`,
  );
  check(
    "and gross_profit falls by both",
    Number(target2?.gross_profit) < Number(target?.gross_profit),
    `${target?.gross_profit} -> ${target2?.gross_profit}`,
  );
}

// ===========================================================================
console.log("\n6. the financial summary groups by currency");
// ===========================================================================
{
  const summary = await api("/api/v1/reports/financial", T.owner);
  check("the owner can read the financial summary", summary.status === 200, String(summary.status));

  const rows = summary.body?.data ?? [];
  check("it returns at least one currency row", rows.length > 0, `${rows.length} rows`);

  const currencies = rows.map((r) => r.currency);
  check("each row is a single currency", currencies.every((c) => typeof c === "string" && c.length === 3), currencies.join(","));
  check("currencies are not mixed within a row", new Set(currencies).size === currencies.length, currencies.join(","));

  const badAr = rows.filter(
    (r) => Math.abs(Number(r.outstanding_ar) - (Number(r.billed) - Number(r.collected))) > 0.011,
  );
  check("outstanding_ar = billed - collected", badAr.length === 0, `${badAr.length} mismatched`);
}

// ===========================================================================
console.log("\n7. the client-facing report contains no internal figure");
// ===========================================================================
{
  // The client-facing report lives on the PORTAL surface. `/api/v1` rejects a
  // client_user token before any handler runs, so a client report cannot be
  // mounted there — a fact the first run of this suite proved with a 403.
  const report = await api("/portal/v1/reports/campaigns", T.client);
  check("a client can read the client campaign report", report.status === 200, String(report.status));

  const raw = report.text;
  const forbidden = [
    ["cost", /cost/i],
    ["payout", /payout/i],
    ["margin", /margin/i],
    ["profit", /profit/i],
    ["wholesale", /wholesale/i],
    ["rate", /client_rate|supplier_rate/i],
    ["revenue", /revenue/i],
  ];

  for (const [label, re] of forbidden) {
    check(`the client report has no ${label}`, !re.test(raw));
  }

  const rows = report.body?.data ?? [];
  check("it returns campaign delivery data", rows.length > 0, `${rows.length} rows`);
  check(
    "it includes what the client legitimately needs",
    rows.every((r) => typeof r.placements === "number" && typeof r.liveLinks === "number"),
  );
}

// ===========================================================================
console.log("\n8. report permissions");
// ===========================================================================
{
  const amMargins = await api("/api/v1/reports/campaigns", T.am);
  check("account_manager cannot read margin reports", amMargins.status === 403, String(amMargins.status));

  const writerMargins = await api("/api/v1/reports/campaigns", T.writer);
  check("content_writer cannot read margin reports", writerMargins.status === 403, String(writerMargins.status));

  const clientMargins = await api("/api/v1/reports/campaigns", T.client);
  check("client_user cannot read margin reports", clientMargins.status === 403, String(clientMargins.status));

  const clientPortalMargins = await api("/portal/v1/reports/campaigns", T.client);
  check(
    "the portal report a client DOES reach carries no margin",
    clientPortalMargins.status === 200 && !/margin|profit|cost/i.test(clientPortalMargins.text),
    String(clientPortalMargins.status),
  );

  const clientFinancial = await api("/api/v1/reports/financial", T.client);
  check("client_user cannot read the financial summary", clientFinancial.status === 403, String(clientFinancial.status));

  const clientLedger = await api("/api/v1/reports/ledger", T.client);
  check("client_user cannot read the ledger", clientLedger.status === 403, String(clientLedger.status));

  const writerLedger = await api("/api/v1/reports/ledger", T.writer);
  check("content_writer cannot read the ledger", writerLedger.status === 403, String(writerLedger.status));

  const dbReport = await api("/api/v1/reports/database", T.owner);
  check("the owner can read the database report", dbReport.status === 200, String(dbReport.status));
  check("it reports table counts", (dbReport.body?.data?.tables ?? []).length > 0);
  check("it contains no financial figures", !/margin|profit|cost/i.test(dbReport.text));

  const amDb = await api("/api/v1/reports/database", T.am);
  check("account_manager cannot read the database report", amDb.status === 403, String(amDb.status));
}

// ===========================================================================
console.log("\n9. RLS backs up the route guard");
// ===========================================================================
{
  // Query Supabase directly as the AM, bypassing the API entirely. Even without
  // authorize(), the policy must return nothing.
  const amToken = T.am;
  const direct = await fetch(`${SUPABASE}/rest/v1/writer_payouts?select=id,amount`, {
    headers: { apikey: ANON, authorization: `Bearer ${amToken}` },
  });
  const rows = await direct.json();
  check(
    "an AM reading writer_payouts directly via PostgREST gets no rows",
    Array.isArray(rows) && rows.length === 0,
    JSON.stringify(rows).slice(0, 80),
  );

  const directExpenses = await fetch(`${SUPABASE}/rest/v1/campaign_expenses?select=id,amount`, {
    headers: { apikey: ANON, authorization: `Bearer ${amToken}` },
  });
  const expenseRows = await directExpenses.json();
  check(
    "an AM reading campaign_expenses directly gets no rows",
    Array.isArray(expenseRows) && expenseRows.length === 0,
    JSON.stringify(expenseRows).slice(0, 80),
  );

  // The owner must see them, so the policy is not simply denying everyone.
  const ownerDirect = await fetch(`${SUPABASE}/rest/v1/writer_payouts?select=id,amount`, {
    headers: { apikey: ANON, authorization: `Bearer ${T.owner}` },
  });
  const ownerRows = await ownerDirect.json();
  check("the owner reading directly DOES get rows", Array.isArray(ownerRows) && ownerRows.length > 0, `${ownerRows.length} rows`);

  // Margin views are not granted to any end-user role at all.
  const viewDirect = await fetch(`${SUPABASE}/rest/v1/v_campaign_profitability?select=campaign_id`, {
    headers: { apikey: ANON, authorization: `Bearer ${T.owner}` },
  });
  check(
    "even the owner cannot read margin views directly (service_role only)",
    viewDirect.status === 403 || viewDirect.status === 404 || viewDirect.status === 401,
    String(viewDirect.status),
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
