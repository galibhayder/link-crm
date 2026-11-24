import { Router } from "express";
import { PUBLISHER_SORTABLE, publisherInputSchema, publisherListQuery, uuidSchema } from "@crm/shared";
import { z } from "zod";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, noContent, ok, parsedQuery, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest, diffOf } from "../../lib/audit.js";
import {
  assertSameOrg,
  orgOf,
  pageMeta,
  rangeFor,
  resolveOrder,
  resolveSort,
  searchClause,
  toColumnPatch,
} from "../../lib/crud.js";
import { exportFilename, toCsv } from "../../lib/csv.js";

/**
 * PUBLISHERS — the supply side.
 *
 * `price` is TIER 2 (wholesale cost): what WE pay. RLS decides who may read the
 * row at all; this router only decides the shape of the response. An account
 * manager has no policy on the cost tables and must not see a publisher's
 * asking price when quoting a client.
 */
export const publishersRouter: Router = Router();

const idParams = z.object({ id: uuidSchema });

const COLUMNS = "id, domain, website_url, name, supplier_id, dr, da, monthly_traffic, spam_score, spam_source, niche, country, language, link_type, price, currency, accepts_guest_post, accepts_link_insertion, status, contact_name, contact_email, contact_form_url, metrics_source, last_checked_at, notes, created_at, updated_at";

const MAP: Record<string, string> = {
  domain: "domain",
  websiteUrl: "website_url",
  name: "name",
  supplierId: "supplier_id",
  dr: "dr",
  da: "da",
  monthlyTraffic: "monthly_traffic",
  spamScore: "spam_score",
  spamSource: "spam_source",
  niche: "niche",
  country: "country",
  language: "language",
  linkType: "link_type",
  price: "price",
  currency: "currency",
  acceptsGuestPost: "accepts_guest_post",
  acceptsLinkInsertion: "accepts_link_insertion",
  status: "status",
  contactName: "contact_name",
  contactEmail: "contact_email",
  contactFormUrl: "contact_form_url",
  notes: "notes",
};

publishersRouter.get(
  "/",
  authorize("publishers:read"),
  validate({ query: publisherListQuery }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<z.infer<typeof publisherListQuery>>(req);
    const { page, limit } = query;

    const sort = resolveSort(query.sort, PUBLISHER_SORTABLE, "dr");
    const order = resolveOrder(query.order, sort, [
      "dr", "da", "monthly_traffic", "price", "spam_score", "created_at", "updated_at",
    ]);
    const { from, to } = rangeFor(page, limit);

    let dbQuery = req.auth!.db
      .from("publishers")
      .select(COLUMNS, { count: "exact" })
      .is("deleted_at", null)
      .order(sort, { ascending: order === "asc", nullsFirst: false })
      .range(from, to);

    const search = searchClause(query.q, ["domain", "name", "contact_name", "contact_email"]);
    if (search) dbQuery = dbQuery.or(search);

    if (query.status) dbQuery = dbQuery.eq("status", query.status);
    if (query.supplierId) dbQuery = dbQuery.eq("supplier_id", query.supplierId);
    if (query.linkType) dbQuery = dbQuery.eq("link_type", query.linkType);
    if (query.country) dbQuery = dbQuery.eq("country", query.country.toUpperCase());
    if (query.niche) dbQuery = dbQuery.contains("niche", [query.niche]);

    // Range filters applied only when supplied, so an empty bound does not
    // silently exclude rows whose metric is NULL.
    if (query.drMin !== undefined) dbQuery = dbQuery.gte("dr", query.drMin);
    if (query.drMax !== undefined) dbQuery = dbQuery.lte("dr", query.drMax);
    if (query.trafficMin !== undefined) dbQuery = dbQuery.gte("monthly_traffic", query.trafficMin);
    if (query.spamMax !== undefined) dbQuery = dbQuery.lte("spam_score", query.spamMax);
    if (query.priceMin !== undefined) dbQuery = dbQuery.gte("price", query.priceMin);
    if (query.priceMax !== undefined) dbQuery = dbQuery.lte("price", query.priceMax);

    const { data, error, count } = await dbQuery;
    if (error) throw Errors.internal(error.message);

    ok(res, data ?? [], pageMeta(page, limit, count ?? 0, sort, order));
  }),
);

publishersRouter.get(
  "/export/csv",
  authorize("publishers:read"),
  validate({ query: publisherListQuery }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<z.infer<typeof publisherListQuery>>(req);

    let dbQuery = req.auth!.db
      .from("publishers")
      .select(COLUMNS)
      .is("deleted_at", null)
      .order("domain")
      .limit(5000);

    const search = searchClause(query.q, ["domain", "name"]);
    if (search) dbQuery = dbQuery.or(search);
    if (query.status) dbQuery = dbQuery.eq("status", query.status);
    if (query.drMin !== undefined) dbQuery = dbQuery.gte("dr", query.drMin);
    if (query.priceMax !== undefined) dbQuery = dbQuery.lte("price", query.priceMax);

    const { data, error } = await dbQuery;
    if (error) throw Errors.internal(error.message);

    const headers = [
      "domain", "website_url", "name", "dr", "da", "monthly_traffic", "spam_score", "niche",
      "price", "currency", "country", "language", "link_type", "accepts_guest_post",
      "accepts_link_insertion", "contact_name", "contact_email", "status", "notes",
    ];

    // `niche` is a text[]; flatten so it round-trips through the importer.
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      niche: Array.isArray(row.niche) ? row.niche.join(", ") : row.niche,
    }));

    const csv = toCsv(headers, rows);

    await auditFromRequest(req, { entityType: "publisher", action: "export", diff: { rows: rows.length } });

    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${exportFilename("publishers")}"`);
    res.send(csv);
  }),
);

publishersRouter.get(
  "/options/filters",
  authorize("publishers:read"),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("publishers")
      .select("niche, country, status, link_type")
      .is("deleted_at", null)
      .limit(3000);

    if (error) throw Errors.internal(error.message);

    const rows = (data ?? []) as Array<{
      niche: string[] | null;
      country: string | null;
      status: string | null;
      link_type: string | null;
    }>;

    const niches = new Set<string>();
    for (const row of rows) {
      for (const n of row.niche ?? []) niches.add(n);
    }

    ok(res, {
      niches: [...niches].sort(),
      countries: [...new Set(rows.map((r) => r.country).filter(Boolean))].sort(),
      statuses: [...new Set(rows.map((r) => r.status).filter(Boolean))].sort(),
      linkTypes: [...new Set(rows.map((r) => r.link_type).filter(Boolean))].sort(),
    });
  }),
);

publishersRouter.get(
  "/archived/list",
  authorize("publishers:read"),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("publishers")
      .select(COLUMNS)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .limit(200);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

publishersRouter.get(
  "/:id",
  authorize("publishers:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("publishers")
      .select(
        `${COLUMNS}, offers:publisher_offers(id, quoted_price, currency, link_type, valid_from, valid_until, source)`,
      )
      .eq("id", req.params.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Publisher");
    ok(res, data);
  }),
);

publishersRouter.get(
  "/:id/related",
  authorize("publishers:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const db = req.auth!.db;
    const [prospects, placements] = await Promise.all([
      db
        .from("prospects")
        .select("id, domain, stage, campaign_id, priority, next_follow_up_at")
        .eq("publisher_id", req.params.id)
        .is("deleted_at", null)
        .limit(50),
      db
        .from("placements")
        .select("id, campaign_id, target_url, live_url, status, live_date, anchor_text")
        .eq("publisher_id", req.params.id)
        .is("deleted_at", null)
        .limit(50),
    ]);

    ok(res, {
      prospects: prospects.data ?? [],
      placements: placements.data ?? [],
      counts: {
        prospects: prospects.data?.length ?? 0,
        placements: placements.data?.length ?? 0,
      },
    });
  }),
);

publishersRouter.post(
  "/",
  authorize("publishers:write"),
  validate({ body: publisherInputSchema }),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof publisherInputSchema>;
    const orgId = orgOf(req);

    await assertSameOrg(req.auth!.db, "suppliers", body.supplierId, orgId, "Supplier");

    const { data, error } = await req.auth!.db
      .from("publishers")
      .insert({ organization_id: orgId, ...toColumnPatch(body as Record<string, unknown>, MAP) })
      .select(COLUMNS)
      .single();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("That domain is already in the publisher database");
      throw Errors.internal(error.message);
    }

    await auditFromRequest(req, {
      entityType: "publisher",
      entityId: data.id,
      action: "create",
      diff: { domain: data.domain, dr: data.dr, price: data.price },
    });

    created(res, data);
  }),
);

publishersRouter.patch(
  "/:id",
  authorize("publishers:write"),
  validate({ params: idParams, body: publisherInputSchema.partial() }),
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<z.infer<typeof publisherInputSchema>>;

    if (body.supplierId !== undefined) {
      await assertSameOrg(req.auth!.db, "suppliers", body.supplierId, orgOf(req), "Supplier");
    }

    const patch = toColumnPatch(body as Record<string, unknown>, MAP);
    if (Object.keys(patch).length === 0) throw Errors.badRequest("No fields to update");

    const { data: before } = await req.auth!.db
      .from("publishers")
      .select(COLUMNS)
      .eq("id", req.params.id)
      .maybeSingle();

    if (!before) throw Errors.notFound("Publisher");

    const { data, error } = await req.auth!.db
      .from("publishers")
      .update(patch)
      .eq("id", req.params.id)
      .select(COLUMNS)
      .maybeSingle();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("That domain already exists");
      throw Errors.internal(error.message);
    }
    if (!data) throw Errors.notFound("Publisher");

    await auditFromRequest(req, {
      entityType: "publisher",
      entityId: data.id,
      action: "update",
      diff: diffOf(before as Record<string, unknown>, patch),
    });

    ok(res, data);
  }),
);

publishersRouter.delete(
  "/:id",
  authorize("publishers:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data: existing } = await req.auth!.db
      .from("publishers")
      .select("id, domain")
      .eq("id", req.params.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (!existing) throw Errors.notFound("Publisher");

    // No .select() here: asking for the row back makes PostgreSQL re-check it
    // against the SELECT policy, which excludes archived rows.
    const { error } = await req.auth!.db
      .from("publishers")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .is("deleted_at", null);

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "publisher",
      entityId: existing.id,
      action: "delete",
      diff: { archived: true, domain: existing.domain },
    });

    noContent(res);
  }),
);

publishersRouter.post(
  "/:id/restore",
  authorize("publishers:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("publishers")
      .update({ deleted_at: null })
      .eq("id", req.params.id)
      .select(COLUMNS)
      .maybeSingle();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("Another active publisher uses that domain");
      throw Errors.internal(error.message);
    }
    if (!data) throw Errors.notFound("Publisher");

    await auditFromRequest(req, {
      entityType: "publisher",
      entityId: data.id,
      action: "update",
      diff: { restored: true },
    });

    ok(res, data);
  }),
);

publishersRouter.get(
  "/:id/offers",
  authorize("offers:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("publisher_offers")
      .select("*")
      .eq("publisher_id", req.params.id)
      .order("valid_from", { ascending: false })
      .limit(100);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

publishersRouter.post(
  "/:id/offers",
  authorize("offers:write"),
  validate({
    params: idParams,
    body: z.object({
      quotedPrice: z.coerce.number().min(0),
      currency: z.string().trim().length(3).default("USD"),
      linkType: z.enum(["dofollow", "nofollow", "ugc", "sponsored"]).default("dofollow"),
      validFrom: z.string().trim().optional(),
      validUntil: z.string().trim().nullish(),
      source: z.string().trim().max(80).nullish(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as {
      quotedPrice: number;
      currency: string;
      linkType: string;
      validFrom?: string;
      validUntil?: string | null;
      source?: string | null;
    };

    const { data, error } = await req.auth!.db
      .from("publisher_offers")
      .insert({
        organization_id: orgOf(req),
        publisher_id: req.params.id,
        quoted_price: b.quotedPrice,
        currency: b.currency,
        link_type: b.linkType,
        valid_from: b.validFrom
          ? new Date(b.validFrom).toISOString().slice(0, 10)
          : new Date().toISOString().slice(0, 10),
        valid_until: b.validUntil ? new Date(b.validUntil).toISOString().slice(0, 10) : null,
        source: b.source ?? null,
      })
      .select()
      .single();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "publisher",
      entityId: req.params.id,
      action: "update",
      diff: { newOffer: b.quotedPrice },
    });

    created(res, data);
  }),
);
