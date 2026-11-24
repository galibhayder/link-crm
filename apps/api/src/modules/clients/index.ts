import { Router } from "express";
import { CLIENT_SORTABLE, clientInputSchema, clientListQuery, uuidSchema } from "@crm/shared";
import { z } from "zod";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, noContent, ok, parsedQuery, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest, diffOf } from "../../lib/audit.js";
import {
  assertSameOrg,
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
import { archiveErrorToResponse, archiveRecord, restoreRecord } from "../../lib/archive.js";

export const clientsRouter: Router = Router();

const idParams = z.object({ id: uuidSchema });

const CLIENT_COLUMNS =
  "id, name, domain, website_url, industry, status, manager_id, agency_partner_id, start_date, notes, created_at, updated_at";

const CLIENT_MAP: Record<string, string> = {
  name: "name",
  domain: "domain",
  websiteUrl: "website_url",
  industry: "industry",
  status: "status",
  managerId: "manager_id",
  agencyPartnerId: "agency_partner_id",
  startDate: "start_date",
  notes: "notes",
};

// ---------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------
clientsRouter.get(
  "/",
  authorize("clients:read"),
  validate({ query: clientListQuery }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<z.infer<typeof clientListQuery>>(req);
    const { page, limit } = query;

    const sort = resolveSort(query.sort, CLIENT_SORTABLE, "created_at");
    const order = resolveOrder(query.order, sort, ["created_at", "updated_at", "start_date"]);
    const { from, to } = rangeFor(page, limit);

    let dbQuery = req.auth!.db
      .from("clients")
      .select(CLIENT_COLUMNS, { count: "exact" })
      .is("deleted_at", null)
      .order(sort, { ascending: order === "asc", nullsFirst: false })
      .range(from, to);

    const search = searchClause(query.q, ["name", "domain", "industry"]);
    if (search) dbQuery = dbQuery.or(search);

    for (const filter of buildFilters([
      { column: "status", op: "eq", value: query.status },
      { column: "manager_id", op: "eq", value: query.managerId },
      { column: "agency_partner_id", op: "eq", value: query.agencyPartnerId },
      { column: "industry", op: "eq", value: query.industry },
    ])) {
      dbQuery = dbQuery.eq(filter.column, filter.value as string);
    }

    const { data, error, count } = await dbQuery;
    if (error) throw Errors.internal(error.message);

    ok(res, data ?? [], pageMeta(page, limit, count ?? 0, sort, order));
  }),
);

// ---------------------------------------------------------------------------
// EXPORT — before /:id, else "export" is read as an id
// ---------------------------------------------------------------------------
clientsRouter.get(
  "/export/csv",
  authorize("clients:read"),
  validate({ query: clientListQuery }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<z.infer<typeof clientListQuery>>(req);

    let dbQuery = req.auth!.db
      .from("clients")
      .select("name, domain, website_url, status, industry, start_date, notes")
      .is("deleted_at", null)
      .order("name", { ascending: true })
      .limit(5000);

    const search = searchClause(query.q, ["name", "domain"]);
    if (search) dbQuery = dbQuery.or(search);
    if (query.status) dbQuery = dbQuery.eq("status", query.status);

    const { data, error } = await dbQuery;
    if (error) throw Errors.internal(error.message);

    const headers = ["name", "domain", "website_url", "status", "industry", "start_date", "notes"];
    const csv = toCsv(headers, (data ?? []) as Array<Record<string, unknown>>);

    await auditFromRequest(req, { entityType: "client", action: "export", diff: { rows: data?.length ?? 0 } });

    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${exportFilename("clients")}"`);
    res.send(csv);
  }),
);

clientsRouter.get(
  "/archived/list",
  authorize("clients:read"),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("clients")
      .select(CLIENT_COLUMNS)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .limit(200);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

clientsRouter.get(
  "/options/filters",
  authorize("clients:read"),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("clients")
      .select("industry, status")
      .is("deleted_at", null)
      .limit(2000);

    if (error) throw Errors.internal(error.message);

    const rows = (data ?? []) as Array<{ industry: string | null; status: string | null }>;
    ok(res, {
      industries: [...new Set(rows.map((r) => r.industry).filter(Boolean))].sort(),
      statuses: [...new Set(rows.map((r) => r.status).filter(Boolean))].sort(),
    });
  }),
);

// ---------------------------------------------------------------------------
// READ ONE
// ---------------------------------------------------------------------------
clientsRouter.get(
  "/:id",
  authorize("clients:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("clients")
      .select(
        `*, campaigns:campaigns(id, name, status, service_type, monthly_link_target, start_date),
         contacts:client_contacts(id, name, email, phone, role_title, is_primary),
         partner:agency_partners(id, name, domain)`,
      )
      .eq("id", req.params.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Client");
    ok(res, data);
  }),
);

clientsRouter.get(
  "/:id/related",
  authorize("clients:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const db = req.auth!.db;
    const campaignResult = await db
      .from("campaigns")
      .select("id, name, status, service_type, monthly_link_target, start_date")
      .eq("client_id", req.params.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    const campaigns = (campaignResult.data ?? []) as Array<{ id: string }>;

    const [invoices, placements] = await Promise.all([
      db
        .from("invoices")
        .select("id, invoice_number, status, total, currency, issued_at, due_date")
        .eq("client_id", req.params.id)
        .order("created_at", { ascending: false })
        .limit(20),
      campaigns.length > 0
        ? db
            .from("placements")
            .select("id, campaign_id, target_url, live_url, status, live_date, index_status, anchor_text")
            .in("campaign_id", campaigns.map((c) => c.id))
            .is("deleted_at", null)
            .order("created_at", { ascending: false })
            .limit(50)
        : Promise.resolve({ data: [] as unknown[] }),
    ]);

    ok(res, {
      campaigns,
      placements: placements.data ?? [],
      invoices: invoices.data ?? [],
      counts: {
        campaigns: campaigns.length,
        placements: placements.data?.length ?? 0,
        invoices: invoices.data?.length ?? 0,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------
clientsRouter.post(
  "/",
  authorize("clients:write"),
  validate({ body: clientInputSchema }),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof clientInputSchema>;
    const orgId = orgOf(req);

    await assertSameOrg(req.auth!.db, "profiles", body.managerId, orgId, "Manager");
    await assertSameOrg(req.auth!.db, "agency_partners", body.agencyPartnerId, orgId, "Agency partner");

    const { data, error } = await req.auth!.db
      .from("clients")
      .insert({ organization_id: orgId, ...toColumnPatch(body as Record<string, unknown>, CLIENT_MAP) })
      .select(CLIENT_COLUMNS)
      .single();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("A client with that domain already exists");
      throw Errors.internal(error.message);
    }

    await auditFromRequest(req, {
      entityType: "client",
      entityId: data.id,
      action: "create",
      diff: { name: data.name, domain: data.domain },
    });

    created(res, data);
  }),
);

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------
clientsRouter.patch(
  "/:id",
  authorize("clients:write"),
  validate({ params: idParams, body: clientInputSchema.partial() }),
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<z.infer<typeof clientInputSchema>>;

    if (body.managerId !== undefined) {
      await assertSameOrg(req.auth!.db, "profiles", body.managerId, orgOf(req), "Manager");
    }
    if (body.agencyPartnerId !== undefined) {
      await assertSameOrg(req.auth!.db, "agency_partners", body.agencyPartnerId, orgOf(req), "Agency partner");
    }

    const patch = toColumnPatch(body as Record<string, unknown>, CLIENT_MAP);
    if (Object.keys(patch).length === 0) throw Errors.badRequest("No fields to update");

    const { data: before } = await req.auth!.db
      .from("clients")
      .select(CLIENT_COLUMNS)
      .eq("id", req.params.id)
      .maybeSingle();

    if (!before) throw Errors.notFound("Client");

    const { data, error } = await req.auth!.db
      .from("clients")
      .update(patch)
      .eq("id", req.params.id)
      .select(CLIENT_COLUMNS)
      .maybeSingle();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("A client with that domain already exists");
      throw Errors.internal(error.message);
    }
    if (!data) throw Errors.notFound("Client");

    await auditFromRequest(req, {
      entityType: "client",
      entityId: data.id,
      action: "update",
      diff: diffOf(before as Record<string, unknown>, patch),
    });

    ok(res, data);
  }),
);

// ---------------------------------------------------------------------------
// ARCHIVE / RESTORE
// ---------------------------------------------------------------------------
clientsRouter.delete(
  "/:id",
  authorize("clients:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    // Archiving goes through a SECURITY DEFINER function (migration 0012).
    // A plain UPDATE fails under RLS: once `deleted_at` is set the row stops
    // matching the SELECT policy, and PostgreSQL re-checks the row on the way
    // out. The function performs the write with the CALLER'S claims, so
    // tenancy and role are still enforced inside the database.
    const result = await archiveRecord(req.auth!.db, "clients", req.params.id!);

    if (!result.ok) {
      const kind = archiveErrorToResponse(result.message);
      if (kind === "not_found") throw Errors.notFound("Client");
      if (kind === "forbidden") throw Errors.forbidden(result.message);
      throw Errors.internal(result.message ?? "Could not archive client");
    }

    await auditFromRequest(req, {
      entityType: "client",
      entityId: result.id!,
      action: "delete",
      diff: { archived: true, domain: result.label },
    });

    noContent(res);
  }),
);

clientsRouter.post(
  "/:id/restore",
  authorize("clients:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const result = await restoreRecord(req.auth!.db, "clients", req.params.id!);

    if (!result.ok) {
      const kind = archiveErrorToResponse(result.message);
      if (kind === "conflict") throw Errors.conflict("Another active client already uses that domain");
      if (kind === "not_found") throw Errors.notFound("Archived client");
      if (kind === "forbidden") throw Errors.forbidden(result.message);
      throw Errors.internal(result.message ?? "Could not restore client");
    }

    await auditFromRequest(req, {
      entityType: "client",
      entityId: req.params.id!,
      action: "update",
      diff: { restored: true },
    });

    const { data } = await req.auth!.db
      .from("clients")
      .select(CLIENT_COLUMNS)
      .eq("id", req.params.id)
      .maybeSingle();

    ok(res, data);
  }),
);

// ---------------------------------------------------------------------------
// PORTAL ACCESS
// ---------------------------------------------------------------------------
clientsRouter.get(
  "/:id/portal-access",
  authorize("portal_access:manage"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("user_client_access")
      .select("user_id, created_at, profiles:user_id (full_name, email, role)")
      .eq("client_id", req.params.id);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

clientsRouter.post(
  "/:id/portal-access",
  authorize("portal_access:manage"),
  validate({ params: idParams, body: z.object({ userId: uuidSchema }) }),
  asyncRoute(async (req, res) => {
    const userId = (req.body as { userId: string }).userId;

    const { data, error } = await req.auth!.db
      .from("user_client_access")
      .insert({ organization_id: orgOf(req), client_id: req.params.id, user_id: userId })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("That user already has access to this client");
      throw Errors.internal(error.message);
    }

    await auditFromRequest(req, {
      entityType: "client",
      entityId: req.params.id,
      action: "update",
      diff: { grantedPortalAccessTo: userId },
    });

    created(res, data);
  }),
);

clientsRouter.delete(
  "/:id/portal-access/:userId",
  authorize("portal_access:manage"),
  validate({ params: z.object({ id: uuidSchema, userId: uuidSchema }) }),
  asyncRoute(async (req, res) => {
    const { error } = await req.auth!.db
      .from("user_client_access")
      .delete()
      .eq("client_id", req.params.id)
      .eq("user_id", req.params.userId);

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "client",
      entityId: req.params.id,
      action: "update",
      diff: { revokedPortalAccessFrom: req.params.userId },
    });

    noContent(res);
  }),
);
