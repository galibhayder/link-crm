import { Router } from "express";
import { CAMPAIGN_SORTABLE, campaignInputSchema, campaignListQuery, uuidSchema } from "@crm/shared";
import { z } from "zod";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, noContent, ok, parsedQuery, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest, diffOf } from "../../lib/audit.js";
import {
  buildFilters,
  orgOf,
  pageMeta,
  rangeFor,
  resolveOrder,
  resolveSort,
  searchClause,
  toColumnPatch,
} from "../../lib/crud.js";
import { exportFilename, toCsv } from "../../lib/csv.js";

export const campaignsRouter: Router = Router();

const idParams = z.object({ id: uuidSchema });

const COLUMNS = "id, client_id, name, status, service_type, start_date, end_date, monthly_link_target, target_dr_min, target_traffic_min, anchor_mix, notes, created_at, updated_at";

const MAP: Record<string, string> = {
  clientId: "client_id",
  name: "name",
  status: "status",
  serviceType: "service_type",
  startDate: "start_date",
  endDate: "end_date",
  monthlyLinkTarget: "monthly_link_target",
  targetDrMin: "target_dr_min",
  targetTrafficMin: "target_traffic_min",
  anchorMix: "anchor_mix",
  notes: "notes",
};

campaignsRouter.get(
  "/",
  authorize("campaigns:read"),
  validate({ query: campaignListQuery }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<z.infer<typeof campaignListQuery>>(req);
    const { page, limit } = query;

    const sort = resolveSort(query.sort, CAMPAIGN_SORTABLE, "created_at");
    const order = resolveOrder(query.order, sort, ["created_at", "updated_at", "start_date"]);
    const { from, to } = rangeFor(page, limit);

    let dbQuery = req.auth!.db
      .from("campaigns")
      .select(`${COLUMNS}, client:clients(id, name, domain)`, { count: "exact" })
      .is("deleted_at", null)
      .order(sort, { ascending: order === "asc", nullsFirst: false })
      .range(from, to);

    const search = searchClause(query.q, ["name"]);
    if (search) dbQuery = dbQuery.or(search);

    for (const filter of buildFilters([
      { column: "client_id", op: "eq", value: query.clientId },
      { column: "status", op: "eq", value: query.status },
      { column: "service_type", op: "eq", value: query.serviceType },
    ])) {
      dbQuery = dbQuery.eq(filter.column, filter.value as string);
    }

    const { data, error, count } = await dbQuery;
    if (error) throw Errors.internal(error.message);

    ok(res, data ?? [], pageMeta(page, limit, count ?? 0, sort, order));
  }),
);

campaignsRouter.get(
  "/export/csv",
  authorize("campaigns:read"),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("campaigns")
      .select(COLUMNS)
      .is("deleted_at", null)
      .order("name")
      .limit(5000);

    if (error) throw Errors.internal(error.message);

    const headers = ["name", "status", "service_type", "start_date", "end_date", "monthly_link_target"];
    const csv = toCsv(headers, (data ?? []) as Array<Record<string, unknown>>);

    await auditFromRequest(req, {
      entityType: "campaign",
      action: "export",
      diff: { rows: data?.length ?? 0 },
    });

    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${exportFilename("campaigns")}"`);
    res.send(csv);
  }),
);

campaignsRouter.get(
  "/archived/list",
  authorize("campaigns:read"),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("campaigns")
      .select(COLUMNS)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .limit(200);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

campaignsRouter.get(
  "/:id",
  authorize("campaigns:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("campaigns")
      .select(
        `${COLUMNS}, client:clients(id, name, domain), targets:campaign_monthly_targets(*), assignments:campaign_assignments(id, profile_id, role_on_campaign)`,
      )
      .eq("id", req.params.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Campaign");
    ok(res, data);
  }),
);

campaignsRouter.get(
  "/:id/related",
  authorize("campaigns:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const db = req.auth!.db;

    const [prospects, placements, targets] = await Promise.all([
      db
        .from("prospects")
        .select("id, domain, stage, priority, dr, price, next_follow_up_at")
        .eq("campaign_id", req.params.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(100),
      db
        .from("placements")
        .select("id, target_url, live_url, status, live_date, anchor_text, index_status")
        .eq("campaign_id", req.params.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(100),
      db
        .from("campaign_monthly_targets")
        .select("*")
        .eq("campaign_id", req.params.id)
        .order("period_month", { ascending: false }),
    ]);

    ok(res, {
      prospects: prospects.data ?? [],
      placements: placements.data ?? [],
      targets: targets.data ?? [],
      counts: {
        prospects: prospects.data?.length ?? 0,
        placements: placements.data?.length ?? 0,
      },
    });
  }),
);

campaignsRouter.post(
  "/",
  authorize("campaigns:write"),
  validate({ body: campaignInputSchema }),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof campaignInputSchema>;

    // The client must be one this caller can see. RLS enforces it; this gives a
    // clear message rather than a foreign-key failure.
    const { data: client } = await req.auth!.db
      .from("clients")
      .select("id")
      .eq("id", body.clientId)
      .maybeSingle();
    if (!client) throw Errors.badRequest("Client not found");

    const { data, error } = await req.auth!.db
      .from("campaigns")
      .insert({
        organization_id: orgOf(req),
        ...toColumnPatch({ ...body, anchorMix: body.anchorMix ?? {} } as Record<string, unknown>, MAP),
      })
      .select(COLUMNS)
      .single();

    if (error) {
      if (error.code === "23514") throw Errors.badRequest("The end date cannot be before the start date");
      // Unique index is (org, client, lower(name)); a clash means this client
      // already has a campaign with that name.
      if (error.code === "23505") throw Errors.conflict("This client already has a campaign with that name");
      throw Errors.internal(error.message);
    }

    await auditFromRequest(req, {
      entityType: "campaign",
      entityId: data.id,
      action: "create",
      diff: { name: data.name, clientId: data.client_id },
    });

    created(res, data);
  }),
);

campaignsRouter.patch(
  "/:id",
  authorize("campaigns:write"),
  validate({ params: idParams, body: campaignInputSchema.partial() }),
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<z.infer<typeof campaignInputSchema>>;
    const patch = toColumnPatch(body as Record<string, unknown>, MAP);
    if (Object.keys(patch).length === 0) throw Errors.badRequest("No fields to update");

    const { data: before } = await req.auth!.db
      .from("campaigns")
      .select(COLUMNS)
      .eq("id", req.params.id)
      .maybeSingle();
    if (!before) throw Errors.notFound("Campaign");

    const { data, error } = await req.auth!.db
      .from("campaigns")
      .update(patch)
      .eq("id", req.params.id)
      .select(COLUMNS)
      .maybeSingle();

    if (error) {
      if (error.code === "23514") throw Errors.badRequest("The end date cannot be before the start date");
      if (error.code === "23505") throw Errors.conflict("This client already has a campaign with that name");
      throw Errors.internal(error.message);
    }
    if (!data) throw Errors.notFound("Campaign");

    await auditFromRequest(req, {
      entityType: "campaign",
      entityId: data.id,
      action: "update",
      diff: diffOf(before as Record<string, unknown>, patch),
    });

    ok(res, data);
  }),
);

campaignsRouter.delete(
  "/:id",
  authorize("campaigns:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data: existing } = await req.auth!.db
      .from("campaigns")
      .select("id, name")
      .eq("id", req.params.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (!existing) throw Errors.notFound("Campaign");

    // No .select() here: asking for the row back makes PostgreSQL re-check it
    // against the SELECT policy, which excludes archived rows.
    const { error } = await req.auth!.db
      .from("campaigns")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .is("deleted_at", null);

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "campaign",
      entityId: existing.id,
      action: "delete",
      diff: { archived: true, name: existing.name },
    });

    noContent(res);
  }),
);

campaignsRouter.post(
  "/:id/restore",
  authorize("campaigns:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("campaigns")
      .update({ deleted_at: null })
      .eq("id", req.params.id)
      .select(COLUMNS)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Campaign");

    await auditFromRequest(req, {
      entityType: "campaign",
      entityId: data.id,
      action: "update",
      diff: { restored: true },
    });

    ok(res, data);
  }),
);

campaignsRouter.put(
  "/:id/targets",
  authorize("campaigns:write"),
  validate({
    params: idParams,
    body: z.object({
      periodMonth: z.string().trim(),
      targetLinks: z.coerce.number().int().min(0),
      targetCost: z.coerce.number().min(0).nullish(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as { periodMonth: string; targetLinks: number; targetCost?: number | null };

    // Normalise to the first of the month: the column has a CHECK requiring it,
    // and a mid-month date would be rejected with an opaque error.
    const month = `${new Date(b.periodMonth).toISOString().slice(0, 7)}-01`;

    const { data, error } = await req.auth!.db
      .from("campaign_monthly_targets")
      .upsert(
        {
          organization_id: orgOf(req),
          campaign_id: req.params.id,
          period_month: month,
          target_links: b.targetLinks,
          target_cost: b.targetCost ?? null,
        },
        { onConflict: "campaign_id,period_month" },
      )
      .select()
      .single();

    if (error) throw Errors.internal(error.message);
    ok(res, data);
  }),
);

campaignsRouter.get(
  "/:id/progress",
  authorize("campaigns:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    // The progress view joins tier-1 pricing so it is service_role only; the
    // organization filter below is what keeps that safe.
    const { admin } = await import("../../integrations/supabase.js");
    const { data, error } = await admin()
      .from("v_campaign_progress")
      .select("*")
      .eq("campaign_id", req.params.id)
      .eq("organization_id", orgOf(req))
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Campaign");
    ok(res, data);
  }),
);
