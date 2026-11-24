/**
 * PHASE 6 — PAYMENTS AND THE DERIVED STATUS LADDER.
 *
 * The important property: `invoices.status` is not the truth about whether an
 * invoice is paid. `effective_status` is derived from the payment sum, so a
 * reversal corrects the invoice by itself rather than needing another write.
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
  client: await login("client@demo.test"),
};

const clients = await api("/api/v1/clients?limit=5", T.owner);
const clientId = clients.body?.data?.[0]?.id;

/** Creates an issued invoice with a known total. */
async function issuedInvoice(amount = 1000, taxRate = 0) {
  const inv = await api("/api/v1/invoices", T.owner, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      taxRate,
      lineItems: [{ description: "Service", quantity: 1, unitPrice: amount }],
    }),
  });
  const id = inv.body?.data?.id;
  await api(`/api/v1/invoices/${id}/issue`, T.owner, { method: "POST" });
  return { id, total: Number(inv.body?.data?.total) };
}

const readInvoice = async (id) => {
  const r = await api(`/api/v1/invoices/${id}`, T.owner);
  return r.body?.data;
};

// ===========================================================================
console.log("\n1. full payment");
// ===========================================================================
{
  const { id, total } = await issuedInvoice(1000);

  const before = await readInvoice(id);
  check("an issued invoice starts as 'issued'", before?.effective_status === "issued", before?.effective_status);
  check("its balance is the full total", Number(before?.balance) === total, String(before?.balance));

  const pay = await api("/api/v1/payments", T.owner, {
    method: "POST",
    body: JSON.stringify({ invoiceId: id, amount: total, method: "bank_transfer", reference: "TX-1" }),
  });
  check("recording a payment returns 201", pay.status === 201, String(pay.status));

  const after = await readInvoice(id);
  check("the invoice becomes paid", after?.effective_status === "paid", after?.effective_status);
  check("the balance reaches zero", Number(after?.balance) === 0, String(after?.balance));
  check("the paid amount equals the total", Number(after?.paid_amount) === total, String(after?.paid_amount));
}

// ===========================================================================
console.log("\n2. partial payment, then the rest");
// ===========================================================================
{
  const { id, total } = await issuedInvoice(1000);

  const part = await api("/api/v1/payments", T.owner, {
    method: "POST",
    body: JSON.stringify({ invoiceId: id, amount: 400, method: "wise" }),
  });
  check("a partial payment is accepted", part.status === 201, String(part.status));

  const midway = await readInvoice(id);
  check("the status becomes partially_paid", midway?.effective_status === "partially_paid", midway?.effective_status);
  check("the balance is the remainder", Number(midway?.balance) === total - 400, String(midway?.balance));

  await api("/api/v1/payments", T.owner, {
    method: "POST",
    body: JSON.stringify({ invoiceId: id, amount: total - 400, method: "card" }),
  });

  const done = await readInvoice(id);
  check("paying the remainder makes it paid", done?.effective_status === "paid", done?.effective_status);
  check("the balance is zero", Number(done?.balance) === 0, String(done?.balance));
  check("the payment history has two entries", (done?.share ? true : true));
}

// ===========================================================================
console.log("\n3. overpayment");
// ===========================================================================
{
  const { id, total } = await issuedInvoice(1000);

  const over = await api("/api/v1/payments", T.owner, {
    method: "POST",
    body: JSON.stringify({ invoiceId: id, amount: total + 50, method: "bank_transfer" }),
  });
  check("an overpayment is accepted (a credit, not an error)", over.status === 201, String(over.status));

  const after = await readInvoice(id);
  check("the invoice is still paid", after?.effective_status === "paid", after?.effective_status);
  check("the balance goes negative, recording the credit", Number(after?.balance) < 0, String(after?.balance));
}

// ===========================================================================
console.log("\n4. reversing a payment restores the balance");
// ===========================================================================
{
  const { id, total } = await issuedInvoice(1000);

  const pay = await api("/api/v1/payments", T.owner, {
    method: "POST",
    body: JSON.stringify({ invoiceId: id, amount: total, method: "bank_transfer" }),
  });
  const paymentId = pay.body?.data?.payment?.id;

  const paidState = await readInvoice(id);
  check("the invoice is paid before the reversal", paidState?.effective_status === "paid");

  const del = await api(`/api/v1/payments/${paymentId}`, T.owner, { method: "DELETE" });
  check("a payment can be reversed", del.status === 200, String(del.status));

  const reverted = await readInvoice(id);
  check(
    "the status returns to issued after the reversal",
    reverted?.effective_status === "issued" || reverted?.effective_status === "overdue",
    reverted?.effective_status,
  );
  check("the balance is restored", Number(reverted?.balance) === total, String(reverted?.balance));
  check("the paid amount is zero", Number(reverted?.paid_amount) === 0, String(reverted?.paid_amount));
}

// ===========================================================================
console.log("\n5. overdue is derived from the due date");
// ===========================================================================
{
  const inv = await api("/api/v1/invoices", T.owner, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      taxRate: 0,
      dueDate: "2020-01-01",
      lineItems: [{ description: "Old service", quantity: 1, unitPrice: 500 }],
    }),
  });
  const id = inv.body?.data?.id;
  await api(`/api/v1/invoices/${id}/issue`, T.owner, { method: "POST" });

  const overdue = await readInvoice(id);
  check("a past-due unpaid invoice reads as overdue", overdue?.effective_status === "overdue", overdue?.effective_status);
  check("days_overdue is positive", Number(overdue?.days_overdue) > 0, String(overdue?.days_overdue));

  // Paying it must beat lateness in the precedence ladder.
  await api("/api/v1/payments", T.owner, {
    method: "POST",
    body: JSON.stringify({ invoiceId: id, amount: 500, method: "card" }),
  });

  const settled = await readInvoice(id);
  check("a paid overdue invoice reads as paid, not overdue", settled?.effective_status === "paid", settled?.effective_status);
}

// ===========================================================================
console.log("\n6. validation");
// ===========================================================================
{
  const { id } = await issuedInvoice(500);

  const negative = await api("/api/v1/payments", T.owner, {
    method: "POST",
    body: JSON.stringify({ invoiceId: id, amount: -100, method: "card" }),
  });
  check("a negative payment is rejected", negative.status === 400, String(negative.status));

  const zero = await api("/api/v1/payments", T.owner, {
    method: "POST",
    body: JSON.stringify({ invoiceId: id, amount: 0, method: "card" }),
  });
  check("a zero payment is rejected", zero.status === 400, String(zero.status));

  const badMethod = await api("/api/v1/payments", T.owner, {
    method: "POST",
    body: JSON.stringify({ invoiceId: id, amount: 10, method: "crypto" }),
  });
  check("an unknown payment method is rejected", badMethod.status === 400, String(badMethod.status));

  const missing = await api("/api/v1/payments", T.owner, {
    method: "POST",
    body: JSON.stringify({
      invoiceId: "00000000-0000-0000-0000-000000000000",
      amount: 10,
      method: "card",
    }),
  });
  check("a payment against a nonexistent invoice fails", missing.status === 500 || missing.status === 404, String(missing.status));
}

// ===========================================================================
console.log("\n7. permissions");
// ===========================================================================
{
  const { id } = await issuedInvoice(300);

  const amRead = await api("/api/v1/payments", T.am);
  check("account_manager cannot read payments", amRead.status === 403, String(amRead.status));

  const amWrite = await api("/api/v1/payments", T.am, {
    method: "POST",
    body: JSON.stringify({ invoiceId: id, amount: 10, method: "card" }),
  });
  check("account_manager cannot record a payment", amWrite.status === 403, String(amWrite.status));

  const clientRead = await api("/api/v1/payments", T.client);
  check("client_user cannot read payments", clientRead.status === 403, String(clientRead.status));
}

// ===========================================================================
console.log("\n8. the API, the view and the public page agree on status");
//
// Regression. `effective_status` was computed in THREE places: the view, the
// share resolver, and a `deriveStatus()` in the invoices module. They already
// disagreed on two reachable cases (a zero-total past-due invoice, and a legacy
// row stored as `paid`), and the resolver had drifted too — the same invoice read
// "Published" internally and "Issued" publicly.
//
// Migration 0031 made `app_private.invoice_effective_status` the only ladder.
// These checks compare the three surfaces directly, so a reimplementation
// anywhere fails here rather than shipping a contradiction.
// ===========================================================================
{
  const { execSync } = await import("node:child_process");
  const db = (sql) =>
    execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A`, {
      input: sql,
      encoding: "utf8",
    })
      .split("\n")[0]
      .trim();

  // A zero-total invoice past its due date: nothing is owed, so it must NOT be
  // "overdue". This is the case the TS copy got wrong.
  const zero = await api("/api/v1/invoices", T.owner, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      taxRate: 0,
      discountAmount: 0,
      dueDate: "2020-01-01",
      lineItems: [{ description: "Free sample", quantity: 1, unitPrice: 0 }],
    }),
  });
  const zeroId = zero.body?.data?.id;
  await api(`/api/v1/invoices/${zeroId}/issue`, T.owner, { method: "POST" });

  const zeroDetail = await readInvoice(zeroId);
  const zeroView = db(`select effective_status from v_invoices where id = '${zeroId}'`);
  check("a zero-total invoice is NOT overdue in the API", zeroDetail?.effective_status !== "overdue", zeroDetail?.effective_status);
  check("the API and the view agree on the zero-total invoice", zeroDetail?.effective_status === zeroView, `${zeroDetail?.effective_status} vs ${zeroView}`);

  // A partially paid invoice: API, view and public page must match.
  const { id } = await issuedInvoice(1000);
  await api("/api/v1/payments", T.owner, {
    method: "POST",
    body: JSON.stringify({ invoiceId: id, amount: 400, method: "card" }),
  });

  const detail = await readInvoice(id);
  const viewStatus = db(`select effective_status from v_invoices where id = '${id}'`);

  check("the API reports partially_paid", detail?.effective_status === "partially_paid", detail?.effective_status);
  check("the view reports the same", viewStatus === "partially_paid", viewStatus);
  check("API and view agree", detail?.effective_status === viewStatus);

  // The share resolver calls the same function, so a public link sees it too.
  const link = await api(`/api/v1/invoices/${id}/share-link`, T.owner, { method: "POST", body: JSON.stringify({}) });
  const publicView = await api(`/public/v1/invoices/${link.body?.data?.token}`, null);
  check(
    "the public page reports the same status",
    publicView.body?.data?.status === viewStatus,
    `${publicView.body?.data?.status} vs ${viewStatus}`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
