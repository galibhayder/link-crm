import { Router } from "express";
import {
  PROSPECT_SORTABLE,
  prospectInputSchema,
  prospectListQuery,
  stageChangeSchema,
  touchpointCreateSchema,
  uuidSchema,
} from "@crm/shared";
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

export const prospectsRouter: Router = Router();

const idParams = z.object({ id: uuidSchema });

const COLUMNS = "id, campaign_id, publisher_id, domain, website_url, dr, monthly_traffic, spam_score, niche, price, currency, contact_name, contact_email, stage, assigned_to, supplier_id, priority, last_contacted_at, next_follow_up_at, reply_received, notes, created_at, updated_at";

const MAP: Record<string, string> = {
  campaignId: "campaign_id",
  publisherId: "publisher_id",
  domain: "domain",
  websiteUrl: "website_url",
  dr: "dr",
  monthlyTraffic: "monthly_traffic",
  spamScore: "spam_score",
  niche: "niche",
  price: "price",
  currency: "currency",
  contactName: "contact_name",
  contactEmail: "contact_email",
  assignedTo: "assigned_to",
  supplierId: "supplier_id",
  stage: "stage",
  priority: "priority",
  nextFollowUpAt: "next_follow_up_at",
  notes: "notes",
};

prospectsRouter.get(
  "/",
  authorize("prospects:read"),
  validate({ query: prospectListQuery }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<z.infer<typeof prospectListQuery>>(req);
    const { page, limit } = query;

    const sort = resolveSort(query.sort, PROSPECT_SORTABLE, "created_at");
    const order = resolveOrder(query.order, sort, [
      "dr", "monthly_traffic", "price", "next_follow_up_at", "created_at", "updated_at",
    ]);
    const { from, to } = rangeFor(page, limit);

    // A clientId filter resolves through campaigns, since prospects store
    // campaign_id. Declaring the filter without honouring it would return
    // everything while appearing filtered.
    let campaignIds: string[] | null = null;
    if (query.clientId) {
      const { data: campaigns, error: campaignErr } = await req.auth!.db
        .from("campaigns")
        .select("id")
        .eq("client_id", query.clientId)
        .is("deleted_at", null);

      if (campaignErr) throw Errors.internal(campaignErr.message);
      campaignIds = ((campaigns ?? []) as Array<{ id: string }>).map((c) => c.id);
      if (campaignIds.length === 0) {
        ok(res, [], pageMeta(page, limit, 0, sort, order));
        return;
      }
    }

    let dbQuery = req.auth!.db
      .from("prospects")
      .select(
        `${COLUMNS}, publisher:publishers(id, domain, dr, price), campaign:campaigns(id, name, client_id)`,
        { count: "exact" },
      )
      .is("deleted_at", null)
      .order(sort, { ascending: order === "asc", nullsFirst: false })
      .range(from, to);

    const search = searchClause(query.q, ["domain", "contact_name", "contact_email"]);
    if (search) dbQuery = dbQuery.or(search);

    if (query.campaignId) dbQuery = dbQuery.eq("campaign_id", query.campaignId);
    if (campaignIds) dbQuery = dbQuery.in("campaign_id", campaignIds);
    if (query.stage) dbQuery = dbQuery.eq("stage", query.stage);
    if (query.assignedTo) dbQuery = dbQuery.eq("assigned_to", query.assignedTo);
    if (query.supplierId) dbQuery = dbQuery.eq("supplier_id", query.supplierId);
    if (query.priority) dbQuery = dbQuery.eq("priority", query.priority);
    if (query.drMin !== undefined) dbQuery = dbQuery.gte("dr", query.drMin);
    if (query.trafficMin !== undefined) dbQuery = dbQuery.gte("monthly_traffic", query.trafficMin);
    if (query.followUpDue) dbQuery = dbQuery.lte("next_follow_up_at", new Date().toISOString());

    const { data, error, count } = await dbQuery;
    if (error) throw Errors.internal(error.message);

    ok(res, data ?? [], pageMeta(page, limit, count ?? 0, sort, order));
  }),
);

prospectsRouter.get(
  "/pipeline",
  authorize("prospects:read"),
  validate({ query: z.object({ campaignId: uuidSchema.optional() }) }),
  asyncRoute(async (req, res) => {
    const campaignId = parsedQuery<{ campaignId?: string }>(req).campaignId;

    const { data: stages, error: stageErr } = await req.auth!.db
      .from("pipeline_stages")
      .select("key, label, sort_order, is_won, is_lost")
      // Scoped to the PROSPECT pipeline. Since migration 0014 the table holds both
      // pipelines, so an unscoped read returns two rows per key.
      .eq("applies_to", "prospect")
      .order("sort_order");

    if (stageErr) throw Errors.internal(stageErr.message);

    let dbQuery = req.auth!.db
      .from("prospects")
      .select(
        "id, campaign_id, domain, contact_name, stage, assigned_to, priority, next_follow_up_at, reply_received, dr, price",
      )
      .is("deleted_at", null)
      .limit(1000);

    if (campaignId) dbQuery = dbQuery.eq("campaign_id", campaignId);
    const { data: prospects, error } = await dbQuery;
    if (error) throw Errors.internal(error.message);

    const rows = (prospects ?? []) as Array<{ stage: string }>;
    const stageRows = (stages ?? []) as Array<{ key: string }>;

    ok(
      res,
      stageRows.map((s) => ({
        ...s,
        prospects: rows.filter((p) => p.stage === s.key),
      })),
    );
  }),
);

prospectsRouter.get(
  "/export/csv",
  authorize("prospects:read"),
  validate({ query: prospectListQuery }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<z.infer<typeof prospectListQuery>>(req);

    let dbQuery = req.auth!.db
      .from("prospects")
      .select(COLUMNS)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(5000);

    if (query.campaignId) dbQuery = dbQuery.eq("campaign_id", query.campaignId);
    if (query.stage) dbQuery = dbQuery.eq("stage", query.stage);

    const { data, error } = await dbQuery;
    if (error) throw Errors.internal(error.message);

    const headers = [
      "domain", "website_url", "dr", "monthly_traffic", "spam_score", "niche", "price",
      "currency", "contact_name", "contact_email", "stage", "priority", "notes",
    ];

    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      niche: Array.isArray(row.niche) ? row.niche.join(", ") : row.niche,
    }));

    const csv = toCsv(headers, rows);

    await auditFromRequest(req, { entityType: "prospect", action: "export", diff: { rows: rows.length } });

    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${exportFilename("prospects")}"`);
    res.send(csv);
  }),
);

prospectsRouter.get(
  "/archived/list",
  authorize("prospects:read"),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("prospects")
      .select(COLUMNS)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .limit(200);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

prospectsRouter.get(
  "/:id",
  authorize("prospects:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("prospects")
      .select(
        `${COLUMNS}, publisher:publishers(id, domain, dr, da, monthly_traffic, price), campaign:campaigns(id, name, client_id)`,
      )
      .eq("id", req.params.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Prospect");
    ok(res, data);
  }),
);

prospectsRouter.get(
  "/:id/related",
  authorize("prospects:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const db = req.auth!.db;
    const [touchpoints, placements] = await Promise.all([
      db
        .from("outreach_touchpoints")
        .select("id, channel, direction, subject, outcome, occurred_at, user_id")
        .eq("prospect_id", req.params.id)
        .order("occurred_at", { ascending: false })
        .limit(100),
      db
        .from("placements")
        .select("id, target_url, live_url, status, live_date, anchor_text")
        .eq("prospect_id", req.params.id)
        .is("deleted_at", null)
        .limit(20),
    ]);

    ok(res, {
      touchpoints: touchpoints.data ?? [],
      placements: placements.data ?? [],
      counts: {
        touchpoints: touchpoints.data?.length ?? 0,
        placements: placements.data?.length ?? 0,
      },
    });
  }),
);

prospectsRouter.post(
  "/",
  authorize("prospects:write"),
  validate({ body: prospectInputSchema }),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof prospectInputSchema>;
    const orgId = orgOf(req);

    // The campaign must be visible to this caller. RLS would reject the insert
    // anyway; this produces a clear message instead of a foreign-key error.
    const { data: campaign } = await req.auth!.db
      .from("campaigns")
      .select("id")
      .eq("id", body.campaignId)
      .maybeSingle();
    if (!campaign) throw Errors.badRequest("Campaign not found");

    await assertSameOrg(req.auth!.db, "profiles", body.assignedTo, orgId, "Assignee");
    await assertSameOrg(req.auth!.db, "publishers", body.publisherId, orgId, "Publisher");

    // Fall back to the org's first configured stage rather than a hardcoded key
    // that a customised pipeline may not contain.
    let stage = body.stage;
    if (!stage) {
      const { data: firstStage } = await req.auth!.db
        .from("pipeline_stages")
        .select("key")
        .eq("applies_to", "prospect")
        .order("sort_order", { ascending: true })
        .limit(1)
        .maybeSingle();
      stage = (firstStage as { key?: string } | null)?.key ?? "prospected";
    }

    const { data, error } = await req.auth!.db
      .from("prospects")
      .insert({
        organization_id: orgId,
        ...toColumnPatch({ ...body, stage } as Record<string, unknown>, MAP),
      })
      .select(COLUMNS)
      .single();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("That domain is already a prospect on this campaign");
      throw Errors.internal(error.message);
    }

    await auditFromRequest(req, {
      entityType: "prospect",
      entityId: data.id,
      action: "create",
      diff: { domain: data.domain, campaignId: data.campaign_id },
    });

    created(res, data);
  }),
);

/** Stage transitions: a lost/declined move requires a reason and is audited. */
prospectsRouter.patch(
  "/:id/stage",
  authorize("prospects:write"),
  validate({ params: idParams, body: stageChangeSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof stageChangeSchema>;

    const { data: stage, error: stageErr } = await req.auth!.db
      .from("pipeline_stages")
      .select("key, is_lost, is_won")
      // Scope is essential here: without it, `maybeSingle()` fails with
      // "multiple (or no) rows returned" because both pipelines define this key.
      .eq("applies_to", "prospect")
      .eq("key", b.stage)
      .maybeSingle();

    if (stageErr) throw Errors.internal(stageErr.message);
    if (!stage) throw Errors.badRequest(`Unknown stage: ${b.stage}`);
    if ((stage as { is_lost: boolean }).is_lost && !b.reason) {
      throw Errors.badRequest("A reason is required when marking a prospect lost or declined");
    }

    const { data: before } = await req.auth!.db
      .from("prospects")
      .select("stage")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!before) throw Errors.notFound("Prospect");

    const { data, error } = await req.auth!.db
      .from("prospects")
      .update({ stage: b.stage })
      .eq("id", req.params.id)
      .select(COLUMNS)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Prospect");

    await auditFromRequest(req, {
      entityType: "prospect",
      entityId: data.id,
      action: "status_change",
      diff: { stage: { from: (before as { stage: string }).stage, to: b.stage }, reason: b.reason },
    });

    ok(res, data);
  }),
);

prospectsRouter.patch(
  "/:id",
  authorize("prospects:write"),
  validate({ params: idParams, body: prospectInputSchema.partial() }),
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<z.infer<typeof prospectInputSchema>>;

    if (body.assignedTo !== undefined) {
      await assertSameOrg(req.auth!.db, "profiles", body.assignedTo, orgOf(req), "Assignee");
    }
    if (body.publisherId !== undefined) {
      await assertSameOrg(req.auth!.db, "publishers", body.publisherId, orgOf(req), "Publisher");
    }

    const patch = toColumnPatch(body as Record<string, unknown>, MAP);
    if (Object.keys(patch).length === 0) throw Errors.badRequest("No fields to update");

    const { data: before } = await req.auth!.db
      .from("prospects")
      .select(COLUMNS)
      .eq("id", req.params.id)
      .maybeSingle();
    if (!before) throw Errors.notFound("Prospect");

    const { data, error } = await req.auth!.db
      .from("prospects")
      .update(patch)
      .eq("id", req.params.id)
      .select(COLUMNS)
      .maybeSingle();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("That domain is already a prospect on this campaign");
      throw Errors.internal(error.message);
    }
    if (!data) throw Errors.notFound("Prospect");

    await auditFromRequest(req, {
      entityType: "prospect",
      entityId: data.id,
      action: "update",
      diff: diffOf(before as Record<string, unknown>, patch),
    });

    ok(res, data);
  }),
);

prospectsRouter.delete(
  "/:id",
  authorize("prospects:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data: existing } = await req.auth!.db
      .from("prospects")
      .select("id, domain")
      .eq("id", req.params.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (!existing) throw Errors.notFound("Prospect");

    // No .select() here: asking for the row back makes PostgreSQL re-check it
    // against the SELECT policy, which excludes archived rows.
    const { error } = await req.auth!.db
      .from("prospects")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .is("deleted_at", null);

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "prospect",
      entityId: existing.id,
      action: "delete",
      diff: { archived: true, domain: existing.domain },
    });

    noContent(res);
  }),
);

prospectsRouter.post(
  "/:id/restore",
  authorize("prospects:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("prospects")
      .update({ deleted_at: null })
      .eq("id", req.params.id)
      .select(COLUMNS)
      .maybeSingle();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("That domain is already an active prospect on this campaign");
      throw Errors.internal(error.message);
    }
    if (!data) throw Errors.notFound("Prospect");

    await auditFromRequest(req, {
      entityType: "prospect",
      entityId: data.id,
      action: "update",
      diff: { restored: true },
    });

    ok(res, data);
  }),
);

prospectsRouter.get(
  "/:id/touchpoints",
  authorize("touchpoints:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("outreach_touchpoints")
      .select("*")
      .eq("prospect_id", req.params.id)
      .order("occurred_at", { ascending: false });

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

prospectsRouter.post(
  "/:id/touchpoints",
  authorize("touchpoints:write"),
  validate({ params: idParams, body: touchpointCreateSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof touchpointCreateSchema>;

    const { data, error } = await req.auth!.db
      .from("outreach_touchpoints")
      .insert({
        organization_id: orgOf(req),
        prospect_id: req.params.id,
        user_id: req.auth!.userId,
        channel: b.channel,
        direction: b.direction,
        subject: b.subject ?? null,
        body_excerpt: b.bodyExcerpt ?? null,
        outcome: b.outcome ?? null,
        occurred_at: b.occurredAt.toISOString(),
      })
      .select()
      .single();

    if (error) throw Errors.internal(error.message);

    // Advance the prospect's follow-up clock alongside the log entry, so the
    // "due today" queue reflects reality without a second client write.
    await req.auth!.db
      .from("prospects")
      .update({
        last_contacted_at: b.occurredAt.toISOString(),
        reply_received: b.direction === "inbound",
      })
      .eq("id", req.params.id);

    created(res, data);
  }),
);

prospectsRouter.post(
  "/bulk-assign",
  authorize("prospects:assign"),
  validate({
    body: z.object({
      prospectIds: z.array(uuidSchema).min(1).max(500),
      assignedTo: uuidSchema.nullable(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as { prospectIds: string[]; assignedTo: string | null };

    if (b.assignedTo) {
      await assertSameOrg(req.auth!.db, "profiles", b.assignedTo, orgOf(req), "Assignee");
    }

    const { data, error } = await req.auth!.db
      .from("prospects")
      .update({ assigned_to: b.assignedTo })
      .in("id", b.prospectIds)
      .select("id");

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "prospect",
      action: "update",
      diff: { bulkAssigned: data?.length ?? 0, assignedTo: b.assignedTo },
    });

    ok(res, { updated: data?.length ?? 0 });
  }),
);
