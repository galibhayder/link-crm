import { Router, type NextFunction, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { asyncRoute, ok } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { admin } from "../../integrations/supabase.js";
import { audit } from "../../lib/audit.js";
import { attachmentHeader } from "../../integrations/tabular.js";
import { renderInvoicePdf, type InvoiceDocument, type InvoiceLine } from "../../integrations/pdf.js";
import { logger } from "../../lib/logger.js";

/**
 * PUBLIC INVOICE ACCESS — /public/v1
 *
 * This router is mounted BEFORE `authenticate` in app.ts, because the whole point
 * is that a recipient with a link does not have an account. That makes it the most
 * security-sensitive surface in the project, so every decision here is defensive.
 *
 * THE TOKEN IS NEVER STORED. Only SHA-256 is written to the database. A dump of
 * `invoice_share_links` therefore produces no working URLs — the hash cannot be
 * turned back into a token, and the raw value exists only in the URL the agency
 * copied once.
 *
 * THE PAYLOAD IS THE SNAPSHOT. Not live invoice rows, not a join. The snapshot is
 * built at issue time from an explicit list of printable fields, so internal
 * costs never enter it and therefore cannot be projected out of it by mistake.
 * What you see here is a subset of what the agency already agreed to send.
 *
 * EVERY FAILURE IS 404. Unknown token, revoked, expired, cancelled invoice — all
 * identical. Telling a caller "this link was revoked" confirms the token was once
 * valid, which is information they should not get for free.
 */

export const publicInvoicesRouter: Router = Router();

const tokenParams = z.object({ token: z.string().min(20).max(200) });

// ---------------------------------------------------------------------------
// Rate limiting
//
// A token has 256 bits of entropy, so brute force is not a realistic threat. This
// exists to stop trivial hammering of the endpoint — a loop that costs the API CPU
// rendering PDFs. In-memory and per-process is enough to blunt that; a distributed
// limiter would need shared state and is not warranted for invoice links.
// ---------------------------------------------------------------------------
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip ?? "unknown";
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || entry.resetAt < now) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  entry.count += 1;
  if (entry.count > MAX_REQUESTS) {
    res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
    res.status(429).json({
      error: { code: "rate_limited", message: "Too many requests. Try again shortly." },
    });
    return;
  }
  next();
}

// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) {
    if (entry.resetAt < now) hits.delete(key);
  }
}, WINDOW_MS).unref?.();

publicInvoicesRouter.use(rateLimit);

/** Headers that keep a shared or revoked link out of caches and search engines. */
function setPublicHeaders(res: Response): void {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  // A revoked link must not be served from an intermediary's cache.
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
}

interface ShareRow {
  invoice_id: string;
  organization_id: string;
  invoice_number: string;
  snapshot: SnapshotShape | null;
  issued_at: string | null;
  due_date: string | null;
  total: string | number;
  paid_amount: string | number;
  balance: string | number;
  effective_status: string;
  expires_at: string | null;
}

interface SnapshotShape {
  lines?: InvoiceLine[];
  subtotal?: number;
  discountAmount?: number;
  taxRate?: number;
  taxAmount?: number;
  total?: number;
  currency?: string;
  billTo?: {
    name?: string;
    legalName?: string | null;
    address?: Record<string, unknown> | null;
    taxId?: string | null;
  };
  branding?: {
    agencyName?: string;
    agencyEmail?: string | null;
    agencyPhone?: string | null;
    agencyAddress?: string | null;
    logoUrl?: string | null;
    brandColor?: string | null;
  };
  notes?: string | null;
  paymentInstructions?: string | null;
}

const num = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * Resolves a token to its share row.
 *
 * The SHA-256 is computed here rather than in SQL so the raw token never travels
 * to the database at all — not even inside a query string in a log.
 */
async function resolveToken(token: string): Promise<ShareRow | null> {
  const hash = createHash("sha256").update(token).digest("hex");

  const { data, error } = await admin().rpc("resolve_invoice_share", { p_token_hash: hash });
  if (error) {
    logger.warn({ err: error }, "invoice share resolution failed");
    return null;
  }

  const rows = (data ?? []) as ShareRow[];
  return rows[0] ?? null;
}

/**
 * The public projection.
 *
 * An allow-list, not a deny-list. Every field is named here, so a column added to
 * the snapshot later is not silently published — it has to be added deliberately.
 */
function toPublicInvoice(row: ShareRow) {
  const snap = row.snapshot ?? {};

  return {
    invoiceNumber: row.invoice_number,
    // "published" is internal vocabulary for a sharing state, not something a
    // recipient should see on their bill. To them it is simply issued. The
    // underlying status is still returned — the mapping happens here, at the
    // presentation boundary, rather than by weakening the resolver's ladder.
    status: row.effective_status === "published" ? "issued" : row.effective_status,
    issuedAt: row.issued_at,
    dueDate: row.due_date,
    expiresAt: row.expires_at,
    currency: snap.currency ?? "USD",
    lines: (snap.lines ?? []).map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      amount: l.amount,
      // A public page shows that a line relates to a page, but the target URL is
      // intentionally omitted: it is the agency's placement detail, not the
      // client's invoice detail.
    })),
    subtotal: snap.subtotal ?? 0,
    discountAmount: snap.discountAmount ?? 0,
    taxRate: snap.taxRate ?? 0,
    taxAmount: snap.taxAmount ?? 0,
    total: num(row.total),
    paidAmount: num(row.paid_amount),
    balance: num(row.balance),
    notes: snap.notes ?? null,
    paymentInstructions: snap.paymentInstructions ?? null,
    billTo: {
      name: snap.billTo?.legalName || snap.billTo?.name || "Client",
      address: snap.billTo?.address ?? null,
      taxId: snap.billTo?.taxId ?? null,
    },
    branding: {
      agencyName: snap.branding?.agencyName ?? "Agency",
      agencyEmail: snap.branding?.agencyEmail ?? null,
      agencyPhone: snap.branding?.agencyPhone ?? null,
      agencyAddress: snap.branding?.agencyAddress ?? null,
      logoUrl: snap.branding?.logoUrl ?? null,
      brandColor: snap.branding?.brandColor ?? null,
    },
  };
}

/** Builds the PDF from the frozen snapshot, never from live rows. */
function toDocument(row: ShareRow): InvoiceDocument {
  const snap = row.snapshot ?? {};

  return {
    invoiceNumber: row.invoice_number,
    // Same presentation mapping as the JSON payload, so the PDF and the page
    // cannot disagree about what the recipient is looking at.
    status: row.effective_status === "published" ? "issued" : row.effective_status,
    issuedAt: row.issued_at,
    dueDate: row.due_date,
    currency: snap.currency ?? "USD",
    lines: snap.lines ?? [],
    subtotal: snap.subtotal ?? 0,
    discountAmount: snap.discountAmount ?? 0,
    taxRate: snap.taxRate ?? 0,
    taxAmount: snap.taxAmount ?? 0,
    total: num(row.total),
    paidAmount: num(row.paid_amount),
    balance: num(row.balance),
    notes: snap.notes ?? null,
    paymentInstructions: snap.paymentInstructions ?? null,
    branding: {
      agencyName: snap.branding?.agencyName ?? "Agency",
      agencyEmail: snap.branding?.agencyEmail ?? null,
      agencyPhone: snap.branding?.agencyPhone ?? null,
      agencyAddress: snap.branding?.agencyAddress ?? null,
      logoUrl: snap.branding?.logoUrl ?? null,
      brandColor: snap.branding?.brandColor ?? null,
    },
    billTo: {
      name: snap.billTo?.name ?? "Client",
      legalName: snap.billTo?.legalName ?? null,
      address: snap.billTo?.address ?? null,
      taxId: snap.billTo?.taxId ?? null,
    },
    publicView: true,
  };
}

/**
 * Records access.
 *
 * `actor_id` is null because there is no user; `actor_name_snapshot` says why, so
 * an auditor reading the log understands these entries came from a public link
 * rather than an unattributed internal action.
 */
async function logAccess(row: ShareRow, action: "view" | "download", ip: string | null, userAgent: string | null) {
  await audit({
    organizationId: row.organization_id,
    actorId: null,
    actorName: "public link",
    actorRole: "public",
    entityType: "invoice",
    entityId: row.invoice_id,
    action,
    diff: { invoiceNumber: row.invoice_number, channel: "public_link" },
    ip,
    userAgent,
  });
}

// ---------------------------------------------------------------------------
// GET /public/v1/invoices/:token
// ---------------------------------------------------------------------------
publicInvoicesRouter.get(
  "/invoices/:token",
  asyncRoute(async (req, res) => {
    setPublicHeaders(res);

    const parsed = tokenParams.safeParse(req.params);
    if (!parsed.success) throw Errors.notFound("Invoice");

    const row = await resolveToken(parsed.data.token);
    if (!row) throw Errors.notFound("Invoice");

    // Best-effort bookkeeping: a counter failure must never fail the page.
    admin()
      .rpc("touch_invoice_share", { p_token_hash: createHash("sha256").update(parsed.data.token).digest("hex") })
      .then(({ error }) => {
        if (error) logger.warn({ err: error }, "could not record share link access");
      });

    void logAccess(row, "view", req.ip ?? null, req.headers["user-agent"] ?? null);

    ok(res, toPublicInvoice(row));
  }),
);

// ---------------------------------------------------------------------------
// GET /public/v1/invoices/:token/pdf
// ---------------------------------------------------------------------------
publicInvoicesRouter.get(
  "/invoices/:token/pdf",
  asyncRoute(async (req, res) => {
    setPublicHeaders(res);

    const parsed = tokenParams.safeParse(req.params);
    if (!parsed.success) throw Errors.notFound("Invoice");

    const row = await resolveToken(parsed.data.token);
    if (!row) throw Errors.notFound("Invoice");

    const pdf = await renderInvoicePdf(toDocument(row));

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", attachmentHeader(`Invoice-${row.invoice_number}.pdf`));
    res.setHeader("Content-Length", String(pdf.length));
    res.end(pdf);

    void logAccess(row, "download", req.ip ?? null, req.headers["user-agent"] ?? null);
  }),
);
