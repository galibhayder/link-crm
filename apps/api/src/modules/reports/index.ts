import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, ok, validate, parsedQuery } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { admin } from "../../integrations/supabase.js";
import { buildCsv, buildWorkbook, attachmentHeader, type ExportColumn } from "../../integrations/tabular.js";
import { auditFromRequest } from "../../lib/audit.js";

export const reportsRouter: Router = Router();

const periodQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  clientId: z.string().uuid().optional(),
});

/**
 * Export format.
 *
 * Declared here, above every route that uses it, because the publisher and
 * placement reports serve JSON and CSV/XLSX from the same handler. Keeping it
 * near the export section (where it started) meant those two routes referenced a
 * `const` before its declaration.
 */
const exportFormatSchema = z.object({ format: z.enum(["csv", "xlsx"]).default("csv") });

/**
 * REPORTS.
 *
 * Every margin report below reads a view that joins tier 1 (client price) to
 * tier 2 (supplier cost). Those views are granted to service_role only and to no
 * end-user role, so this router is the single door: `authorize("reports:margins")`
 * runs first, and the query is always pinned to the caller's organization.
 *
 * A role without that permission gets a 403 here and would get zero rows even if
 * this check were removed, because the view is not granted to them.
 */
reportsRouter.get(
  "/dashboard",
  authorize("campaigns:read"),
  asyncRoute(async (req, res) => {
    const db = req.auth!.db;

    const [clients, campaigns, prospects, placements] = await Promise.all([
      db.from("clients").select("id", { count: "exact", head: true }).is("deleted_at", null),
      db.from("campaigns").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("status", "active"),
      db.from("prospects").select("id", { count: "exact", head: true }).is("deleted_at", null),
      db.from("placements").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("status", "live"),
    ]);

    // A count query filtered by RLS returns 0 for a table the role cannot read,
    // which is the honest answer rather than an error the dashboard would have
    // to special-case.
    ok(res, {
      activeClients: clients.count ?? 0,
      activeCampaigns: campaigns.count ?? 0,
      totalProspects: prospects.count ?? 0,
      livePlacements: placements.count ?? 0,
    });
  }),
);

/** Margin reporting. Requires reports:margins — owner only. */
reportsRouter.get(
  "/profitability",
  authorize("reports:margins"),
  validate({ query: periodQuery }),
  asyncRoute(async (req, res) => {
    const { clientId } = parsedQuery<z.infer<typeof periodQuery>>(req);

    let query = admin()
      .from("v_placement_margin")
      .select("placement_id, campaign_id, client_id, client_rate, supplier_cost, margin, margin_pct, status, live_date")
      .eq("organization_id", req.auth!.orgId);

    if (clientId) query = query.eq("client_id", clientId);

    const { data, error } = await query;
    if (error) throw Errors.internal(error.message);

    const rows = data ?? [];
    const revenue = rows.reduce((s, r) => s + Number(r.client_rate ?? 0), 0);
    const cost = rows.reduce((s, r) => s + Number(r.supplier_cost ?? 0), 0);
    const withCosts = rows.filter((r) => Number(r.client_rate ?? 0) > 0);

    ok(res, {
      placements: rows,
      summary: {
        revenue,
        cost,
        margin: revenue - cost,
        marginPct: revenue > 0 ? (revenue - cost) / revenue : 0,
        avgMarginPct:
          withCosts.length > 0
            ? withCosts.reduce((s, r) => s + Number(r.margin_pct ?? 0), 0) / withCosts.length
            : 0,
        pricedPlacements: withCosts.length,
        unpricedPlacements: rows.length - withCosts.length,
      },
    });
  }),
);

/** Anchor distribution — the over-optimization signal. */
reportsRouter.get(
  "/anchors",
  authorize("reports:read"),
  validate({ query: z.object({ campaignId: z.string().uuid() }) }),
  asyncRoute(async (req, res) => {
    const { campaignId } = parsedQuery<{ campaignId: string }>(req);

    const { data, error } = await admin()
      .from("v_anchor_distribution")
      .select("anchor_type, link_count, share")
      .eq("organization_id", req.auth!.orgId)
      .eq("campaign_id", campaignId);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

reportsRouter.get(
  "/outreach",
  authorize("reports:read"),
  validate({ query: z.object({ campaignId: z.string().uuid().optional() }) }),
  asyncRoute(async (req, res) => {
    const { campaignId } = parsedQuery<{ campaignId?: string }>(req);

    let query = admin().from("v_outreach_funnel").select("*").eq("organization_id", req.auth!.orgId);
    if (campaignId) query = query.eq("campaign_id", campaignId);

    const { data, error } = await query;
    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

reportsRouter.get(
  "/ar-aging",
  authorize("invoices:read"),
  asyncRoute(async (req, res) => {
    const { data, error } = await admin()
      .from("v_ar_aging")
      .select("*")
      .eq("organization_id", req.auth!.orgId)
      .order("days_overdue", { ascending: false });

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

// ===========================================================================
// PHASE 6 — CAMPAIGN PROFITABILITY AND FINANCIAL REPORTS
//
//   INTERNAL  /campaigns, /financial, /ledger  -> reports:margins (owner)
//   CLIENT    NO ROUTE HERE — see the note below
//
// The client-facing campaign report lives at `GET /portal/v1/reports/campaigns`.
// It cannot live here: `authenticate` rejects a `client_user` token on `/api/v1`
// before any handler runs, so a route intended for a client would be permanently
// unreachable. The first test run proved that by getting a 403.
// ===========================================================================

reportsRouter.get(
  "/campaigns",
  authorize("reports:margins"),
  asyncRoute(async (req, res) => {
    const { data, error } = await admin()
      .from("v_campaign_profitability")
      .select("*")
      .eq("organization_id", req.auth!.orgId)
      .order("campaign_name");

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

reportsRouter.get(
  "/financial",
  authorize("reports:margins"),
  asyncRoute(async (req, res) => {
    const { data, error } = await admin()
      .from("v_financial_summary")
      .select("*")
      .eq("organization_id", req.auth!.orgId);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

reportsRouter.get(
  "/ledger",
  authorize("reports:margins"),
  validate({
    query: z.object({
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    }),
  }),
  asyncRoute(async (req, res) => {
    const q = parsedQuery<{ from?: Date; to?: Date; limit: number }>(req);

    let query = admin()
      .from("v_financial_ledger")
      .select("*")
      .eq("organization_id", req.auth!.orgId)
      .order("occurred_at", { ascending: false })
      .limit(q.limit);

    if (q.from) query = query.gte("occurred_at", q.from.toISOString());
    if (q.to) query = query.lte("occurred_at", q.to.toISOString());

    const { data, error } = await query;
    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

/**
 * PUBLISHER REPORT — no client pricing.
 *
 * A publisher (or the staff who manage them) must not see what the client is
 * charged. Selects publisher-side fields only.
 *
 * Serves JSON by default and CSV/XLSX with `?format=`. The exports were missing
 * in the first cut: the reports page offered download buttons that hit this route
 * with `?format=csv`, which it ignored and answered with JSON — a file named
 * `.csv` containing `{"data":[...]}`. Serving both shapes from ONE query and ONE
 * column list is what stops that recurring.
 */
reportsRouter.get(
  "/publishers",
  authorize("publishers:read"),
  validate({ query: exportFormatSchema.partial().optional() }),
  asyncRoute(async (req, res) => {
    const { format } = parsedQuery<{ format?: "csv" | "xlsx" }>(req);

    const { data, error } = await req.auth!.db
      .from("publishers")
      .select("id, domain, dr, monthly_traffic, spam_score, status, niche")
      .is("deleted_at", null)
      .order("dr", { ascending: false });

    if (error) throw Errors.internal(error.message);
    const rows = (data ?? []) as Array<Record<string, unknown>>;

    if (!format) {
      ok(res, rows);
      return;
    }

    const columns: ExportColumn[] = [
      { header: "Domain", key: "domain", width: 30 },
      { header: "DR", key: "dr", type: "number", width: 8 },
      { header: "Monthly traffic", key: "monthly_traffic", type: "number", width: 16 },
      { header: "Spam score", key: "spam_score", type: "number", width: 12 },
      { header: "Status", key: "status", width: 12 },
      { header: "Niche", key: "niche", width: 24 },
    ];

    await auditFromRequest(req, {
      entityType: "report",
      entityId: null,
      action: "export",
      diff: { report: "publishers", format, rows: rows.length },
    });

    await sendExport(res, { filename: "Publishers", columns, rows: rows as never }, format);
  }),
);

/**
 * PLACEMENT REPORT — no cost.
 *
 * Never selects `placement_costs` or `placement_pricing`; only the placement's own
 * descriptive fields, which any role with `placements:read` may already see.
 */
reportsRouter.get(
  "/placements",
  authorize("placements:read"),
  validate({
    query: z.object({
      campaignId: z.string().uuid().optional(),
      format: z.enum(["csv", "xlsx"]).optional(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const { campaignId, format } = parsedQuery<{ campaignId?: string; format?: "csv" | "xlsx" }>(req);

    let query = req.auth!.db
      .from("placements")
      .select(
        "id, campaign_id, target_url, anchor_text, anchor_type, pipeline_stage, status, live_url, live_date, index_status",
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (campaignId) query = query.eq("campaign_id", campaignId);

    const { data, error } = await query;
    if (error) throw Errors.internal(error.message);
    const rows = (data ?? []) as Array<Record<string, unknown>>;

    if (!format) {
      ok(res, rows);
      return;
    }

    const columns: ExportColumn[] = [
      { header: "Target URL", key: "target_url", width: 38 },
      { header: "Anchor", key: "anchor_text", width: 22 },
      { header: "Anchor type", key: "anchor_type", width: 14 },
      { header: "Stage", key: "pipeline_stage", width: 16 },
      { header: "Status", key: "status", width: 10 },
      { header: "Live URL", key: "live_url", width: 34 },
      { header: "Live date", key: "live_date", type: "date", width: 12 },
      { header: "Index", key: "index_status", width: 12 },
    ];

    await auditFromRequest(req, {
      entityType: "report",
      entityId: null,
      action: "export",
      diff: { report: "placements", format, rows: rows.length },
    });

    await sendExport(res, { filename: "Placements", columns, rows: rows as never }, format);
  }),
);

/**
 * ADMIN DATABASE REPORT.
 *
 * Row counts and health. An operator's report, so it needs `audit:read` (owner)
 * and contains no business figures at all — which is what makes it safe to hand
 * to whoever is on call.
 */
reportsRouter.get(
  "/database",
  authorize("audit:read"),
  asyncRoute(async (_req, res) => {
    const tables = [
      "clients",
      "campaigns",
      "placements",
      "publishers",
      "prospects",
      "invoices",
      "payments",
      "writer_payouts",
      "campaign_expenses",
    ] as const;

    const counts = await Promise.all(
      tables.map(async (table) => {
        const { count } = await admin().from(table).select("id", { count: "exact", head: true });
        return { table, rows: count ?? 0 };
      }),
    );

    // Jobs are the part of the system that fails silently if nobody looks.
    const { data: runs } = await admin()
      .from("job_runs")
      .select("job_name, status, started_at, finished_at")
      .order("started_at", { ascending: false })
      .limit(20);

    ok(res, { tables: counts, recentJobs: runs ?? [] });
  }),
);

// ===========================================================================
// EXPORTS
//
// One route per report, parameterised by format, rather than six per format.
// `?format=csv|xlsx` keeps the column definition and the permission check in a
// single place — an export with a different column list from its JSON sibling is
// the classic way a spreadsheet ends up showing a field the screen hides.
// ===========================================================================

interface ExportSpec {
  filename: string;
  columns: ExportColumn[];
  rows: Array<Record<string, string | number | null>>;
}

function sendExport(res: import("express").Response, spec: ExportSpec, format: "csv" | "xlsx"): Promise<void> | void {
  if (format === "csv") {
    const csv = buildCsv({ columns: spec.columns, rows: spec.rows });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", attachmentHeader(`${spec.filename}.csv`));
    res.setHeader("Cache-Control", "private, no-store");
    res.end(csv);
    return;
  }

  return buildWorkbook({
    sheetName: spec.filename.split(" ")[0] ?? "Report",
    title: spec.filename,
    columns: spec.columns,
    rows: spec.rows,
    currencyKey: "currency",
  }).then((buffer) => {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", attachmentHeader(`${spec.filename}.xlsx`));
    res.setHeader("Cache-Control", "private, no-store");
    res.end(buffer);
  });
}

/** Campaign profitability — owner only, because every column here is internal. */
reportsRouter.get(
  "/campaigns/export",
  authorize("reports:margins"),
  validate({ query: exportFormatSchema }),
  asyncRoute(async (req, res) => {
    const { format } = parsedQuery<z.infer<typeof exportFormatSchema>>(req);

    const { data, error } = await admin()
      .from("v_campaign_profitability")
      .select("*")
      .eq("organization_id", req.auth!.orgId)
      .order("campaign_name");
    if (error) throw Errors.internal(error.message);

    const columns: ExportColumn[] = [
      { header: "Campaign", key: "campaign_name", width: 28 },
      { header: "Client", key: "client_name", width: 22 },
      { header: "Currency", key: "currency", width: 10 },
      { header: "Revenue", key: "revenue", type: "currency", width: 14 },
      { header: "Publisher cost", key: "publisher_cost", type: "currency", width: 16 },
      { header: "Writer payouts", key: "writer_payouts", type: "currency", width: 16 },
      { header: "Other expenses", key: "other_expenses", type: "currency", width: 16 },
      { header: "Gross profit", key: "gross_profit", type: "currency", width: 14 },
      { header: "Margin %", key: "margin_pct", type: "number", width: 11 },
      { header: "Priced", key: "priced_placements", type: "number", width: 9 },
      { header: "Unpriced", key: "unpriced_placements", type: "number", width: 10 },
    ];

    await auditFromRequest(req, {
      entityType: "report",
      entityId: null,
      action: "export",
      diff: { report: "campaign_profitability", format, rows: (data ?? []).length },
    });

    await sendExport(res, { filename: "Campaign Profitability", columns, rows: (data ?? []) as never }, format);
  }),
);

/** Financial summary — owner only. */
reportsRouter.get(
  "/financial/export",
  authorize("reports:margins"),
  validate({ query: exportFormatSchema }),
  asyncRoute(async (req, res) => {
    const { format } = parsedQuery<z.infer<typeof exportFormatSchema>>(req);

    const { data, error } = await admin()
      .from("v_financial_summary")
      .select("*")
      .eq("organization_id", req.auth!.orgId);
    if (error) throw Errors.internal(error.message);

    const columns: ExportColumn[] = [
      { header: "Currency", key: "currency", width: 10 },
      { header: "Billed", key: "billed", type: "currency", width: 14 },
      { header: "Collected", key: "collected", type: "currency", width: 14 },
      { header: "Outstanding AR", key: "outstanding_ar", type: "currency", width: 16 },
      { header: "Publisher costs due", key: "publisher_costs_outstanding", type: "currency", width: 20 },
      { header: "Writer payouts due", key: "writer_payouts_outstanding", type: "currency", width: 20 },
      { header: "Revenue", key: "revenue", type: "currency", width: 14 },
      { header: "Publisher cost", key: "publisher_cost", type: "currency", width: 16 },
      { header: "Gross profit", key: "gross_profit", type: "currency", width: 14 },
      { header: "Margin %", key: "margin_pct", type: "number", width: 11 },
    ];

    await auditFromRequest(req, {
      entityType: "report",
      entityId: null,
      action: "export",
      diff: { report: "financial_summary", format },
    });

    await sendExport(res, { filename: "Financial Summary", columns, rows: (data ?? []) as never }, format);
  }),
);
