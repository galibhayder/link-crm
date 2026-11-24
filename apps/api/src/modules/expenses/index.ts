import { Router } from "express";
import { z } from "zod";
import { campaignExpenseCreateSchema, campaignExpenseUpdateSchema, paginationSchema, uuidSchema } from "@crm/shared";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, ok, validate, parsedQuery } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest, diffOf } from "../../lib/audit.js";

/**
 * CAMPAIGN EXPENSES — OWNER ONLY.
 *
 * The "other expenses" term in campaign profitability: tooling, subcontractors,
 * advertising. Kept out of `placement_costs` because a monthly SaaS bill is not
 * attributable to one placement, and putting it there would distort per-placement
 * margin — which is the number used to decide what to charge.
 */
export const expensesRouter: Router = Router();

const idParams = z.object({ id: uuidSchema });

const listQuery = paginationSchema.extend({
  campaignId: uuidSchema.optional(),
  category: z.enum(["tools", "subcontractor", "advertising", "travel", "other"]).optional(),
});

expensesRouter.get(
  "/",
  authorize("expenses:read"),
  validate({ query: listQuery }),
  asyncRoute(async (req, res) => {
    const q = parsedQuery<z.infer<typeof listQuery>>(req);

    let query = req.auth!.db
      .from("campaign_expenses")
      .select("*, campaign:campaigns(id, name)", { count: "exact" })
      .order("incurred_on", { ascending: false })
      .range((q.page - 1) * q.limit, q.page * q.limit - 1);

    if (q.campaignId) query = query.eq("campaign_id", q.campaignId);
    if (q.category) query = query.eq("category", q.category);

    const { data, error, count } = await query;
    if (error) throw Errors.internal(error.message);

    ok(res, data ?? [], { page: q.page, limit: q.limit, total: count ?? 0 });
  }),
);

expensesRouter.post(
  "/",
  authorize("expenses:write"),
  validate({ body: campaignExpenseCreateSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof campaignExpenseCreateSchema>;

    const { data, error } = await req.auth!.db
      .from("campaign_expenses")
      .insert({
        organization_id: req.auth!.orgId,
        campaign_id: b.campaignId,
        placement_id: b.placementId ?? null,
        category: b.category,
        description: b.description,
        amount: b.amount,
        currency: b.currency,
        incurred_on: (b.incurredOn ?? new Date()).toISOString().slice(0, 10),
        vendor: b.vendor ?? null,
        notes: b.notes ?? null,
        created_by: req.auth!.userId,
      })
      .select()
      .single();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "campaign_expense",
      entityId: (data as { id: string }).id,
      action: "create",
      diff: { amount: b.amount, currency: b.currency, category: b.category },
    });

    created(res, data);
  }),
);

expensesRouter.patch(
  "/:id([0-9a-fA-F-]{36})",
  authorize("expenses:write"),
  validate({ params: idParams, body: campaignExpenseUpdateSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof campaignExpenseUpdateSchema>;

    const { data: before, error: findErr } = await req.auth!.db
      .from("campaign_expenses")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();

    if (findErr) throw Errors.internal(findErr.message);
    if (!before) throw Errors.notFound("Expense");

    const patch: Record<string, unknown> = {};
    if (b.campaignId !== undefined) patch.campaign_id = b.campaignId;
    if (b.placementId !== undefined) patch.placement_id = b.placementId ?? null;
    if (b.category !== undefined) patch.category = b.category;
    if (b.description !== undefined) patch.description = b.description;
    if (b.amount !== undefined) patch.amount = b.amount;
    if (b.currency !== undefined) patch.currency = b.currency;
    if (b.incurredOn !== undefined) patch.incurred_on = b.incurredOn.toISOString().slice(0, 10);
    if (b.vendor !== undefined) patch.vendor = b.vendor ?? null;
    if (b.notes !== undefined) patch.notes = b.notes ?? null;

    const { data, error } = await req.auth!.db
      .from("campaign_expenses")
      .update(patch)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "campaign_expense",
      entityId: req.params.id,
      action: "update",
      diff: diffOf(before, data),
    });

    ok(res, data);
  }),
);

expensesRouter.delete(
  "/:id([0-9a-fA-F-]{36})",
  authorize("expenses:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data: before } = await req.auth!.db
      .from("campaign_expenses")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();

    if (!before) throw Errors.notFound("Expense");

    const { error } = await req.auth!.db.from("campaign_expenses").delete().eq("id", req.params.id);
    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "campaign_expense",
      entityId: req.params.id,
      action: "delete",
      diff: before as Record<string, unknown>,
    });

    ok(res, { deleted: true });
  }),
);
