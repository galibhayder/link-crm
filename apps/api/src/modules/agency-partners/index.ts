import { Router } from "express";
import {
  AGENCY_PARTNER_SORTABLE,
  agencyPartnerInputSchema,
  agencyPartnerListQuery,
  domainSchema,
  uuidSchema,
} from "@crm/shared";
import { z } from "zod";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, noContent, ok, parsedQuery, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest, diffOf } from "../../lib/audit.js";
import { booleanQuery } from "../../lib/query.js";
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

/**
 * AGENCY PARTNERS — white-label and reseller agencies that buy fulfilment.
 *
 * Distinct from a client because the commercial relationship differs: a partner
 * has a pricing model (markup, discount or fixed), may rebrand our reports, and
 * has its own end-clients we must never see. Folding them into `clients` would
 * lose that distinction permanently.
 */
export const agencyPartnersRouter: Router = Router();

const idParams = z.object({ id: uuidSchema });

/**
 * The input schema carries a cross-field `.refine`, which makes it a
 * ZodEffects — and ZodEffects has no `.partial()`. PATCH therefore uses the
 * unrefined object as a partial, and re-checks the pricing rule below only when
 * the model or its matching rate is actually being changed.
 */
const agencyPartnerBaseSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(160),
  domain: domainSchema,
  partnerType: z.enum(["white_label", "reseller", "referral"]),
  status: z.enum(["prospect", "active", "paused", "churned"]),
  contactName: z.string().trim().max(120).nullish(),
  contactEmail: z.string().trim().max(200).nullish(),
  contactPhone: z.string().trim().max(40).nullish(),
  pricingModel: z.enum(["markup", "discount", "fixed"]),
  markupPct: z.coerce.number().min(0).max(1000).nullish(),
  discountPct: z.coerce.number().min(0).max(100).nullish(),
  fixedRate: z.coerce.number().min(0).nullish(),
  currency: z.string().trim().length(3),
  billingEmail: z.string().trim().max(200).nullish(),
  paymentTermsDays: z.coerce.number().int().min(0).max(365),
  whiteLabelReports: booleanQuery,
  accountManagerId: uuidSchema.nullish(),
  startDate: z.string().trim().nullish(),
  notes: z.string().trim().max(10_000).nullish(),
});

const agencyPartnerPatchSchema = agencyPartnerBaseSchema.partial();

const COLUMNS = "id, name, domain, partner_type, status, contact_name, contact_email, contact_phone, pricing_model, markup_pct, discount_pct, fixed_rate, currency, billing_email, payment_terms_days, white_label_reports, account_manager_id, start_date, notes, created_at, updated_at";

const MAP: Record<string, string> = {
  name: "name",
  domain: "domain",
  partnerType: "partner_type",
  status: "status",
  contactName: "contact_name",
  contactEmail: "contact_email",
  contactPhone: "contact_phone",
  pricingModel: "pricing_model",
  markupPct: "markup_pct",
  discountPct: "discount_pct",
  fixedRate: "fixed_rate",
  currency: "currency",
  billingEmail: "billing_email",
  paymentTermsDays: "payment_terms_days",
  whiteLabelReports: "white_label_reports",
  accountManagerId: "account_manager_id",
  startDate: "start_date",
  notes: "notes",
};

agencyPartnersRouter.get(
  "/",
  authorize("clients:read"),
  validate({ query: agencyPartnerListQuery }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<z.infer<typeof agencyPartnerListQuery>>(req);
    const { page, limit } = query;

    const sort = resolveSort(query.sort, AGENCY_PARTNER_SORTABLE, "created_at");
    const order = resolveOrder(query.order, sort, ["created_at", "updated_at"]);
    const { from, to } = rangeFor(page, limit);

    let dbQuery = req.auth!.db
      .from("agency_partners")
      .select(COLUMNS, { count: "exact" })
      .is("deleted_at", null)
      .order(sort, { ascending: order === "asc", nullsFirst: false })
      .range(from, to);

    const search = searchClause(query.q, ["name", "domain", "contact_name", "contact_email"]);
    if (search) dbQuery = dbQuery.or(search);

    for (const filter of buildFilters([
      { column: "status", op: "eq", value: query.status },
      { column: "partner_type", op: "eq", value: query.partnerType },
      { column: "pricing_model", op: "eq", value: query.pricingModel },
    ])) {
      dbQuery = dbQuery.eq(filter.column, filter.value as string);
    }

    const { data, error, count } = await dbQuery;
    if (error) throw Errors.internal(error.message);

    ok(res, data ?? [], pageMeta(page, limit, count ?? 0, sort, order));
  }),
);

agencyPartnersRouter.get(
  "/export/csv",
  authorize("clients:read"),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("agency_partners")
      .select(COLUMNS)
      .is("deleted_at", null)
      .order("name")
      .limit(5000);

    if (error) throw Errors.internal(error.message);

    const headers = [
      "name", "domain", "partner_type", "status", "contact_name", "contact_email",
      "pricing_model", "markup_pct", "discount_pct", "fixed_rate", "currency", "notes",
    ];
    const csv = toCsv(headers, (data ?? []) as Array<Record<string, unknown>>);

    await auditFromRequest(req, {
      entityType: "agency_partner",
      action: "export",
      diff: { rows: data?.length ?? 0 },
    });

    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${exportFilename("agency-partners")}"`);
    res.send(csv);
  }),
);

agencyPartnersRouter.get(
  "/:id",
  authorize("clients:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("agency_partners")
      .select(`${COLUMNS}, clients:clients(id, name, domain, status)`)
      .eq("id", req.params.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Agency partner");
    ok(res, data);
  }),
);

agencyPartnersRouter.post(
  "/",
  authorize("clients:write"),
  validate({ body: agencyPartnerInputSchema }),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof agencyPartnerInputSchema>;
    const orgId = orgOf(req);

    await assertSameOrg(req.auth!.db, "profiles", body.accountManagerId, orgId, "Account manager");

    const { data, error } = await req.auth!.db
      .from("agency_partners")
      .insert({ organization_id: orgId, ...toColumnPatch(body as Record<string, unknown>, MAP) })
      .select(COLUMNS)
      .single();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("A partner with that domain already exists");
      if (error.code === "23514") throw Errors.badRequest("Provide the rate that matches the pricing model");
      throw Errors.internal(error.message);
    }

    await auditFromRequest(req, {
      entityType: "agency_partner",
      entityId: data.id,
      action: "create",
      diff: { name: data.name, domain: data.domain, pricingModel: data.pricing_model },
    });

    created(res, data);
  }),
);

agencyPartnersRouter.patch(
  "/:id",
  authorize("clients:write"),
  validate({ params: idParams, body: agencyPartnerPatchSchema }),
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<z.infer<typeof agencyPartnerBaseSchema>>;

    if (body.accountManagerId !== undefined) {
      await assertSameOrg(req.auth!.db, "profiles", body.accountManagerId, orgOf(req), "Account manager");
    }

    const patch = toColumnPatch(body as Record<string, unknown>, MAP);
    if (Object.keys(patch).length === 0) throw Errors.badRequest("No fields to update");

    const { data: before } = await req.auth!.db
      .from("agency_partners")
      .select(COLUMNS)
      .eq("id", req.params.id)
      .maybeSingle();

    if (!before) throw Errors.notFound("Agency partner");

    const { data, error } = await req.auth!.db
      .from("agency_partners")
      .update(patch)
      .eq("id", req.params.id)
      .select(COLUMNS)
      .maybeSingle();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("A partner with that domain already exists");
      if (error.code === "23514") throw Errors.badRequest("Provide the rate that matches the pricing model");
      throw Errors.internal(error.message);
    }
    if (!data) throw Errors.notFound("Agency partner");

    await auditFromRequest(req, {
      entityType: "agency_partner",
      entityId: data.id,
      action: "update",
      diff: diffOf(before as Record<string, unknown>, patch),
    });

    ok(res, data);
  }),
);

agencyPartnersRouter.delete(
  "/:id",
  authorize("clients:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    // Refuse to archive a partner that still has active clients: those would
    // silently lose their commercial context.
    const { count } = await req.auth!.db
      .from("clients")
      .select("id", { count: "exact", head: true })
      .eq("agency_partner_id", req.params.id)
      .is("deleted_at", null);

    if ((count ?? 0) > 0) {
      throw Errors.conflict(
        `This partner still has ${count} active client(s). Reassign them before archiving.`,
      );
    }

    // Archiving goes through the SECURITY DEFINER helper (migration 0012): a
    // plain UPDATE fails under RLS once deleted_at is set, because the row stops
    // matching the SELECT policy and PostgreSQL re-checks it on the way out.
    const result = await archiveRecord(req.auth!.db, "agency_partners", req.params.id!);

    if (!result.ok) {
      const kind = archiveErrorToResponse(result.message);
      if (kind === "not_found") throw Errors.notFound("Agency partner");
      if (kind === "forbidden") throw Errors.forbidden(result.message);
      throw Errors.internal(result.message ?? "Could not archive partner");
    }

    await auditFromRequest(req, {
      entityType: "agency_partner",
      entityId: result.id!,
      action: "delete",
      diff: { archived: true, name: result.label },
    });

    noContent(res);
  }),
);

agencyPartnersRouter.post(
  "/:id/restore",
  authorize("clients:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const result = await restoreRecord(req.auth!.db, "agency_partners", req.params.id!);

    if (!result.ok) {
      const kind = archiveErrorToResponse(result.message);
      if (kind === "conflict") throw Errors.conflict("Another active partner already uses that domain");
      if (kind === "not_found") throw Errors.notFound("Archived partner");
      if (kind === "forbidden") throw Errors.forbidden(result.message);
      throw Errors.internal(result.message ?? "Could not restore partner");
    }

    const { data } = await req.auth!.db
      .from("agency_partners")
      .select(COLUMNS)
      .eq("id", req.params.id)
      .maybeSingle();

    await auditFromRequest(req, {
      entityType: "agency_partner",
      entityId: req.params.id!,
      action: "update",
      diff: { restored: true },
    });

    ok(res, data);
  }),
);
