/**
 * Money and margin arithmetic.
 *
 * Rule from the plan: money is never floating point. Every value here is a
 * "minor-unit-free" string-backed decimal handled with integer cents so that
 * `numeric(12,2)` in Postgres and the UI agree exactly.
 */

/** A numeric(12,2) value, expressed in integer cents to avoid float drift. */
export type Cents = number;

export function toCents(amount: number | string | null | undefined): Cents {
  if (amount === null || amount === undefined || amount === "") return 0;
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return 0;
  // Round half away from zero at the cent, matching numeric(12,2) casts.
  return Math.sign(n) * Math.round(Math.abs(n) * 100);
}

export function fromCents(cents: Cents): number {
  return Math.round(cents) / 100;
}

/** Two-decimal string for display and for sending back to Postgres. */
export function formatCents(cents: Cents, currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(fromCents(cents));
}

/** Postgres-ready numeric literal. */
export function centsToNumeric(cents: Cents): string {
  return (Math.round(cents) / 100).toFixed(2);
}

export interface MarginResult {
  /** client rate minus supplier cost, in cents */
  marginCents: Cents;
  /** margin as a fraction of client rate, 0 when rate is zero */
  marginPct: number;
  /** markup on cost (rate / cost - 1), null when cost is zero */
  markupPct: number | null;
}

/**
 * Per-placement margin. Because tier 1 (client rate) and tier 2 (supplier cost)
 * live in different tables, this is the ONLY place the two are combined — and
 * only the API calls it, after `authorize('reports:margins')`.
 */
export function computeMargin(clientRate: number | string | null, supplierCost: number | string | null): MarginResult {
  const rate = toCents(clientRate);
  const cost = toCents(supplierCost);
  const marginCents = rate - cost;
  const marginPct = rate === 0 ? 0 : marginCents / rate;
  const markupPct = cost === 0 ? null : rate / cost - 1;
  return { marginCents, marginPct, markupPct };
}

/** One line item amount: quantity (2dp) x unit price. */
export function lineAmountCents(quantity: number | string, unitPriceCents: Cents): Cents {
  const q = typeof quantity === "string" ? Number(quantity) : quantity;
  if (!Number.isFinite(q)) return 0;
  return Math.round(q * unitPriceCents);
}

export interface InvoiceTotals {
  subtotalCents: Cents;
  taxAmountCents: Cents;
  totalCents: Cents;
}

/** Tax is applied to the subtotal, rounded once at the cent. */
export function invoiceTotals(lineAmounts: readonly Cents[], taxRatePct: number): InvoiceTotals {
  const subtotalCents = lineAmounts.reduce((sum, a) => sum + a, 0);
  const taxAmountCents = Math.round((subtotalCents * taxRatePct) / 100);
  return { subtotalCents, taxAmountCents, totalCents: subtotalCents + taxAmountCents };
}

/**
 * Anchor distribution for over-optimization checks. Returns share per type,
 * 0-safe when there are no placements yet.
 */
export function anchorDistribution(counts: Partial<Record<string, number>>): Record<string, number> {
  const entries = Object.entries(counts) as [string, number][];
  const total = entries.reduce((sum, [, n]) => sum + (n ?? 0), 0);
  if (total === 0) return {};
  return Object.fromEntries(entries.map(([k, n]) => [k, (n ?? 0) / total]));
}
