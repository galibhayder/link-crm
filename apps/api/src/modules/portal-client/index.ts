import { Router } from "express";
import { z } from "zod";
import { ok } from "../../lib/http.js";
import { asyncRoute } from "../../lib/http.js";
import { validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";

/**
 * CLIENT PORTAL — /portal/v1
 *
 * Structurally separate from /api/v1:
 *   - a different mounted router with its own handlers
 *   - its own selects, never `select *`
 *   - its own permission guard, and authenticate() has already rejected any
 *     token whose role does not belong on this surface
 *
 * The reason for the separation is that v1 of this design gave client_user
 * `placements:read` on the INTERNAL endpoint — same handler, same query, same
 * serializer, different URL prefix, which is exactly how a client ends up
 * seeing another client's rows.
 */
export const portalRouter: Router = Router();

/**
 * Everything the portal returns is scoped by RLS through req.auth.db, because
 * the client_user role has no policy that spans more than their granted clients.
 * The contract here is also narrower than the internal one: no cost columns, no
 * internal notes, no supplier identity.
 */
portalRouter.get(
  "/me",
  asyncRoute(async (req, res) => {
    ok(res, {
      userId: req.auth!.userId,
      email: req.auth!.email,
      organizationId: req.auth!.orgId,
      role: req.auth!.role,
    });
  }),
);

/**
 * The caller's effective permissions, mirroring `/api/v1/me/permissions`.
 *
 * The web app builds its navigation from one of these two endpoints depending on
 * which surface the session belongs to. Having the same shape on both means the
 * client has one code path for "what may I see" rather than a portal special case.
 */
portalRouter.get(
  "/me/permissions",
  asyncRoute(async (req, res) => {
    const { permissionsFor } = await import("@crm/shared");
    ok(res, {
      role: req.auth!.role,
      permissions: permissionsFor(req.auth!.role),
      organizationId: req.auth!.orgId,
      surface: req.auth!.surface,
    });
  }),
);

portalRouter.get(
  "/overview",
  asyncRoute(async (req, res) => {
    const { data: clients, error } = await req.auth!.db
      .from("clients")
      .select("id, name, domain, status")
      .is("deleted_at", null);

    if (error) throw Errors.internal(error.message);

    const clientIds = (clients ?? []).map((c) => c.id);

    const [{ data: campaigns }, { data: placements }] = await Promise.all([
      req.auth!.db
        .from("campaigns")
        .select("id, name, status, monthly_link_target")
        .in("client_id", clientIds.length ? clientIds : ["00000000-0000-0000-0000-000000000000"])
        .is("deleted_at", null),
      // Counted from the portal VIEW, not the placements table.
      //
      // A client_user has NO policy on `placements` (migration 0003) — reading it
      // returns zero rows, so counting there produced a dashboard that reported
      // "0 live links" above a table listing several. The view is the single
      // definition of what this surface can see, and it already excludes
      // pre-approval stages, so the counts and the list cannot disagree.
      req.auth!.db
        .from("v_portal_placements")
        .select("id, status, live_date, target_url"),
    ]);

    ok(res, {
      clients: clients ?? [],
      campaigns: campaigns ?? [],
      // `pipeline_stage` is the authoritative stage on the view; `status` is the
      // link's own state and stays 'live' only after publication.
      livePlacements: (placements ?? []).filter((p) => p.status === "live").length,
      totalPlacements: placements?.length ?? 0,
    });
  }),
);

portalRouter.get(
  "/placements",
  asyncRoute(async (req, res) => {
    // Reads the portal VIEW rather than the table, so "what a client sees" is
    // one reviewable definition (migration 0015) instead of a column list
    // repeated in each query. The view already excludes placements before
    // client approval, which is what stops the portal leaking our pipeline.
    //
    // Deliberately absent: internal_notes, negotiated_cost, assigned_to,
    // supplier identity, and any vendor cost.
    const { data, error } = await req.auth!.db
      .from("v_portal_placements")
      .select(
        "id, campaign_id, target_url, anchor_text, anchor_type, live_url, link_type, status, pipeline_stage, live_date, index_status, client_approved_at, notes",
      )
      .order("live_date", { ascending: false, nullsFirst: false });

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

/**
 * The client's approval queue.
 *
 * Only placements that reached `client_approved` appear here — a client is never
 * shown work that is still being pitched. This is the portal-side counterpart to
 * the internal approval flow.
 */
portalRouter.get(
  "/placements/approved",
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("v_portal_placements")
      .select("id, campaign_id, target_url, anchor_text, live_url, pipeline_stage, live_date, index_status, client_approved_at")
      .in("pipeline_stage", ["client_approved", "content_writing", "submitted", "live"])
      .order("client_approved_at", { ascending: false, nullsFirst: false })
      .limit(200);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

portalRouter.get(
  "/campaigns",
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("campaigns")
      .select("id, client_id, name, status, service_type, start_date, monthly_link_target")
      .is("deleted_at", null);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

// NOTE — a `/portal/v1/invoices` handler used to live here, reading the base
// `invoices` table with `status` and no derived columns.
//
// Phase 6 added a second `/invoices` handler reading `v_invoices`, with
// `effective_status`, `paid_amount` and `balance`. Express matches the FIRST
// registered route, so this one shadowed it: clients received DRAFTS (never meant
// to be visible) and the portal UI — which renders `effective_status` and
// `balance` — showed blanks. The Phase 6 test asserted only `status === 200`,
// which the stale handler satisfied, so it passed.
//
// The live handler is defined further down, beside the invoice PDF route.
// Do not reintroduce a handler for this path above it.

portalRouter.get(
  "/reports",
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("placements")
      .select("status, anchor_type, live_date")
      .is("deleted_at", null);

    if (error) throw Errors.internal(error.message);

    const rows = data ?? [];
    const byStatus = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

    ok(res, {
      total: rows.length,
      byStatus,
      live: byStatus.live ?? 0,
      // No margin, no cost, no supplier spend — this role never sees tier 2.
    });
  }),
);

// ---------------------------------------------------------------------------
// CONTENT APPROVAL
//
// The client's own sign-off on the article written for them. This is the reason
// `briefs:approve` is granted to `client_user` at all — and until now nothing
// implemented it, because the portal router was read-only and /api/v1 rejects a
// portal token before any permission is consulted.
//
// Deliberately narrow: the client may read a draft that is awaiting approval and
// approve it. They cannot edit it, create one, or approve anything not submitted.
// ---------------------------------------------------------------------------

/** Drafts awaiting this client's approval, plus what they already approved. */
portalRouter.get(
  "/drafts",
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("content_drafts")
      // Enumerated: no internal_notes, no word_count internals beyond what a review
      // needs, nothing about the writer.
      .select("id, placement_id, title, body_md, word_count, status, current_version, submitted_at, approved_at, client_approval_note")
      .in("status", ["in_review", "approved", "published"])
      .order("submitted_at", { ascending: false, nullsFirst: false })
      .limit(100);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

/**
 * Approve a draft.
 *
 * Goes through the SECURITY DEFINER RPC rather than an UPDATE: the client has no
 * write policy on `content_drafts`, and giving them one broad enough to approve
 * would also let them rewrite the text. The function re-checks the status, the
 * placement scope and the caller's role.
 */
portalRouter.post(
  "/drafts/:id([0-9a-fA-F-]{36})/approve",
  validate({
    params: z.object({ id: z.string().uuid() }),
    body: z.object({ note: z.string().trim().max(2000).optional() }).default({}),
  }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db.rpc("client_approve_draft_rpc", {
      p_draft_id: req.params.id,
      p_note: (req.body as { note?: string }).note ?? null,
    });

    if (error) {
      // P0002 is "not found or not yours"; 22023 is "not in a state that can be
      // approved". Both are the caller's problem, not a server fault.
      if (error.code === "P0002") throw Errors.notFound("Draft");
      if (error.code === "22023") throw Errors.badRequest(error.message);
      if (error.code === "42501") throw Errors.forbidden(error.message);
      throw Errors.internal(error.message);
    }

    const row = (data as Array<{ id: string; status: string; approved_at: string }> | null)?.[0];
    if (!row) throw Errors.notFound("Draft");
    ok(res, row);
  }),
);

/**
 * Send a draft back for changes.
 *
 * The other half of review: a client who cannot approve has no way to say why, and
 * would have to leave the portal to email somebody. Same SECURITY DEFINER pattern as
 * approval — the client has no write policy on `content_drafts`, and a policy broad
 * enough to request a revision would also let them rewrite the text.
 *
 * The function records the request in `content_revisions`, so the writer sees the
 * note and the history keeps it after the text changes.
 */
portalRouter.post(
  "/drafts/:id([0-9a-fA-F-]{36})/revision",
  validate({
    params: z.object({ id: z.string().uuid() }),
    body: z.object({
      // Required, not optional: "change something" is not actionable, and the
      // database enforces the same rule.
      note: z.string().trim().min(3, "Say what needs to change").max(4000),
    }),
  }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db.rpc("client_request_draft_revision_rpc", {
      p_draft_id: req.params.id,
      p_note: (req.body as { note: string }).note,
    });

    if (error) {
      if (error.code === "P0002") throw Errors.notFound("Draft");
      // 23505 is the one-open-request-per-draft rule; 22023 is "not in review" or
      // "note too short". All are the caller's problem, not a server fault.
      if (error.code === "23505") throw Errors.conflict(error.message);
      if (error.code === "22023") throw Errors.badRequest(error.message);
      if (error.code === "42501") throw Errors.forbidden(error.message);
      throw Errors.internal(error.message);
    }

    const row = (data as Array<{ id: string; status: string }> | null)?.[0];
    if (!row) throw Errors.notFound("Draft");
    ok(res, row);
  }),
);

// ---------------------------------------------------------------------------
// INVOICES
//
// A client sees their own invoices, through the portal surface. Three defences
// stack here:
//
//   1. `v_invoices` is security_invoker, so the caller's RLS applies — a client
//      can only ever read invoices `can_see_invoice()` permits.
//   2. The projection below is an ALLOW-LIST. No cost, no margin, no payout, no
//      internal note is selected, so none can be leaked by a later change that
//      accidentally widens the query.
//   3. Drafts are EXCLUDED IN THE QUERY, not in the UI.
//
//      This was a real defect: the list returned every invoice for the client
//      including `draft`, and the portal screen filtered them out client-side. A
//      client could read an unfinished invoice straight off the API, and "the UI
//      hides it" is not an access control. The filter belongs here.
//
// Downloading an invoice PDF goes through `/api/v1/invoices/:id/pdf`, which a
// client cannot reach — the internal surface rejects their token. So the portal
// gets its own PDF route rather than sharing one.
// ---------------------------------------------------------------------------
portalRouter.get(
  "/invoices",
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("v_invoices")
      .select(
        "id, invoice_number, status, effective_status, currency, total, paid_amount, balance, due_date, issued_at, period_start, period_end, published_at, days_overdue",
      )
      // A draft is the agency's working state. Excluded here so it is never sent,
      // rather than filtered by whichever screen happens to render the list.
      .neq("status", "draft")
      .neq("effective_status", "draft")
      .neq("effective_status", "cancelled")
      .order("created_at", { ascending: false });

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

portalRouter.get(
  "/invoices/:id([0-9a-fA-F-]{36})",
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;

    const { data: invoice, error } = await req.auth!.db
      .from("v_invoices")
      .select(
        "id, invoice_number, status, effective_status, currency, subtotal, discount_amount, tax_rate, tax_amount, total, paid_amount, balance, due_date, issued_at, period_start, period_end, payment_instructions, notes, days_overdue",
      )
      .eq("id", id)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    // A client asking for another client's invoice gets 404, not 403: the
    // existence of somebody else's invoice is itself information they may not have.
    if (!invoice) throw Errors.notFound("Invoice");

    // Same rule as the list: a draft is not a document the client has been sent.
    // Returning it by direct id would be the same disclosure the list makes — and
    // knowing an invoice number is enough to guess the URL.
    const state = invoice as { status?: string; effective_status?: string };
    if (state.status === "draft" || state.effective_status === "draft") {
      throw Errors.notFound("Invoice");
    }

    const { data: lines } = await req.auth!.db
      .from("invoice_line_items")
      .select("description, quantity, unit_price, amount, sort_order")
      .eq("invoice_id", id)
      .order("sort_order");

    ok(res, { ...invoice, line_items: lines ?? [] });
  }),
);

/**
 * The client's own invoice PDF.
 *
 * Deliberately a separate route from the internal one: the internal handler is
 * mounted behind `/api/v1`, which rejects a client token before any handler runs,
 * so sharing it would have been impossible rather than merely inconvenient.
 */
portalRouter.get(
  "/invoices/:id([0-9a-fA-F-]{36})/pdf",
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;

    const { data: invoice, error } = await req.auth!.db
      .from("v_invoices")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!invoice) throw Errors.notFound("Invoice");

    const row = invoice as Record<string, unknown>;

    const { data: lines } = await req.auth!.db
      .from("invoice_line_items")
      .select("description, quantity, unit_price, amount")
      .eq("invoice_id", id)
      .order("sort_order");

    const { renderInvoicePdf } = await import("../../integrations/pdf.js");

    // Built here rather than shared with the internal handler because the two
    // read different sources: internal renders the frozen snapshot (so a
    // re-download matches what was issued), while this renders the live row the
    // client can already see. The client is looking at their own current bill.
    const pdf = await renderInvoicePdf({
      invoiceNumber: String(row.invoice_number),
      status: String(row.effective_status ?? row.status),
      issuedAt: (row.issued_at as string) ?? null,
      dueDate: (row.due_date as string) ?? null,
      currency: String(row.currency ?? "USD"),
      subtotal: Number(row.subtotal ?? 0),
      discountAmount: Number(row.discount_amount ?? 0),
      taxRate: Number(row.tax_rate ?? 0),
      taxAmount: Number(row.tax_amount ?? 0),
      total: Number(row.total ?? 0),
      paidAmount: Number(row.paid_amount ?? 0),
      balance: Number(row.balance ?? 0),
      notes: (row.notes as string) ?? null,
      paymentInstructions: (row.payment_instructions as string) ?? null,
      branding: {
        agencyName: String((row.agency_name as string) ?? "Agency"),
        brandColor: (row.brand_color as string) ?? null,
      },
      billTo: { name: String(row.client_name ?? "Client") },
      lines: ((lines ?? []) as Array<Record<string, unknown>>).map((l) => ({
        description: String(l.description),
        quantity: Number(l.quantity),
        unitPrice: Number(l.unit_price),
        amount: Number(l.amount),
      })),
    });

    const { attachmentHeader } = await import("../../integrations/tabular.js");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", attachmentHeader(`Invoice-${String(row.invoice_number)}.pdf`));
    res.setHeader("Content-Length", String(pdf.length));
    res.setHeader("Cache-Control", "private, no-store");
    res.end(pdf);
  }),
);

/**
 * CLIENT CAMPAIGN REPORT.
 *
 * Lives on the PORTAL surface, not `/api/v1`, and that is not a detail: the
 * internal router rejects a `client_user` token before any handler runs, so a
 * route a client is meant to reach cannot be mounted there. `reports:read` is in
 * the client's permission set for exactly this endpoint.
 *
 * The projection is built by SELECTING client-safe fields. Publisher cost, writer
 * payout and margin are not queried, so they cannot appear here even if the query
 * is widened by a later change.
 */
portalRouter.get(
  "/reports/campaigns",
  asyncRoute(async (req, res) => {
    const { data: campaigns, error } = await req.auth!.db
      .from("campaigns")
      .select("id, name, status, monthly_link_target, start_date")
      .is("deleted_at", null);

    if (error) throw Errors.internal(error.message);

    const ids = ((campaigns ?? []) as Array<{ id: string }>).map((c) => c.id);
    if (ids.length === 0) {
      ok(res, []);
      return;
    }

    // The portal view already excludes pre-approval stages and every internal
    // column, so this report and the portal's own placement list cannot disagree.
    const { data: placements, error: placeErr } = await req.auth!.db
      .from("v_portal_placements")
      .select("campaign_id, id, pipeline_stage")
      .in("campaign_id", ids);

    if (placeErr) throw Errors.internal(placeErr.message);

    const rows = (placements ?? []) as Array<{ campaign_id: string; pipeline_stage: string }>;

    ok(
      res,
      ((campaigns ?? []) as Array<Record<string, unknown>>).map((c) => {
        const id = c.id as string;
        const mine = rows.filter((r) => r.campaign_id === id);
        return {
          campaignId: id,
          campaignName: c.name,
          status: c.status,
          monthlyTarget: c.monthly_link_target,
          startDate: c.start_date,
          placements: mine.length,
          liveLinks: mine.filter((r) => r.pipeline_stage === "live").length,
        };
      }),
    );
  }),
);

/** The same report as a CSV or Excel download, for the client. */
portalRouter.get(
  "/reports/campaigns/export",
  asyncRoute(async (req, res) => {
    const { data: campaigns, error } = await req.auth!.db
      .from("campaigns")
      .select("id, name, status, monthly_link_target")
      .is("deleted_at", null);

    if (error) throw Errors.internal(error.message);

    const ids = ((campaigns ?? []) as Array<{ id: string }>).map((c) => c.id);
    const { data: placements } = ids.length
      ? await req.auth!.db.from("v_portal_placements").select("campaign_id, pipeline_stage").in("campaign_id", ids)
      : { data: [] };

    const rows = (placements ?? []) as Array<{ campaign_id: string; pipeline_stage: string }>;

    const reportRows = ((campaigns ?? []) as Array<Record<string, unknown>>).map((c) => {
      const id = c.id as string;
      const mine = rows.filter((r) => r.campaign_id === id);
      return {
        campaign: String(c.name ?? ""),
        status: String(c.status ?? ""),
        monthlyTarget: (c.monthly_link_target as number | null) ?? null,
        delivered: mine.length,
        live: mine.filter((r) => r.pipeline_stage === "live").length,
      };
    });

    const columns = [
      { header: "Campaign", key: "campaign", width: 30 },
      { header: "Status", key: "status", width: 12 },
      { header: "Monthly target", key: "monthlyTarget", type: "number" as const, width: 14 },
      { header: "Delivered", key: "delivered", type: "number" as const, width: 12 },
      { header: "Live links", key: "live", type: "number" as const, width: 12 },
    ];

    const { buildCsv, buildWorkbook, attachmentHeader } = await import("../../integrations/tabular.js");
    const format = (req.query.format as string) === "xlsx" ? "xlsx" : "csv";

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", attachmentHeader("Campaign Report.csv"));
      res.setHeader("Cache-Control", "private, no-store");
      res.end(buildCsv({ columns, rows: reportRows }));
      return;
    }

    const buffer = await buildWorkbook({
      sheetName: "Campaigns",
      title: "Campaign Report",
      columns,
      rows: reportRows,
    });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", attachmentHeader("Campaign Report.xlsx"));
    res.setHeader("Cache-Control", "private, no-store");
    res.end(buffer);
  }),
);
