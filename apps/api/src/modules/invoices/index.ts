import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  invoiceCreateSchema,
  invoiceUpdateSchema,
  invoiceShareLinkSchema,
  paginationSchema,
  uuidSchema,
} from "@crm/shared";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, ok, validate, parsedQuery } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { admin, type TypedClient } from "../../integrations/supabase.js";
import { auditFromRequest, diffOf } from "../../lib/audit.js";
import { attachmentHeader } from "../../integrations/tabular.js";
import { renderInvoicePdf, type InvoiceDocument, type InvoiceLine } from "../../integrations/pdf.js";

/**
 * INVOICES.
 *
 * The organising idea is that an invoice is a DOCUMENT with a lifecycle, not a
 * mutable row. It is edited freely while `draft`; issuing freezes a snapshot;
 * after that, only money can change, and only through payments.
 *
 * WHY A SNAPSHOT AND NOT JUST A STATUS CHECK.
 *
 * A status check alone says "you may not edit this". It does not say what the
 * invoice SAID when it was issued. If the client's billing address is later
 * corrected, or a line item's description is tidied, a re-rendered PDF would
 * differ from the one the client received — and nobody could prove which was
 * right. The snapshot makes the issued document a fact.
 *
 * Payment state is deliberately NOT in the snapshot. It is joined live, so a PDF
 * downloaded after a part payment shows the correct balance. Content is frozen;
 * money is current.
 */
export const invoicesRouter: Router = Router();

const idParams = z.object({ id: uuidSchema });

const listQuery = paginationSchema.extend({
  clientId: uuidSchema.optional(),
  status: z.string().optional(),
  effectiveStatus: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------

interface InvoiceRow {
  id: string;
  organization_id: string;
  client_id: string;
  agency_partner_id: string | null;
  invoice_number: string;
  status: string;
  period_start: string;
  period_end: string;
  subtotal: string | number;
  discount_amount: string | number;
  tax_rate: string | number;
  tax_amount: string | number;
  total: string | number;
  currency: string;
  due_date: string | null;
  issued_at: string | null;
  published_at: string | null;
  cancelled_at: string | null;
  notes: string | null;
  payment_instructions: string | null;
  snapshot: unknown;
  snapshot_version: number;
  snapshot_hash: string | null;
}

interface LineRow {
  description: string;
  quantity: string | number;
  unit_price: string | number;
  amount: string | number;
  placement_id: string | null;
}

const num = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * Loads an invoice with its lines and the live paid amount.
 *
 * Takes the caller's RLS-scoped Supabase client, so a client_user calling the
 * portal equivalent gets only their own invoices without this function knowing
 * anything about roles.
 *
 * `effective_status` and `days_overdue` are read from `v_invoices`, NOT computed
 * here. There used to be a `deriveStatus()` in this module — a second copy of the
 * precedence ladder — and it had already drifted from the view on two reachable
 * cases (a zero-total past-due invoice, and a legacy stored `paid`). The status
 * rule now lives only in `app_private.invoice_effective_status` (migration 0031).
 */
async function loadInvoice(
  db: TypedClient,
  id: string,
): Promise<{
  invoice: InvoiceRow;
  lines: LineRow[];
  paid: number;
  effectiveStatus: string;
  daysOverdue: number;
  clientName: string;
  partnerName: string | null;
} | null> {
  const { data: invoiceData, error: invoiceErr } = await db
    .from("invoices")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (invoiceErr) throw Errors.internal(String(invoiceErr));

  const invoice = invoiceData as InvoiceRow | null;
  if (!invoice) return null;

  const [{ data: linesData }, { data: paymentsData }, { data: clientData }, { data: derived }] = await Promise.all([
    db.from("invoice_line_items").select("*").eq("invoice_id", id).order("sort_order"),
    db.from("payments").select("amount").eq("invoice_id", id),
    db.from("clients").select("id, name").eq("id", invoice.client_id).maybeSingle(),
    // The authoritative derived values. Selecting them rather than recomputing is
    // what makes the API, the PDF and the public page agree by construction.
    db.from("v_invoices").select("effective_status, days_overdue").eq("id", id).maybeSingle(),
  ]);

  // Conditional, so it is a separate call rather than a member of the Promise.all
  // (which would need a resolved promise just to keep the tuple size).
  const partnerData = invoice.agency_partner_id
    ? ((await db.from("agency_partners").select("id, name").eq("id", invoice.agency_partner_id).maybeSingle())
        .data as { name?: string } | null)
    : null;

  const payments = (paymentsData ?? []) as Array<{ amount: string | number }>;
  const paid = payments.reduce((s, p) => s + num(p.amount), 0);
  const view = derived as { effective_status?: string; days_overdue?: number } | null;

  return {
    invoice,
    lines: (linesData ?? []) as LineRow[],
    paid,
    effectiveStatus: view?.effective_status ?? "draft",
    daysOverdue: view?.days_overdue ?? 0,
    clientName: (clientData as { name?: string } | null)?.name ?? "Client",
    partnerName: partnerData?.name ?? null,
  };
}

/**
 * Builds the printable document.
 *
 * Reads the SNAPSHOT when one exists, and the live row when it does not (i.e.
 * still a draft). That single branch is what makes "the PDF matches what was
 * issued": once a snapshot exists, edits to the underlying row cannot affect the
 * output.
 */
async function buildDocument(
  orgId: string,
  invoice: InvoiceRow,
  lines: LineRow[],
  paid: number,
  effectiveStatus: string,
  clientName: string,
  partnerName: string | null,
  publicView = false,
): Promise<InvoiceDocument> {
  const { data: org } = await admin()
    .from("organizations")
    .select("name, logo_url, brand_color, invoice_prefix")
    .eq("id", orgId)
    .maybeSingle();

  const orgRow = (org ?? {}) as {
    name?: string;
    logo_url?: string | null;
    brand_color?: string | null;
    invoice_prefix?: string | null;
  };

  const { data: billing } = await admin()
    .from("client_billing_profiles")
    .select("legal_name, billing_address, tax_id, tax_rate")
    .eq("client_id", invoice.client_id)
    .maybeSingle();

  const billingRow = (billing ?? {}) as {
    legal_name?: string | null;
    billing_address?: Record<string, unknown> | null;
    tax_id?: string | null;
  };

  const branding = {
    agencyName: orgRow.name ?? "Agency",
    logoUrl: orgRow.logo_url ?? null,
    brandColor: orgRow.brand_color ?? null,
    invoicePrefix: orgRow.invoice_prefix ?? null,
  };

  // ---- snapshot path ------------------------------------------------------
  const snap = invoice.snapshot as
    | {
        lines?: InvoiceLine[];
        subtotal?: number;
        discountAmount?: number;
        taxRate?: number;
        taxAmount?: number;
        total?: number;
        billTo?: { name: string; legalName?: string | null; address?: Record<string, unknown> | null; taxId?: string | null };
        branding?: typeof branding;
        notes?: string | null;
        paymentInstructions?: string | null;
      }
    | null;

  if (snap && Array.isArray(snap.lines)) {
    return {
      invoiceNumber: invoice.invoice_number,
      // Supplied by the caller from `v_invoices` — never re-derived here.
      status: effectiveStatus,
      issuedAt: invoice.issued_at,
      dueDate: invoice.due_date,
      currency: invoice.currency,
      lines: snap.lines,
      subtotal: snap.subtotal ?? 0,
      discountAmount: snap.discountAmount ?? 0,
      taxRate: snap.taxRate ?? 0,
      taxAmount: snap.taxAmount ?? 0,
      total: snap.total ?? 0,
      // Live figures, deliberately not frozen.
      paidAmount: paid,
      balance: (snap.total ?? 0) - paid,
      notes: snap.notes ?? null,
      paymentInstructions: snap.paymentInstructions ?? null,
      branding: snap.branding ?? branding,
      billTo: snap.billTo ?? { name: clientName },
      publicView,
    };
  }

  // ---- live path (draft) --------------------------------------------------
  return {
    invoiceNumber: invoice.invoice_number,
    status: effectiveStatus,
    issuedAt: invoice.issued_at,
    dueDate: invoice.due_date,
    currency: invoice.currency,
    lines: lines.map((l) => ({
      description: l.description,
      quantity: num(l.quantity),
      unitPrice: num(l.unit_price),
      amount: num(l.amount),
    })),
    subtotal: num(invoice.subtotal),
    discountAmount: num(invoice.discount_amount),
    taxRate: num(invoice.tax_rate),
    taxAmount: num(invoice.tax_amount),
    total: num(invoice.total),
    paidAmount: paid,
    balance: num(invoice.total) - paid,
    notes: invoice.notes,
    paymentInstructions: invoice.payment_instructions,
    branding,
    billTo: {
      name: partnerName ?? clientName,
      legalName: billingRow.legal_name ?? null,
      address: billingRow.billing_address ?? null,
      taxId: billingRow.tax_id ?? null,
    },
    publicView,
  };
}

/** Allocates the next invoice number inside the per-organisation counter. */
async function nextInvoiceNumber(orgId: string): Promise<string> {
  const { data: org, error: orgErr } = await admin()
    .from("organizations")
    .select("invoice_prefix")
    .eq("id", orgId)
    .single();
  if (orgErr) throw Errors.internal(orgErr.message);

  const { data: seq, error: seqErr } = await admin().rpc("next_document_number_rpc", {
    p_org: orgId,
    p_type: "invoice",
  });
  if (seqErr) throw Errors.internal(seqErr.message);

  const prefix = (org as { invoice_prefix?: string } | null)?.invoice_prefix ?? "INV";
  return `${prefix}-${String(seq).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
invoicesRouter.get(
  "/",
  authorize("invoices:read"),
  validate({ query: listQuery }),
  asyncRoute(async (req, res) => {
    const { page, limit, order, clientId, status, effectiveStatus } = parsedQuery<z.infer<typeof listQuery>>(req);

    // Reads the VIEW, so every row carries effective_status and balance without
    // the caller re-deriving them.
    let query = req.auth!.db
      .from("v_invoices")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: order === "asc" })
      .range((page - 1) * limit, page * limit - 1);

    if (clientId) query = query.eq("client_id", clientId);
    if (status) query = query.eq("status", status);
    if (effectiveStatus) query = query.eq("effective_status", effectiveStatus);

    const { data, error, count } = await query;
    if (error) throw Errors.internal(error.message);

    ok(res, data ?? [], { page, limit, total: count ?? 0 });
  }),
);

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
invoicesRouter.get(
  "/:id([0-9a-fA-F-]{36})",
  authorize("invoices:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const loaded = await loadInvoice(req.auth!.db, id);
    if (!loaded) throw Errors.notFound("Invoice");

    // Share state is part of the detail screen, so the UI never has to infer
    // "is this public?" from a status field.
    const { data: links } = await req.auth!.db
      .from("invoice_share_links")
      .select("id, created_at, expires_at, revoked_at, last_accessed_at, access_count")
      .eq("invoice_id", id)
      .order("created_at", { ascending: false });

    const rows = (links ?? []) as Array<{ revoked_at: string | null; expires_at: string | null }>;
    const active = rows.find(
      (l) => !l.revoked_at && (!l.expires_at || new Date(l.expires_at) > new Date()),
    );

    ok(res, {
      ...loaded.invoice,
      client_name: loaded.clientName,
      agency_partner_name: loaded.partnerName,
      paid_amount: loaded.paid,
      balance: num(loaded.invoice.total) - loaded.paid,
      effective_status: loaded.effectiveStatus,
      // Read from v_invoices alongside the status, so the two cannot disagree.
      days_overdue: loaded.daysOverdue,
      line_items: loaded.lines,
      share: {
        active: Boolean(active),
        expires_at: (active as { expires_at?: string | null } | undefined)?.expires_at ?? null,
        links: rows,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
invoicesRouter.post(
  "/",
  authorize("invoices:write"),
  validate({ body: invoiceCreateSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof invoiceCreateSchema>;

    const number = await nextInvoiceNumber(req.auth!.orgId);

    // Terms default from the client's billing profile so an invoice does not
    // silently offer 30 days to a client on net-14.
    const { data: billing } = await admin()
      .from("client_billing_profiles")
      .select("payment_terms_days")
      .eq("client_id", b.clientId)
      .maybeSingle();

    const terms = (billing as { payment_terms_days?: number } | null)?.payment_terms_days ?? 30;
    const dueDate = b.dueDate ?? new Date(Date.now() + terms * 86_400_000);

    const { data: invoice, error } = await req.auth!.db
      .from("invoices")
      .insert({
        organization_id: req.auth!.orgId,
        client_id: b.clientId,
        agency_partner_id: b.agencyPartnerId ?? null,
        invoice_number: number,
        period_start: b.periodStart.toISOString().slice(0, 10),
        period_end: b.periodEnd.toISOString().slice(0, 10),
        status: "draft",
        tax_rate: b.taxRate,
        discount_amount: b.discountAmount,
        currency: b.currency,
        due_date: dueDate.toISOString().slice(0, 10),
        notes: b.notes ?? null,
        payment_instructions: b.paymentInstructions ?? null,
      })
      .select()
      .single();

    if (error) throw Errors.internal(error.message);
    const row = invoice as InvoiceRow;

    const lines = b.lineItems.map((li, idx) => ({
      organization_id: req.auth!.orgId,
      invoice_id: row.id,
      description: li.description,
      quantity: li.quantity,
      unit_price: li.unitPrice,
      placement_id: li.placementId ?? null,
      sort_order: idx,
    }));

    const { error: lineErr } = await req.auth!.db.from("invoice_line_items").insert(lines);
    if (lineErr) throw Errors.internal(lineErr.message);

    // Totals are recomputed by trigger; re-read for an accurate response.
    const { data: complete } = await req.auth!.db
      .from("invoices")
      .select("*, line_items:invoice_line_items(*)")
      .eq("id", row.id)
      .single();

    await auditFromRequest(req, {
      entityType: "invoice",
      entityId: row.id,
      action: "create",
      diff: { invoiceNumber: number, total: (complete as InvoiceRow | null)?.total ?? null },
    });

    created(res, complete);
  }),
);

// ---------------------------------------------------------------------------
// Update — draft only
// ---------------------------------------------------------------------------
invoicesRouter.patch(
  "/:id([0-9a-fA-F-]{36})",
  authorize("invoices:write"),
  validate({ params: idParams, body: invoiceUpdateSchema }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const b = req.body as z.infer<typeof invoiceUpdateSchema>;

    const { data: existing } = await req.auth!.db
      .from("invoices")
      .select("id, status, total, currency")
      .eq("id", id)
      .maybeSingle();

    if (!existing) throw Errors.notFound("Invoice");

    // An issued invoice is a document that has been sent. Editing it would mean
    // the client holds a PDF that no longer matches the record.
    if ((existing as { status: string }).status !== "draft") {
      throw Errors.badRequest(
        "Only draft invoices can be edited. Issue the invoice to lock it, or cancel and create a replacement.",
      );
    }

    const patch: Record<string, unknown> = {};
    if (b.agencyPartnerId !== undefined) patch.agency_partner_id = b.agencyPartnerId ?? null;
    if (b.taxRate !== undefined) patch.tax_rate = b.taxRate;
    if (b.discountAmount !== undefined) patch.discount_amount = b.discountAmount;
    if (b.currency !== undefined) patch.currency = b.currency;
    if (b.dueDate !== undefined) patch.due_date = b.dueDate ? b.dueDate.toISOString().slice(0, 10) : null;
    if (b.notes !== undefined) patch.notes = b.notes ?? null;
    if (b.paymentInstructions !== undefined) patch.payment_instructions = b.paymentInstructions ?? null;

    if (Object.keys(patch).length > 0) {
      const { error } = await req.auth!.db.from("invoices").update(patch).eq("id", id);
      if (error) throw Errors.internal(error.message);
    }

    // Replace lines wholesale: an invoice is an ordered document, and patching
    // items one by one is how `sort_order` ends up with duplicates.
    if (b.lineItems) {
      const { error: delErr } = await req.auth!.db
        .from("invoice_line_items")
        .delete()
        .eq("invoice_id", id);
      if (delErr) throw Errors.internal(delErr.message);

      const { error: insErr } = await req.auth!.db.from("invoice_line_items").insert(
        b.lineItems.map((li, idx) => ({
          organization_id: req.auth!.orgId,
          invoice_id: id,
          description: li.description,
          quantity: li.quantity,
          unit_price: li.unitPrice,
          placement_id: li.placementId ?? null,
          sort_order: idx,
        })),
      );
      if (insErr) throw Errors.internal(insErr.message);
    }

    const { data: complete } = await req.auth!.db
      .from("invoices")
      .select("*, line_items:invoice_line_items(*)")
      .eq("id", id)
      .single();

    await auditFromRequest(req, {
      entityType: "invoice",
      entityId: id,
      action: "update",
      diff: diffOf(existing, complete),
    });

    ok(res, complete);
  }),
);

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------
invoicesRouter.post(
  "/:id([0-9a-fA-F-]{36})/duplicate",
  authorize("invoices:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const loaded = await loadInvoice(req.auth!.db, id);
    if (!loaded) throw Errors.notFound("Invoice");

    const number = await nextInvoiceNumber(req.auth!.orgId);

    const { data: copy, error } = await req.auth!.db
      .from("invoices")
      .insert({
        organization_id: req.auth!.orgId,
        client_id: loaded.invoice.client_id,
        agency_partner_id: loaded.invoice.agency_partner_id,
        invoice_number: number,
        period_start: loaded.invoice.period_start,
        period_end: loaded.invoice.period_end,
        status: "draft",
        tax_rate: loaded.invoice.tax_rate,
        discount_amount: loaded.invoice.discount_amount,
        currency: loaded.invoice.currency,
        due_date: loaded.invoice.due_date,
        notes: loaded.invoice.notes,
        payment_instructions: loaded.invoice.payment_instructions,
        // No snapshot, no payments, no share link: it is a fresh document.
      })
      .select()
      .single();

    if (error) throw Errors.internal(error.message);
    const row = copy as InvoiceRow;

    if (loaded.lines.length > 0) {
      const { error: lineErr } = await req.auth!.db.from("invoice_line_items").insert(
        loaded.lines.map((li, idx) => ({
          organization_id: req.auth!.orgId,
          invoice_id: row.id,
          description: li.description,
          quantity: li.quantity,
          unit_price: li.unit_price,
          placement_id: li.placement_id,
          sort_order: idx,
        })),
      );
      if (lineErr) throw Errors.internal(lineErr.message);
    }

    await auditFromRequest(req, {
      entityType: "invoice",
      entityId: row.id,
      action: "create",
      diff: { duplicatedFrom: id, invoiceNumber: number },
    });

    const { data: complete } = await req.auth!.db
      .from("invoices")
      .select("*, line_items:invoice_line_items(*)")
      .eq("id", row.id)
      .single();

    created(res, complete);
  }),
);

// ---------------------------------------------------------------------------
// Issue — freezes the snapshot
// ---------------------------------------------------------------------------
invoicesRouter.post(
  "/:id([0-9a-fA-F-]{36})/issue",
  authorize("invoices:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const loaded = await loadInvoice(req.auth!.db, id);
    if (!loaded) throw Errors.notFound("Invoice");

    if (loaded.invoice.status !== "draft") {
      throw Errors.badRequest("Only a draft invoice can be issued");
    }

    if (loaded.lines.length === 0) {
      throw Errors.badRequest("An invoice with no line items cannot be issued");
    }

    // Build the document from live data NOW, and freeze it. Everything the client
    // will ever see about the content of this invoice comes from this object.
    const document = await buildDocument(
      req.auth!.orgId,
      loaded.invoice,
      loaded.lines,
      loaded.paid,
      loaded.effectiveStatus,
      loaded.clientName,
      loaded.partnerName,
    );

    const snapshot = {
      lines: document.lines,
      subtotal: document.subtotal,
      discountAmount: document.discountAmount,
      taxRate: document.taxRate,
      taxAmount: document.taxAmount,
      total: document.total,
      currency: document.currency,
      billTo: document.billTo,
      branding: document.branding,
      notes: document.notes,
      paymentInstructions: document.paymentInstructions,
      // A snapshot identity, so "is this the PDF that was issued?" is answerable.
      frozenAt: new Date().toISOString(),
    };

    const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

    const { data, error } = await req.auth!.db
      .from("invoices")
      .update({
        status: "issued",
        issued_at: new Date().toISOString(),
        snapshot,
        snapshot_version: loaded.invoice.snapshot_version + 1,
        snapshot_hash: hash,
      })
      .eq("id", id)
      .eq("status", "draft")
      .select()
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.badRequest("Invoice was modified concurrently; reload and try again");

    await auditFromRequest(req, {
      entityType: "invoice",
      entityId: id,
      action: "status_change",
      diff: { from: "draft", to: "issued", snapshotHash: hash },
    });

    ok(res, data);
  }),
);

// ---------------------------------------------------------------------------
// Publish / unpublish
//
// Publishing is what makes an invoice shareable. It is a SEPARATE action from
// issuing, and it is never automatic — the brief is explicit about that, and it
// is also the safer default: issuing is internal record-keeping, publishing
// makes a document reachable by anyone with a link.
// ---------------------------------------------------------------------------
invoicesRouter.post(
  "/:id([0-9a-fA-F-]{36})/publish",
  authorize("invoices:share"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const loaded = await loadInvoice(req.auth!.db, id);
    if (!loaded) throw Errors.notFound("Invoice");

    if (loaded.invoice.status === "cancelled") throw Errors.badRequest("A cancelled invoice cannot be published");
    if (!loaded.invoice.issued_at) {
      throw Errors.badRequest("Issue the invoice before publishing it");
    }

    const { data, error } = await req.auth!.db
      .from("invoices")
      .update({ published_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "invoice",
      entityId: id,
      action: "publish",
    });

    ok(res, data);
  }),
);

invoicesRouter.post(
  "/:id([0-9a-fA-F-]{36})/unpublish",
  authorize("invoices:share"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;

    const { data, error } = await req.auth!.db
      .from("invoices")
      .update({ published_at: null })
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Invoice");

    // Unpublishing also revokes the link: leaving a working token for an invoice
    // the agency has deliberately withdrawn would be a silent contradiction.
    await req.auth!.db
      .from("invoice_share_links")
      .update({ revoked_at: new Date().toISOString(), revoked_by: req.auth!.userId })
      .eq("invoice_id", id)
      .is("revoked_at", null);

    await auditFromRequest(req, {
      entityType: "invoice",
      entityId: id,
      action: "unpublish",
    });

    ok(res, data);
  }),
);

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------
invoicesRouter.post(
  "/:id([0-9a-fA-F-]{36})/cancel",
  authorize("invoices:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const loaded = await loadInvoice(req.auth!.db, id);
    if (!loaded) throw Errors.notFound("Invoice");

    if (loaded.paid > 0) {
      // Cancelling a partly-paid invoice would strand the payment. Refund or
      // credit it first, deliberately, by a human.
      throw Errors.badRequest(
        "This invoice has payments recorded. Reverse the payments before cancelling it.",
      );
    }

    const { data, error } = await req.auth!.db
      .from("invoices")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString(), published_at: null })
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) throw Errors.internal(error.message);

    await req.auth!.db
      .from("invoice_share_links")
      .update({ revoked_at: new Date().toISOString(), revoked_by: req.auth!.userId })
      .eq("invoice_id", id)
      .is("revoked_at", null);

    await auditFromRequest(req, {
      entityType: "invoice",
      entityId: id,
      action: "status_change",
      diff: { from: loaded.invoice.status, to: "cancelled" },
    });

    ok(res, data);
  }),
);

// ---------------------------------------------------------------------------
// Share link
//
// The raw token is returned ONCE. Only its SHA-256 is stored, so a database
// disclosure yields no working links, and "show me my links" can list them for
// revocation without ever reconstructing one.
// ---------------------------------------------------------------------------
invoicesRouter.post(
  "/:id([0-9a-fA-F-]{36})/share-link",
  authorize("invoices:share"),
  validate({ params: idParams, body: invoiceShareLinkSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof invoiceShareLinkSchema>;

    const id = req.params.id as string;
    const loaded = await loadInvoice(req.auth!.db, id);
    if (!loaded) throw Errors.notFound("Invoice");

    if (loaded.invoice.status === "cancelled") throw Errors.badRequest("A cancelled invoice cannot be shared");
    if (loaded.invoice.status === "draft") throw Errors.badRequest("Issue the invoice before sharing it");

    // Rotate: revoke any live link first, so the partial unique index holds and
    // an old copy of the URL stops working the moment a new one is made.
    await req.auth!.db
      .from("invoice_share_links")
      .update({ revoked_at: new Date().toISOString(), revoked_by: req.auth!.userId })
      .eq("invoice_id", id)
      .is("revoked_at", null);

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");

    const expiresAt = b.expiresInDays
      ? new Date(Date.now() + b.expiresInDays * 86_400_000).toISOString()
      : null;

    const { data, error } = await req.auth!.db
      .from("invoice_share_links")
      .insert({
        organization_id: req.auth!.orgId,
        invoice_id: id,
        token_hash: tokenHash,
        created_by: req.auth!.userId,
        expires_at: expiresAt,
      })
      .select("id, expires_at, created_at")
      .single();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "invoice_share_link",
      entityId: (data as { id: string }).id,
      action: "share_link_created",
      diff: { invoiceId: id, expiresAt },
    });

    ok(res, {
      ...(data as object),
      // The ONLY time this value exists outside the client. It is not logged.
      token,
      url: `/i/${token}`,
    });
  }),
);

invoicesRouter.delete(
  "/:id([0-9a-fA-F-]{36})/share-link",
  authorize("invoices:share"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;

    const { data, error } = await req.auth!.db
      .from("invoice_share_links")
      .update({ revoked_at: new Date().toISOString(), revoked_by: req.auth!.userId })
      .eq("invoice_id", id)
      .is("revoked_at", null)
      .select("id");

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "invoice",
      entityId: id,
      action: "share_link_revoked",
      diff: { revoked: (data ?? []).length },
    });

    ok(res, { revoked: (data ?? []).length });
  }),
);

// ---------------------------------------------------------------------------
// Preview — the same document definition the PDF is rendered from
// ---------------------------------------------------------------------------
invoicesRouter.get(
  "/:id([0-9a-fA-F-]{36})/preview",
  authorize("invoices:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const loaded = await loadInvoice(req.auth!.db, id);
    if (!loaded) throw Errors.notFound("Invoice");

    const document = await buildDocument(
      req.auth!.orgId,
      loaded.invoice,
      loaded.lines,
      loaded.paid,
      loaded.effectiveStatus,
      loaded.clientName,
      loaded.partnerName,
    );

    ok(res, { document });
  }),
);

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
invoicesRouter.get(
  "/:id([0-9a-fA-F-]{36})/pdf",
  authorize("invoices:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const loaded = await loadInvoice(req.auth!.db, id);
    if (!loaded) throw Errors.notFound("Invoice");

    const document = await buildDocument(
      req.auth!.orgId,
      loaded.invoice,
      loaded.lines,
      loaded.paid,
      loaded.effectiveStatus,
      loaded.clientName,
      loaded.partnerName,
    );

    const pdf = await renderInvoicePdf(document);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", attachmentHeader(`Invoice-${loaded.invoice.invoice_number}.pdf`));
    res.setHeader("Content-Length", String(pdf.length));
    // An invoice for a specific client must never sit in a shared cache.
    res.setHeader("Cache-Control", "private, no-store");
    res.end(pdf);

    // Logged after the response so a slow write cannot delay the download.
    void auditFromRequest(req, {
      entityType: "invoice",
      entityId: id,
      action: "download",
      diff: { format: "pdf", invoiceNumber: loaded.invoice.invoice_number },
    });
  }),
);
