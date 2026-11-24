import { Router } from "express";
import { z } from "zod";
import { writerPayoutCreateSchema, writerPayoutUpdateSchema, paginationSchema, uuidSchema } from "@crm/shared";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, ok, validate, parsedQuery } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest, diffOf } from "../../lib/audit.js";

/**
 * WRITER PAYOUTS — OWNER ONLY.
 *
 * This is what the agency pays its writers. It is guarded by `payouts:*`, which
 * only the owner holds, and by an RLS policy that is equally narrow. Both are
 * present on purpose: the permission stops the request, the policy stops the row.
 *
 * Deliberately NOT visible to account managers (they see client money, not
 * internal pay), and not to writers themselves — there is no per-writer
 * visibility concept in this product, so showing a writer "their" payouts would
 * mean showing them everyone's.
 *
 * The house rule for every mutation here: record who changed what, with a
 * before/after diff, because a payout figure that moved without a trail is
 * indistinguishable from a mistake.
 */
export const payoutsRouter: Router = Router();

const idParams = z.object({ id: uuidSchema });

const listQuery = paginationSchema.extend({
  status: z.enum(["pending", "approved", "paid"]).optional(),
  campaignId: uuidSchema.optional(),
  placementId: uuidSchema.optional(),
  writerId: uuidSchema.optional(),
});

payoutsRouter.get(
  "/",
  authorize("payouts:read"),
  validate({ query: listQuery }),
  asyncRoute(async (req, res) => {
    const q = parsedQuery<z.infer<typeof listQuery>>(req);

    // The profile embed names its foreign key explicitly.
    //
    // `writer_payouts` has TWO columns pointing at `profiles` (`writer_id` and
    // `created_by`), so a bare `profiles(...)` embed is ambiguous and PostgREST
    // rejects the whole query with "more than one relationship was found". This
    // surfaces as a 500 on the list endpoint while every single-row route works,
    // which is exactly the kind of failure that reads like a mystery.
    let query = req.auth!.db
      .from("writer_payouts")
      .select(
        "*, placement:placements(id, target_url), campaign:campaigns(id, name), writer:profiles!writer_payouts_writer_id_fkey(id, full_name, email)",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range((q.page - 1) * q.limit, q.page * q.limit - 1);

    if (q.status) query = query.eq("status", q.status);
    if (q.campaignId) query = query.eq("campaign_id", q.campaignId);
    if (q.placementId) query = query.eq("placement_id", q.placementId);
    if (q.writerId) query = query.eq("writer_id", q.writerId);

    const { data, error, count } = await query;
    if (error) throw Errors.internal(error.message);

    ok(res, data ?? [], { page: q.page, limit: q.limit, total: count ?? 0 });
  }),
);

payoutsRouter.get(
  "/:id([0-9a-fA-F-]{36})",
  authorize("payouts:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("writer_payouts")
      .select("*, placement:placements(id, target_url), campaign:campaigns(id, name)")
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Payout");
    ok(res, data);
  }),
);

payoutsRouter.post(
  "/",
  authorize("payouts:write"),
  validate({ body: writerPayoutCreateSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof writerPayoutCreateSchema>;

    // A payout marked paid must carry a date, otherwise "paid" cannot be audited.
    if (b.status === "paid" && !b.paidAt) {
      throw Errors.badRequest("A payout marked paid needs a payment date");
    }

    const { data, error } = await req.auth!.db
      .from("writer_payouts")
      .insert({
        organization_id: req.auth!.orgId,
        placement_id: b.placementId ?? null,
        campaign_id: b.campaignId ?? null,
        writer_id: b.writerId ?? null,
        fee_type: b.feeType,
        description: b.description ?? null,
        amount: b.amount,
        currency: b.currency,
        status: b.status,
        paid_at: b.paidAt ? b.paidAt.toISOString() : null,
        reference: b.reference ?? null,
        notes: b.notes ?? null,
        created_by: req.auth!.userId,
      })
      .select()
      .single();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "writer_payout",
      entityId: (data as { id: string }).id,
      action: "create",
      diff: { amount: b.amount, currency: b.currency, writerId: b.writerId ?? null },
    });

    created(res, data);
  }),
);

payoutsRouter.patch(
  "/:id([0-9a-fA-F-]{36})",
  authorize("payouts:write"),
  validate({ params: idParams, body: writerPayoutUpdateSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof writerPayoutUpdateSchema>;

    const { data: before, error: findErr } = await req.auth!.db
      .from("writer_payouts")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();

    if (findErr) throw Errors.internal(findErr.message);
    if (!before) throw Errors.notFound("Payout");

    const patch: Record<string, unknown> = {};
    if (b.placementId !== undefined) patch.placement_id = b.placementId ?? null;
    if (b.campaignId !== undefined) patch.campaign_id = b.campaignId ?? null;
    if (b.writerId !== undefined) patch.writer_id = b.writerId ?? null;
    if (b.feeType !== undefined) patch.fee_type = b.feeType;
    if (b.description !== undefined) patch.description = b.description ?? null;
    if (b.amount !== undefined) patch.amount = b.amount;
    if (b.currency !== undefined) patch.currency = b.currency;
    if (b.status !== undefined) patch.status = b.status;
    if (b.reference !== undefined) patch.reference = b.reference ?? null;
    if (b.notes !== undefined) patch.notes = b.notes ?? null;

    if (b.paidAt !== undefined) patch.paid_at = b.paidAt ? b.paidAt.toISOString() : null;

    // Moving to `paid` without a date is refused here too, not only on create.
    if (patch.status === "paid" && !patch.paid_at) {
      const existingPaidAt = (before as { paid_at?: string | null }).paid_at;
      if (!existingPaidAt) throw Errors.badRequest("A payout marked paid needs a payment date");
      patch.paid_at = existingPaidAt;
    }

    const { data, error } = await req.auth!.db
      .from("writer_payouts")
      .update(patch)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "writer_payout",
      entityId: req.params.id,
      action: "update",
      diff: diffOf(before, data),
    });

    ok(res, data);
  }),
);

payoutsRouter.delete(
  "/:id([0-9a-fA-F-]{36})",
  authorize("payouts:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data: before } = await req.auth!.db
      .from("writer_payouts")
      .select("amount, currency, status")
      .eq("id", req.params.id)
      .maybeSingle();

    if (!before) throw Errors.notFound("Payout");

    // A paid payout is a completed transaction. Deleting it would make the
    // ledger disagree with the bank, so it is refused rather than soft-deleted.
    if ((before as { status: string }).status === "paid") {
      throw Errors.badRequest("A paid payout cannot be deleted. Reverse it as a separate entry instead.");
    }

    const { error } = await req.auth!.db.from("writer_payouts").delete().eq("id", req.params.id);
    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "writer_payout",
      entityId: req.params.id,
      action: "delete",
      diff: before as Record<string, unknown>,
    });

    ok(res, { deleted: true });
  }),
);
