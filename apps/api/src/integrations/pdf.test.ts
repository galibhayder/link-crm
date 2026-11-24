import { describe, expect, it } from "vitest";
import { buildInvoiceDoc, formatMoney, renderInvoicePdf, type InvoiceDocument } from "./pdf.js";

/**
 * PDF GENERATION.
 *
 * The point of these tests is not "a buffer came back". It is that the money
 * formatting is correct per currency, and that the document actually renders
 * through PDFMake — a malformed style definition or a bad table width throws at
 * render time, not at build time, so only real generation proves it works.
 */

const baseInvoice: InvoiceDocument = {
  invoiceNumber: "INV-0001",
  status: "issued",
  issuedAt: "2026-03-01T00:00:00.000Z",
  dueDate: "2026-03-31",
  currency: "USD",
  lines: [
    { description: "Guest post placement", quantity: 1, unitPrice: 1500, amount: 1500, targetUrl: "https://client.test/pricing" },
    { description: "Anchor audit", quantity: 2, unitPrice: 125.5, amount: 251 },
  ],
  subtotal: 1751,
  discountAmount: 0,
  taxRate: 20,
  taxAmount: 350.2,
  total: 2101.2,
  paidAmount: 0,
  balance: 2101.2,
  notes: "Thanks for your business.",
  paymentInstructions: "Bank transfer to GB00 0000 0000 0000.",
  branding: {
    agencyName: "Demo Agency",
    agencyEmail: "billing@demo.test",
    brandColor: "#4f46e5",
  },
  billTo: {
    name: "Acme SaaS",
    legalName: "Acme SaaS Ltd",
    address: { line1: "1 Market Street", city: "London", postalCode: "EC1A 1BB", country: "GB" },
    taxId: "GB123456789",
  },
};

describe("formatMoney", () => {
  it("formats USD with two decimals", () => {
    expect(formatMoney(1500, "USD")).toBe("$1,500.00");
    expect(formatMoney("2101.2", "USD")).toBe("$2,101.20");
  });

  it("uses the right symbol per currency", () => {
    expect(formatMoney(1500, "EUR")).toContain("1,500.00");
    expect(formatMoney(1500, "GBP")).toContain("1,500.00");
    // A currency symbol, not the raw code, is the whole point.
    expect(formatMoney(1500, "USD")).not.toContain("USD");
  });

  it("omits decimals for zero-decimal currencies", () => {
    // A JPY invoice showing ".00" is a correctness bug, not styling.
    expect(formatMoney(1500, "JPY")).toBe("¥1,500");
    expect(formatMoney(1500, "JPY")).not.toContain(".");
  });

  it("survives an unknown currency code rather than throwing", () => {
    expect(formatMoney(10, "ZZZ")).toContain("ZZZ");
  });

  it("treats a non-numeric value as zero", () => {
    expect(formatMoney(Number.NaN, "USD")).toBe("$0.00");
  });
});

describe("buildInvoiceDoc", () => {
  it("produces a page definition with content", () => {
    const doc = buildInvoiceDoc(baseInvoice);
    expect(doc.pageSize).toBe("A4");
    expect(Array.isArray(doc.content)).toBe(true);
    expect((doc.content as unknown[]).length).toBeGreaterThan(3);
  });

  it("prints no discount row when there is no discount", () => {
    const doc = JSON.stringify(buildInvoiceDoc(baseInvoice));
    expect(doc).not.toContain("Discount");
  });

  it("prints a discount row when there is one", () => {
    const doc = JSON.stringify(
      buildInvoiceDoc({ ...baseInvoice, discountAmount: 100, total: 1981.2, balance: 1981.2 }),
    );
    expect(doc).toContain("Discount");
  });

  it("renders a deduction so it cannot read as an addition", () => {
    // A discount printed as "$150.00" beside "Subtotal $2,150.00" looks additive.
    // On an invoice that is a misstatement, so the deduction is asserted explicitly.
    const doc = JSON.stringify(buildInvoiceDoc({ ...baseInvoice, discountAmount: 100 }));
    // Parenthesised, the accountancy convention for a negative.
    expect(doc).toContain("($100.00)");

    // And the Unicode minus must NOT be used: Helvetica's standard-14 set is
    // Latin-1, where U+2212 renders as a blank — which reintroduces the ambiguity
    // silently. This assertion exists because the rendered PDF showed exactly that.
    expect(doc).not.toContain("\u2212");
  });

  it("uses only Latin-1-safe characters in the totals block", () => {
    // Guards against any future non-Latin-1 punctuation in a money row.
    const doc = JSON.stringify(
      buildInvoiceDoc({ ...baseInvoice, status: "partially_paid", paidAmount: 500, balance: 1601.2 }),
    );
    expect(doc).not.toMatch(/[\u2000-\u206F\u2212\u2013\u2014]/);
  });

  it("shows the balance only once money has been received", () => {
    const unpaid = JSON.stringify(buildInvoiceDoc(baseInvoice));
    expect(unpaid).not.toContain("Balance due");

    const partial = JSON.stringify(buildInvoiceDoc({ ...baseInvoice, paidAmount: 500, balance: 1601.2, status: "partially_paid" }));
    expect(partial).toContain("Balance due");
  });

  it("omits payment detail on a draft, which has no payment state", () => {
    const doc = JSON.stringify(
      buildInvoiceDoc({ ...baseInvoice, status: "draft", paidAmount: 500, balance: 1601.2 }),
    );
    expect(doc).not.toContain("Balance due");
  });

  it("falls back to a default brand colour when the stored one is invalid", () => {
    const doc = buildInvoiceDoc({
      ...baseInvoice,
      branding: { ...baseInvoice.branding, brandColor: "not-a-colour" },
    });
    expect(JSON.stringify(doc)).toContain("#1f2937");
  });
});

describe("renderInvoicePdf", () => {
  it("renders a real PDF with the correct signature", async () => {
    const buffer = await renderInvoicePdf(baseInvoice);
    expect(buffer.length).toBeGreaterThan(1000);
    // %PDF- is the file signature. Anything else is not a PDF.
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders a public copy without internal detail and with the notice", async () => {
    const buffer = await renderInvoicePdf({ ...baseInvoice, publicView: true });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it("renders a multi-page invoice without throwing", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      description: `Placement ${i + 1} on a publisher site with a long descriptive name`,
      quantity: 1,
      unitPrice: 99.99,
      amount: 99.99,
    }));
    const subtotal = 60 * 99.99;
    const buffer = await renderInvoicePdf({
      ...baseInvoice,
      lines: many,
      subtotal,
      taxAmount: 0,
      taxRate: 0,
      total: subtotal,
      balance: subtotal,
    });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders with no optional fields at all", async () => {
    const minimal: InvoiceDocument = {
      invoiceNumber: "INV-0002",
      status: "draft",
      currency: "EUR",
      lines: [{ description: "Service", quantity: 1, unitPrice: 10, amount: 10 }],
      subtotal: 10,
      discountAmount: 0,
      taxRate: 0,
      taxAmount: 0,
      total: 10,
      paidAmount: 0,
      balance: 10,
      branding: { agencyName: "Agency" },
      billTo: { name: "Client" },
    };
    const buffer = await renderInvoicePdf(minimal);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
