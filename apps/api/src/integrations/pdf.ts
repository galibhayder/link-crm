import pdfmake from "pdfmake";
// The explicit `.js` is required. The package ships `standard-fonts/Helvetica.js`
// with no extension mapping, and Node's ESM loader will not guess one — `tsx` in
// development does, which is why this only fails in a production build.
import Helvetica from "pdfmake/standard-fonts/Helvetica.js";
import type { TDocumentDefinitions, Content, TableCell } from "pdfmake/interfaces";

/**
 * PDF DOCUMENT BUILDER.
 *
 * One function produces the document definition, and BOTH `/preview` and `/pdf`
 * consume it. That is the only way "the preview matches the download" stays true
 * after either one is edited — two builders drift the moment someone fixes a
 * typo in one of them.
 *
 * FONTS. PDFMake ships the standard-14 Helvetica definitions in the package
 * itself (`pdfmake/standard-fonts/Helvetica`), addressed by NAME rather than by
 * embedding a font file. That means no TTF assets, no extra dependency and a
 * smaller PDF. The trade-off is that standard-14 covers Latin-1 only, so a name
 * or symbol outside that set renders as a gap; the fix if it ever matters is to
 * register Roboto (also bundled) instead. No code change would be needed beyond
 * the `addFonts` call below.
 *
 * PDFMake 0.3 registers fonts once, globally, then produces buffers per document.
 */
pdfmake.addFonts(Helvetica);

const FONT = "Helvetica";

// ---------------------------------------------------------------------------
// Money formatting
// ---------------------------------------------------------------------------

/**
 * Formats an amount for an ISO currency code.
 *
 * `minorUnits` decides the decimal count explicitly rather than trusting the
 * locale table, because a JPY invoice showing ".00" is a correctness bug, not a
 * cosmetic one. Falls back to a plain 2dp number for codes `Intl` rejects, so an
 * unknown code degrades rather than throwing inside PDF generation.
 */
export function formatMoney(amount: number | string, currency: string): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  const safe = Number.isFinite(value) ? value : 0;

  const zeroDecimal = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF"]);
  const digits = zeroDecimal.has(currency) ? 0 : 2;

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(safe);
  } catch {
    return `${currency} ${safe.toFixed(digits)}`;
  }
}

/** A plain grouping number, for quantities and word counts. */
export function formatNumber(value: number | string, digits = 2): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "0";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(n);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * Formats a deduction so it visibly REDUCES the total.
 *
 * `Intl.NumberFormat` renders a positive amount with no sign, so a discount row
 * reading "$150.00" next to "Subtotal $2,150.00" reads as an addition — on an
 * invoice that is a financial misstatement, not a cosmetic issue.
 *
 * The Unicode minus (U+2212) is deliberately NOT used: Helvetica's standard-14
 * character set is Latin-1, and U+2212 renders as a blank, which produced exactly
 * the same ambiguity (verified by rendering the PDF). A hyphen-minus from ASCII is
 * always present. Parentheses are a second, unambiguous convention.
 */
function deduction(amount: number, currency: string): string {
  const formatted = formatMoney(Math.abs(amount), currency);
  // Accountancy convention: parentheses mean negative. Matches the minus sign's
  // message without relying on a glyph.
  return `(${formatted})`;
}

// ---------------------------------------------------------------------------
// The document model
//
// Deliberately a plain data structure with no internal identifiers. What the
// invoice needs to PRINT is all that crosses this boundary, which is also what
// gets frozen into the snapshot on issue.
// ---------------------------------------------------------------------------

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  /** Printed when a line is tied to a placement; omitted otherwise. */
  targetUrl?: string | null;
}

export interface InvoiceBranding {
  agencyName: string;
  agencyEmail?: string | null;
  agencyPhone?: string | null;
  agencyAddress?: string | null;
  logoUrl?: string | null;
  brandColor?: string | null;
  invoicePrefix?: string | null;
}

export interface InvoiceParty {
  name: string;
  legalName?: string | null;
  address?: Record<string, unknown> | null;
  taxId?: string | null;
  email?: string | null;
}

export interface InvoiceDocument {
  invoiceNumber: string;
  status: string;
  issuedAt?: string | null;
  dueDate?: string | null;
  currency: string;
  lines: InvoiceLine[];
  subtotal: number;
  discountAmount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  paidAmount: number;
  balance: number;
  notes?: string | null;
  paymentInstructions?: string | null;
  branding: InvoiceBranding;
  billTo: InvoiceParty;
  /** Populated only when the document is generated for a share link. */
  publicView?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  draft: "DRAFT",
  issued: "ISSUED",
  published: "ISSUED",
  partially_paid: "PART PAYMENT RECEIVED",
  paid: "PAID",
  overdue: "OVERDUE",
  cancelled: "CANCELLED",
};

const STATUS_COLOR: Record<string, string> = {
  draft: "#6b7280",
  issued: "#2563eb",
  published: "#2563eb",
  partially_paid: "#b45309",
  paid: "#15803d",
  overdue: "#b91c1c",
  cancelled: "#6b7280",
};

/** Formats a billing address object into printable lines. */
function addressLines(address: Record<string, unknown> | null | undefined): string[] {
  if (!address || typeof address !== "object") return [];
  const order = ["line1", "line2", "city", "state", "postalCode", "postcode", "zip", "country"];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const key of order) {
    const v = address[key];
    if (typeof v === "string" && v.trim()) {
      out.push(v.trim());
      seen.add(key);
    }
  }
  // Anything not in the known order, so a differently-shaped address still prints.
  for (const [k, v] of Object.entries(address)) {
    if (seen.has(k)) continue;
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document definition
// ---------------------------------------------------------------------------

export function buildInvoiceDoc(inv: InvoiceDocument): TDocumentDefinitions {
  const brand = inv.branding.brandColor && /^#[0-9a-f]{6}$/i.test(inv.branding.brandColor)
    ? inv.branding.brandColor
    : "#1f2937";
  const currency = inv.currency || "USD";
  const money = (n: number) => formatMoney(n, currency);

  const statusLabel = STATUS_LABEL[inv.status] ?? inv.status.toUpperCase();
  const statusColor = STATUS_COLOR[inv.status] ?? "#374151";

  // ---- header: brand block, then the invoice identity -------------------------
  // The organisation's logo, when one is configured.
  //
  // PDFMake takes a data URI for an embedded image, which is exactly the form the
  // logo is stored in — so this needs no file system, no HTTP fetch and no temp
  // file. It was declared on `InvoiceBranding` from the start but never rendered,
  // which meant an uploaded logo appeared everywhere EXCEPT the one document a
  // client actually receives.
  //
  // `fit` constrains the mark without distorting it; without it a wide logo would
  // push the agency name off the page.
  const logo: Content | null =
    inv.branding.logoUrl && inv.branding.logoUrl.startsWith("data:image/")
      ? { image: inv.branding.logoUrl, fit: [120, 44], margin: [0, 0, 0, 8] }
      : null;

  const headerLeft: Content = {
    stack: [
      ...(logo ? [logo] : []),
      { text: inv.branding.agencyName, style: "agencyName" },
      ...(inv.branding.agencyEmail ? [{ text: inv.branding.agencyEmail, style: "brandMeta" }] : []),
      ...(inv.branding.agencyPhone ? [{ text: inv.branding.agencyPhone, style: "brandMeta" }] : []),
      ...(inv.branding.agencyAddress ? [{ text: inv.branding.agencyAddress, style: "brandMeta" }] : []),
    ],
  };

  const headerRight: Content = {
    alignment: "right",
    stack: [
      { text: "INVOICE", style: "docType" },
      { text: inv.invoiceNumber, style: "invoiceNumber" },
      {
        text: statusLabel,
        style: "statusPill",
        color: statusColor,
        border: [true, true, true, true],
        borderColor: [statusColor, statusColor, statusColor, statusColor],
      } as Content,
    ],
  };

  // ---- bill-to and dates -----------------------------------------------------
  const billLines = addressLines(inv.billTo.address);

  const detailsTable: Content = {
    layout: "noBorders",
    table: {
      widths: ["55%", "45%"],
      body: [
        [
          {
            stack: [
              { text: "BILL TO", style: "label" },
              { text: inv.billTo.legalName || inv.billTo.name, style: "partyName" },
              ...(inv.billTo.legalName && inv.billTo.legalName !== inv.billTo.name
                ? [{ text: inv.billTo.name, style: "partyMeta" }]
                : []),
              ...billLines.map((l) => ({ text: l, style: "partyMeta" })),
              ...(inv.billTo.email ? [{ text: inv.billTo.email, style: "partyMeta" }] : []),
              ...(inv.billTo.taxId ? [{ text: `Tax ID: ${inv.billTo.taxId}`, style: "partyMeta" }] : []),
            ],
          },
          {
            alignment: "right",
            stack: [
              {
                layout: "noBorders",
                table: {
                  widths: ["auto", "auto"],
                  body: [
                    [
                      { text: "Issue date", style: "labelRight" },
                      { text: formatDate(inv.issuedAt), style: "metaRight" },
                    ],
                    [
                      { text: "Due date", style: "labelRight" },
                      { text: formatDate(inv.dueDate), style: "metaRight" },
                    ],
                    [
                      { text: "Currency", style: "labelRight" },
                      { text: currency, style: "metaRight" },
                    ],
                  ],
                },
              },
            ],
          },
        ],
      ],
    },
  };

  // ---- line items ------------------------------------------------------------
  const lineRows: TableCell[][] = [
    [
      { text: "Description", style: "th" },
      { text: "Qty", style: "th", alignment: "right" },
      { text: "Unit price", style: "th", alignment: "right" },
      { text: "Amount", style: "th", alignment: "right" },
    ],
    ...inv.lines.map((line) => [
      {
        stack: [
          { text: line.description, style: "td" },
          ...(line.targetUrl ? [{ text: line.targetUrl, style: "tdSub" }] : []),
        ],
      },
      { text: formatNumber(line.quantity), style: "td", alignment: "right" },
      { text: money(line.unitPrice), style: "td", alignment: "right" },
      { text: money(line.amount), style: "td", alignment: "right" },
    ]),
  ];

  const itemsTable: Content = {
    table: {
      headerRows: 1,
      widths: ["*", 40, 90, 90],
      body: lineRows,
    },
    layout: {
      hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
        i === 0 || i === 1 || i === node.table.body.length ? 1 : 0.5,
      vLineWidth: () => 0,
      hLineColor: (i: number) => (i === 1 ? brand : "#e5e7eb"),
      paddingTop: () => 6,
      paddingBottom: () => 6,
    },
  };

  // ---- totals ----------------------------------------------------------------
  // Discount is shown only when it exists: an always-present "Discount: $0.00"
  // row invites the client to wonder what they are missing.
  const totalRows: TableCell[][] = [
    [
      { text: "Subtotal", style: "totalLabel" },
      { text: money(inv.subtotal), style: "totalValue", alignment: "right" },
    ],
  ];

  if (inv.discountAmount > 0) {
    totalRows.push([
      { text: "Discount", style: "totalLabel" },
      { text: deduction(inv.discountAmount, currency), style: "totalValue", alignment: "right" },
    ]);
  }

  if (inv.taxAmount > 0 || inv.taxRate > 0) {
    totalRows.push([
      { text: `Tax (${formatNumber(inv.taxRate, 2)}%)`, style: "totalLabel" },
      { text: money(inv.taxAmount), style: "totalValue", alignment: "right" },
    ]);
  }

  totalRows.push([
    { text: "Total", style: "grandLabel" },
    { text: money(inv.total), style: "grandValue", alignment: "right" },
  ]);

  // Payment state only where it means something. A draft has none.
  if (inv.status !== "draft" && inv.status !== "cancelled") {
    if (inv.paidAmount > 0) {
      totalRows.push([
        { text: "Payments received", style: "totalLabel" },
        { text: deduction(inv.paidAmount, currency), style: "totalValue", alignment: "right" },
      ]);
      totalRows.push([
        { text: "Balance due", style: "grandLabel" },
        { text: money(inv.balance), style: "grandValue", alignment: "right" },
      ]);
    }
  }

  const totalsTable: Content = {
    alignment: "right",
    layout: "noBorders",
    table: {
      widths: [120, 100],
      body: totalRows,
    },
  };

  // ---- footer ----------------------------------------------------------------
  const footerBlocks: Content[] = [];

  if (inv.paymentInstructions) {
    footerBlocks.push({
      stack: [
        { text: "PAYMENT INSTRUCTIONS", style: "label" },
        { text: inv.paymentInstructions, style: "body" },
      ],
      margin: [0, 16, 0, 0],
    });
  }

  if (inv.notes) {
    footerBlocks.push({
      stack: [
        { text: "NOTES", style: "label" },
        { text: inv.notes, style: "body" },
      ],
      margin: [0, 16, 0, 0],
    });
  }

  return {
    // A4 with deliberate margins; a 2.5cm left margin is what makes a printed
    // invoice look professional rather than merely correct.
    pageSize: "A4",
    pageMargins: [45, 45, 45, 60],

    defaultStyle: {
      font: FONT,
      fontSize: 9.5,
      color: "#111827",
    },

    styles: {
      agencyName: { fontSize: 16, bold: true, color: brand, margin: [0, 0, 0, 2] },
      brandMeta: { fontSize: 8.5, color: "#6b7280", margin: [0, 0, 0, 1] },
      docType: { fontSize: 9, bold: true, color: "#6b7280", characterSpacing: 1.5 },
      invoiceNumber: { fontSize: 18, bold: true, margin: [0, 2, 0, 6] },
      statusPill: { fontSize: 7.5, bold: true, characterSpacing: 0.8 },

      label: { fontSize: 7.5, bold: true, color: "#6b7280", characterSpacing: 1, margin: [0, 0, 0, 3] },
      labelRight: { fontSize: 8, color: "#6b7280" },
      partyName: { fontSize: 11, bold: true, margin: [0, 0, 0, 2] },
      partyMeta: { fontSize: 8.5, color: "#4b5563", margin: [0, 0, 0, 1] },
      metaRight: { fontSize: 8.5, color: "#111827", alignment: "right" },

      th: { fontSize: 8, bold: true, color: "#6b7280", characterSpacing: 0.5 },
      td: { fontSize: 9 },
      tdSub: { fontSize: 7.5, color: "#6b7280" },

      totalLabel: { fontSize: 9, color: "#4b5563" },
      totalValue: { fontSize: 9 },
      grandLabel: { fontSize: 10.5, bold: true },
      grandValue: { fontSize: 10.5, bold: true },

      body: { fontSize: 8.5, color: "#4b5563", lineHeight: 1.35 },
    },

    content: [
      {
        columns: [headerLeft, headerRight],
        columnGap: 20,
      },
      {
        // Brand rule.
        canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: brand }],
        margin: [0, 12, 0, 16],
      },
      detailsTable,
      { text: "", margin: [0, 10, 0, 0] },
      itemsTable,
      { margin: [0, 8, 0, 0], ...totalsTable } as Content,
      ...footerBlocks,
      // A public copy says so, so a forwarded PDF is self-describing.
      ...(inv.publicView
        ? [
            {
              text: "This is a client copy. Internal costs and supplier information are not shown.",
              style: "body",
              margin: [0, 18, 0, 0],
            } as Content,
          ]
        : []),
    ],

    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        {
          text: inv.branding.agencyEmail ?? "",
          fontSize: 7.5,
          color: "#9ca3af",
          margin: [45, 0, 0, 0],
        },
        {
          text: `${inv.invoiceNumber}  ·  Page ${currentPage} of ${pageCount}`,
          fontSize: 7.5,
          color: "#9ca3af",
          alignment: "right",
          margin: [0, 0, 45, 0],
        },
      ],
    }),

    // Never let a table header strand on its own page.
    pageBreakBefore: () => false,
  };
}

/** Renders the document to a Buffer for streaming. */
export async function renderInvoicePdf(inv: InvoiceDocument): Promise<Buffer> {
  return pdfmake.createPdf(buildInvoiceDoc(inv)).getBuffer();
}

/**
 * Renders an arbitrary report document.
 *
 * The six report templates share the invoice's typography and header but supply
 * their own body, so a report and an invoice look like they came from the same
 * agency rather than two different tools.
 */
export function buildReportDoc(input: {
  title: string;
  subtitle?: string;
  branding: InvoiceBranding;
  columns: Array<{ header: string; key: string; align?: "left" | "right"; width?: number | "auto" | "*" }>;
  rows: Array<Record<string, string | number | null>>;
  summary?: Array<{ label: string; value: string }>;
  footnote?: string;
}): TDocumentDefinitions {
  const brand = input.branding.brandColor && /^#[0-9a-f]{6}$/i.test(input.branding.brandColor)
    ? input.branding.brandColor
    : "#1f2937";

  const widths = input.columns.map((c) => c.width ?? "*");

  const body: TableCell[][] = [
    input.columns.map((c) => ({ text: c.header, style: "th", alignment: c.align ?? "left" })),
    ...input.rows.map((row) =>
      input.columns.map((c) => ({
        text: row[c.key] == null ? "—" : String(row[c.key]),
        style: "td",
        alignment: c.align ?? "left",
      })),
    ),
  ];

  return {
    pageSize: "A4",
    pageOrientation: input.columns.length > 6 ? "landscape" : "portrait",
    pageMargins: [40, 40, 40, 55],

    defaultStyle: { font: FONT, fontSize: 8.5, color: "#111827" },

    styles: {
      agencyName: { fontSize: 13, bold: true, color: brand },
      title: { fontSize: 17, bold: true, margin: [0, 10, 0, 2] },
      subtitle: { fontSize: 9, color: "#6b7280", margin: [0, 0, 0, 12] },
      th: { fontSize: 7.5, bold: true, color: "#6b7280", characterSpacing: 0.4 },
      td: { fontSize: 8 },
      sumLabel: { fontSize: 8.5, color: "#4b5563" },
      sumValue: { fontSize: 8.5, bold: true },
    },

    content: [
      { text: input.branding.agencyName, style: "agencyName" },
      { text: input.title, style: "title" },
      ...(input.subtitle ? [{ text: input.subtitle, style: "subtitle" } as Content] : []),
      {
        table: { headerRows: 1, widths, body },
        layout: {
          hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
            i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.3,
          vLineWidth: () => 0,
          hLineColor: (i: number) => (i === 1 ? brand : "#e5e7eb"),
          paddingTop: () => 4,
          paddingBottom: () => 4,
        },
      },
      ...(input.summary && input.summary.length
        ? [
            {
              alignment: "right",
              layout: "noBorders",
              table: {
                widths: [140, 100],
                body: input.summary.map((s) => [
                  { text: s.label, style: "sumLabel", alignment: "right" },
                  { text: s.value, style: "sumValue", alignment: "right" },
                ]),
              },
              margin: [0, 12, 0, 0],
            } as Content,
          ]
        : []),
      ...(input.footnote
        ? [{ text: input.footnote, fontSize: 7.5, color: "#9ca3af", margin: [0, 14, 0, 0] } as Content]
        : []),
    ],

    footer: (currentPage: number, pageCount: number) => ({
      text: `${input.branding.agencyName}  ·  ${input.title}  ·  Page ${currentPage} of ${pageCount}`,
      fontSize: 7.5,
      color: "#9ca3af",
      alignment: "center",
      margin: [0, 20, 0, 0],
    }),
  };
}

export async function renderReportPdf(input: Parameters<typeof buildReportDoc>[0]): Promise<Buffer> {
  return pdfmake.createPdf(buildReportDoc(input)).getBuffer();
}
