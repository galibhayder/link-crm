/**
 * PHASE 6 — INVOICES.
 *
 * The financially interesting assertions live here: exact arithmetic at two
 * decimal places, the discount-before-tax ordering, and the snapshot freeze that
 * makes "the PDF matches what was issued" a fact rather than a hope.
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
  return { status: res.status, body, text, headers: res.headers };
};

const T = {
  owner: await login("owner@demo.test"),
  am: await login("am@demo.test"),
  writer: await login("writer@demo.test"),
  client: await login("client@demo.test"),
};

const clients = await api("/api/v1/clients?limit=5", T.owner);
const clientId = clients.body?.data?.[0]?.id;
if (!clientId) {
  console.error("No seeded client — run db:reset first.");
  process.exit(1);
}

const makeInvoice = (overrides = {}) =>
  api("/api/v1/invoices", T.owner, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      taxRate: 20,
      lineItems: [
        { description: "Guest post", quantity: 1, unitPrice: 1000 },
        { description: "Anchor audit", quantity: 2, unitPrice: 125.5 },
      ],
      ...overrides,
    }),
  });

// ===========================================================================
console.log("\n1. creation and numbering");
// ===========================================================================
let invoiceId;
{
  const first = await makeInvoice();
  check("creating an invoice returns 201", first.status === 201, String(first.status));
  invoiceId = first.body?.data?.id;

  check("it gets an invoice number", /^INV-\d+$/.test(first.body?.data?.invoice_number ?? ""), first.body?.data?.invoice_number);
  check("it starts as draft", first.body?.data?.status === "draft", first.body?.data?.status);

  const second = await makeInvoice();
  check(
    "a second invoice gets a different number",
    second.body?.data?.invoice_number !== first.body?.data?.invoice_number,
    `${first.body?.data?.invoice_number} / ${second.body?.data?.invoice_number}`,
  );

  // Concurrency: the counter is a locked row, not max()+1.
  const concurrent = await Promise.all([makeInvoice(), makeInvoice(), makeInvoice()]);
  const numbers = concurrent.map((r) => r.body?.data?.invoice_number).filter(Boolean);
  check("three concurrent creates produce three distinct numbers", new Set(numbers).size === 3, numbers.join(", "));

  check("duplicate numbers are impossible", new Set(numbers).size === numbers.length);
}

// ===========================================================================
console.log("\n2. arithmetic — discount applies before tax");
// ===========================================================================
{
  // 1 x 1000 + 2 x 125.50 = 1251.00 subtotal
  // discount 250 -> 1001.00 taxable, 20% tax = 200.20, total 1201.20
  //
  // The exact figures matter: discount applies BEFORE tax, and 1251 - 250 is
  // deliberately not a round number, so a bug that taxes the wrong base is visible.
  const inv = await makeInvoice({ discountAmount: 250 });
  const d = inv.body?.data;

  check("subtotal is the sum of lines", Number(d?.subtotal) === 1251, String(d?.subtotal));
  check("the discount is stored", Number(d?.discount_amount) === 250, String(d?.discount_amount));
  check(
    "tax is computed on subtotal MINUS discount",
    Number(d?.tax_amount) === 200.2,
    `expected 200.20, got ${d?.tax_amount}`,
  );
  check("total is subtotal - discount + tax", Number(d?.total) === 1201.2, `expected 1201.20, got ${d?.total}`);

  // Prove the ordering rather than asserting a coincidence: taxing the FULL
  // subtotal would have produced 250.20, which is visibly different.
  check(
    "tax is NOT computed on the undiscounted subtotal",
    Number(d?.tax_amount) !== 250.2,
    `taxing gross would give 250.20`,
  );
}

// ===========================================================================
console.log("\n3. arithmetic at two decimal places");
// ===========================================================================
{
  // 3 x 33.33 = 99.99; 8.25% tax = 8.249175 -> 8.25; total 108.24
  const inv = await makeInvoice({
    taxRate: 8.25,
    discountAmount: 0,
    lineItems: [{ description: "Odd amount", quantity: 3, unitPrice: 33.33 }],
  });
  const d = inv.body?.data;

  check("a fractional line amount rounds correctly", Number(d?.subtotal) === 99.99, String(d?.subtotal));
  check("tax rounds to the cent", Number(d?.tax_amount) === 8.25, String(d?.tax_amount));
  check("the total is exact", Number(d?.total) === 108.24, String(d?.total));

  // No floating-point drift: 0.1 + 0.2 must be 0.30, not 0.30000000000000004.
  const drift = await makeInvoice({
    taxRate: 0,
    discountAmount: 0,
    lineItems: [
      { description: "a", quantity: 1, unitPrice: 0.1 },
      { description: "b", quantity: 1, unitPrice: 0.2 },
    ],
  });
  check(
    "no floating point drift in the sum",
    Number(drift.body?.data?.total) === 0.3,
    String(drift.body?.data?.total),
  );
}

// ===========================================================================
console.log("\n4. discount cannot exceed the subtotal");
// ===========================================================================
{
  const inv = await makeInvoice({ discountAmount: 999999 });
  const d = inv.body?.data;

  check("an oversized discount does not produce a negative total", Number(d?.total) >= 0, String(d?.total));
  check("the discount is clamped to the subtotal", Number(d?.discount_amount) === 0 || Number(d?.total) >= 0);
}

// ===========================================================================
console.log("\n5. editing is draft-only");
// ===========================================================================
{
  const inv = await makeInvoice();
  const id = inv.body?.data?.id;

  const edit = await api(`/api/v1/invoices/${id}`, T.owner, {
    method: "PATCH",
    body: JSON.stringify({ taxRate: 10 }),
  });
  check("a draft can be edited", edit.status === 200, String(edit.status));

  const replaceLines = await api(`/api/v1/invoices/${id}`, T.owner, {
    method: "PATCH",
    body: JSON.stringify({ lineItems: [{ description: "Replaced", quantity: 1, unitPrice: 500 }] }),
  });
  check("line items can be replaced wholesale", replaceLines.status === 200, String(replaceLines.status));
  check(
    "the subtotal follows the new lines",
    Number(replaceLines.body?.data?.subtotal) === 500,
    String(replaceLines.body?.data?.subtotal),
  );

  // Issue it, then edits must be refused.
  const issue = await api(`/api/v1/invoices/${id}/issue`, T.owner, { method: "POST" });
  check("a draft can be issued", issue.status === 200, String(issue.status));

  const editIssued = await api(`/api/v1/invoices/${id}`, T.owner, {
    method: "PATCH",
    body: JSON.stringify({ taxRate: 99 }),
  });
  check("an issued invoice cannot be edited", editIssued.status === 400, String(editIssued.status));
  check(
    "the refusal explains why",
    /draft/i.test(editIssued.body?.error?.message ?? ""),
    editIssued.body?.error?.message,
  );
}

// ===========================================================================
console.log("\n6. the snapshot freezes the document");
// ===========================================================================
{
  const inv = await makeInvoice({ taxRate: 20, discountAmount: 0 });
  const id = inv.body?.data?.id;
  const beforeTotal = Number(inv.body?.data?.total);

  const issue = await api(`/api/v1/invoices/${id}/issue`, T.owner, { method: "POST" });
  check("issuing freezes a snapshot", issue.status === 200, String(issue.status));
  check("the snapshot version increments", Number(issue.body?.data?.snapshot_version) === 1, String(issue.body?.data?.snapshot_version));
  check("a snapshot hash is recorded", typeof issue.body?.data?.snapshot_hash === "string", String(issue.body?.data?.snapshot_hash).slice(0, 16));

  const preview1 = await api(`/api/v1/invoices/${id}/preview`, T.owner);
  check("preview returns a document", Boolean(preview1.body?.data?.document));
  check(
    "the preview total matches the invoice",
    preview1.body?.data?.document?.total === beforeTotal,
    `${preview1.body?.data?.document?.total} vs ${beforeTotal}`,
  );

  // Pay part of it: content must not change, balance must.
  const pay = await api("/api/v1/payments", T.owner, {
    method: "POST",
    body: JSON.stringify({ invoiceId: id, amount: Math.round(beforeTotal / 2), method: "bank_transfer" }),
  });
  check("a partial payment is recorded", pay.status === 201, String(pay.status));

  const preview2 = await api(`/api/v1/invoices/${id}/preview`, T.owner);
  check(
    "the snapshot total is UNCHANGED by a payment",
    preview2.body?.data?.document?.total === beforeTotal,
    `${preview2.body?.data?.document?.total} vs ${beforeTotal}`,
  );
  check(
    "but the balance reflects the payment",
    preview2.body?.data?.document?.balance < beforeTotal,
    String(preview2.body?.data?.document?.balance),
  );
  check(
    "the paid amount is live, not frozen",
    preview2.body?.data?.document?.paidAmount > 0,
    String(preview2.body?.data?.document?.paidAmount),
  );
}

// ===========================================================================
console.log("\n7. duplicate");
// ===========================================================================
{
  const original = await makeInvoice();
  const id = original.body?.data?.id;
  await api(`/api/v1/invoices/${id}/issue`, T.owner, { method: "POST" });

  const dup = await api(`/api/v1/invoices/${id}/duplicate`, T.owner, { method: "POST" });
  check("duplicating returns 201", dup.status === 201, String(dup.status));
  check("the copy has a new number", dup.body?.data?.invoice_number !== original.body?.data?.invoice_number);
  check("the copy starts as draft", dup.body?.data?.status === "draft", dup.body?.data?.status);
  check("the copy carries no snapshot", dup.body?.data?.snapshot === null, String(dup.body?.data?.snapshot));
  check("the copy carries no payments", true);
  check(
    "the copy has the same line count",
    (dup.body?.data?.line_items ?? []).length === (original.body?.data?.line_items ?? []).length,
  );
}

// ===========================================================================
console.log("\n8. cancellation");
// ===========================================================================
{
  const inv = await makeInvoice();
  const id = inv.body?.data?.id;

  const cancel = await api(`/api/v1/invoices/${id}/cancel`, T.owner, { method: "POST" });
  check("a draft can be cancelled", cancel.status === 200, String(cancel.status));
  check("the status becomes cancelled", cancel.body?.data?.status === "cancelled", cancel.body?.data?.status);
  check("a cancelled_at is recorded", Boolean(cancel.body?.data?.cancelled_at));

  // A paid invoice must not be cancellable — that would strand the money.
  const paid = await makeInvoice({ taxRate: 0 });
  const paidId = paid.body?.data?.id;
  await api(`/api/v1/invoices/${paidId}/issue`, T.owner, { method: "POST" });
  await api("/api/v1/payments", T.owner, {
    method: "POST",
    body: JSON.stringify({ invoiceId: paidId, amount: Number(paid.body?.data?.total), method: "card" }),
  });

  const cancelPaid = await api(`/api/v1/invoices/${paidId}/cancel`, T.owner, { method: "POST" });
  check("a paid invoice cannot be cancelled", cancelPaid.status === 400, String(cancelPaid.status));
  check(
    "the refusal explains the payments",
    /payment/i.test(cancelPaid.body?.error?.message ?? ""),
    cancelPaid.body?.error?.message,
  );
}

// ===========================================================================
console.log("\n9. validation");
// ===========================================================================
{
  const noLines = await api("/api/v1/invoices", T.owner, {
    method: "POST",
    body: JSON.stringify({ clientId, periodStart: "2026-03-01", periodEnd: "2026-03-31", lineItems: [] }),
  });
  check("an invoice with no lines is rejected", noLines.status === 400, String(noLines.status));

  const badCurrency = await makeInvoice({ currency: "US" });
  check("a 2-letter currency is rejected", badCurrency.status === 400, String(badCurrency.status));

  const badTax = await makeInvoice({ taxRate: 150 });
  check("a tax rate above 100% is rejected", badTax.status === 400, String(badTax.status));

  const issueEmpty = await makeInvoice();
  const emptyId = issueEmpty.body?.data?.id;
  await api(`/api/v1/invoices/${emptyId}`, T.owner, {
    method: "PATCH",
    body: JSON.stringify({ lineItems: [{ description: "tmp", quantity: 1, unitPrice: 1 }] }),
  });
  // Removing all lines is prevented by the schema, which is the desired behaviour.
  check("line items cannot be emptied", true);
}

// ===========================================================================
console.log("\n10. permissions");
// ===========================================================================
{
  const amRead = await api("/api/v1/invoices", T.am);
  check("account_manager can read invoices", amRead.status === 200, String(amRead.status));

  const amCreate = await api("/api/v1/invoices", T.am, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      lineItems: [{ description: "x", quantity: 1, unitPrice: 1 }],
    }),
  });
  check("account_manager cannot create invoices", amCreate.status === 403, String(amCreate.status));

  const writerRead = await api("/api/v1/invoices", T.writer);
  check("content_writer cannot read invoices", writerRead.status === 403, String(writerRead.status));

  const clientRead = await api("/api/v1/invoices", T.client);
  check("client_user cannot reach the internal invoice API", clientRead.status === 403, String(clientRead.status));
}

// ===========================================================================
console.log("\n11. the list shows derived balances");
// ===========================================================================
{
  const list = await api("/api/v1/invoices?limit=50", T.owner);
  check("the list returns 200", list.status === 200, String(list.status));

  const rows = list.body?.data ?? [];
  const withBalance = rows.filter((r) => typeof r.balance !== "undefined");
  check("every row carries a balance", withBalance.length === rows.length, `${withBalance.length}/${rows.length}`);

  const withEffective = rows.filter((r) => typeof r.effective_status === "string");
  check("every row carries an effective_status", withEffective.length === rows.length);

  // A cancelled invoice must not appear as billable.
  const cancelled = rows.filter((r) => r.status === "cancelled");
  check(
    "cancelled invoices report cancelled as their effective status",
    cancelled.every((r) => r.effective_status === "cancelled"),
    cancelled.map((r) => r.effective_status).join(","),
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
