import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, ok, noContent, validate, parsedQuery } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";

/**
 * SAVED TABLE VIEWS.
 *
 * The table already existed with filters, sort and `is_shared`. Phase 7 adds
 * `is_default` (the view a module opens with) and `is_system` (an owner-authored
 * view shared with everyone).
 *
 * AUTHORIZATION is RLS, not this router:
 *
 *   `saved_views_own` allows SELECT where `user_id = auth.uid() OR is_shared`,
 *   and INSERT/UPDATE only where `user_id = auth.uid()`.
 *
 * So "a user may read a shared view and edit only their own" is enforced by the
 * database, and the checks here exist only to give better messages — a bug in
 * this file cannot let one user edit another's view.
 */
export const adminViewsRouter: Router = Router();

const idParams = z.object({ id: z.string().uuid() });

const viewSchema = z.object({
  module: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(60),
  filters: z.record(z.string(), z.unknown()).default({}),
  sort: z.record(z.string(), z.unknown()).default({}),
  isShared: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  isSystem: z.boolean().default(false),
});

adminViewsRouter.get(
  "/",
  validate({ query: z.object({ module: z.string().max(60).optional() }) }),
  asyncRoute(async (req, res) => {
    const { module } = parsedQuery<{ module?: string }>(req);

    // The caller's RLS client: own views plus anything shared.
    let query = req.auth!.db
      .from("saved_views")
      .select("id, user_id, module, name, filters, sort, is_shared, is_default, is_system, created_at")
      .order("is_default", { ascending: false })
      .order("name");

    if (module) query = query.eq("module", module);

    const { data, error } = await query;
    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

adminViewsRouter.post(
  "/",
  validate({ body: viewSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof viewSchema>;

    // An owner-authored system view is shared with the whole organisation by
    // definition. A non-owner cannot create one — the table's CHECK constraint
    // enforces that too, but a clear 403 beats a constraint violation.
    if (b.isSystem && req.auth!.role !== "owner") {
      throw Errors.forbidden("Only the account owner can create a shared system view");
    }

    // One default per (user, module). Clearing the previous one first avoids a
    // unique-violation race that would otherwise surface as a 500.
    if (b.isDefault) {
      await req.auth!.db
        .from("saved_views")
        .update({ is_default: false })
        .eq("module", b.module)
        .eq("user_id", req.auth!.userId)
        .eq("is_default", true);
    }

    const { data, error } = await req.auth!.db
      .from("saved_views")
      .insert({
        organization_id: req.auth!.orgId,
        user_id: req.auth!.userId,
        module: b.module,
        name: b.name,
        filters: b.filters,
        sort: b.sort,
        is_shared: b.isShared || b.isSystem,
        is_default: b.isDefault,
        is_system: b.isSystem,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("You already have a default view for this module");
      throw Errors.internal(error.message);
    }

    created(res, data);
  }),
);

adminViewsRouter.patch(
  "/:id",
  validate({ params: idParams, body: viewSchema.partial() }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const b = req.body as Partial<z.infer<typeof viewSchema>>;

    const { data: before } = await req.auth!.db
      .from("saved_views")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    // Zero rows means either it does not exist or it is someone else's. Both are
    // reported as 404 — confirming that another user's view exists would itself be
    // a small disclosure.
    if (!before) throw Errors.notFound("View");

    const owned = (before as { user_id: string }).user_id === req.auth!.userId;
    if (!owned) throw Errors.notFound("View");

    if (b.isSystem !== undefined && b.isSystem && req.auth!.role !== "owner") {
      throw Errors.forbidden("Only the account owner can mark a view as a system view");
    }

    if (b.isDefault) {
      await req.auth!.db
        .from("saved_views")
        .update({ is_default: false })
        .eq("module", (before as { module: string }).module)
        .eq("user_id", req.auth!.userId)
        .eq("is_default", true)
        .neq("id", id);
    }

    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.filters !== undefined) patch.filters = b.filters;
    if (b.sort !== undefined) patch.sort = b.sort;
    if (b.isShared !== undefined) patch.is_shared = b.isShared;
    if (b.isDefault !== undefined) patch.is_default = b.isDefault;
    if (b.isSystem !== undefined) patch.is_system = b.isSystem;

    if (Object.keys(patch).length === 0) throw Errors.badRequest("No fields to update");

    const { data, error } = await req.auth!.db
      .from("saved_views")
      .update(patch)
      .eq("id", id)
      .select()
      .single();

    if (error) throw Errors.internal(error.message);
    ok(res, data);
  }),
);

adminViewsRouter.delete(
  "/:id",
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;

    const { data: before } = await req.auth!.db
      .from("saved_views")
      .select("id, user_id, is_system")
      .eq("id", id)
      .maybeSingle();

    if (!before) throw Errors.notFound("View");

    // A system view belongs to the organisation, so only an owner may remove it —
    // even though an ordinary user can see it through `is_shared`.
    const row = before as { user_id: string; is_system: boolean };
    if (row.is_system && req.auth!.role !== "owner") {
      throw Errors.forbidden("Only the account owner can delete a system view");
    }
    if (!row.is_system && row.user_id !== req.auth!.userId) {
      throw Errors.notFound("View");
    }

    const { error } = await req.auth!.db.from("saved_views").delete().eq("id", id);
    if (error) throw Errors.internal(error.message);

    noContent(res);
  }),
);
