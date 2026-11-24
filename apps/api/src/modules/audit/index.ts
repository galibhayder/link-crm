import { Router } from "express";
import { paginationSchema, uuidSchema } from "@crm/shared";
import { z } from "zod";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, ok, validate, parsedQuery } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";

/**
 * AUDIT TRAIL — read-only, owner only.
 *
 * No role can INSERT here through the API: the table has no insert policy and
 * rows are written by lib/audit.ts over service_role. That asymmetry is what
 * makes the trail trustworthy — the people being observed cannot edit it.
 */
export const auditRouter: Router = Router();

const listQuery = paginationSchema.extend({
  entityType: z.string().max(60).optional(),
  entityId: uuidSchema.optional(),
  actorId: uuidSchema.optional(),
  action: z.string().max(40).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

auditRouter.get(
  "/",
  authorize("audit:read"),
  validate({ query: listQuery }),
  asyncRoute(async (req, res) => {
    const { page, limit, entityType, entityId, actorId, action, from, to } = parsedQuery<
      z.infer<typeof listQuery>
    >(req);

    let query = req.auth!.db
      .from("activity_log")
      .select(
        "id, actor_id, actor_name_snapshot, actor_role, entity_type, entity_id, action, diff, ip, created_at",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (entityType) query = query.eq("entity_type", entityType);
    if (entityId) query = query.eq("entity_id", entityId);
    if (actorId) query = query.eq("actor_id", actorId);
    if (action) query = query.eq("action", action);
    if (from) query = query.gte("created_at", from.toISOString());
    if (to) query = query.lte("created_at", to.toISOString());

    const { data, error, count } = await query;
    if (error) throw Errors.internal(error.message);

    ok(res, data ?? [], { page, limit, total: count ?? 0 });
  }),
);

/** Full history for one record, which is what an audit review actually needs. */
auditRouter.get(
  "/entity/:entityType/:entityId",
  authorize("audit:read"),
  validate({
    params: z.object({ entityType: z.string().max(60), entityId: uuidSchema }),
  }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("activity_log")
      .select("id, actor_id, actor_name_snapshot, actor_role, action, diff, created_at")
      .eq("entity_type", req.params.entityType)
      .eq("entity_id", req.params.entityId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);
