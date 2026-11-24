import { Router } from "express";
import { paginationSchema, paymentCreateSchema, uuidSchema } from "@crm/shared";
import { z } from "zod";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, ok, validate, parsedQuery } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest } from "../../lib/audit.js";

/**
 * PAYMENTS — the source of truth for whether an invoice is paid.
 *
 * `invoices.status` is a projection recomputed by trigger, which is what makes
 * a partial payment or a refund representable. Storing `paid` plus a single
 * `paid_at` could express neither.
 */
export const paymentsRouter: Router = Router();

paymentsRouter.get(
  "/",
  authorize("payments:read"),
  validate({ query: paginationSchema.extend({ invoiceId: uuidSchema.optional() }) }),
  asyncRoute(async (req, res) => {
    const { page, limit, invoiceId } = parsedQuery<z.infer<typeof paginationSchema> & { invoiceId?: string }>(req);

    let query = req.auth!.db
      .from("payments")
      .select("*, invoice:invoices(id, invoice_number, total)", { count: "exact" })
      .order("received_at", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (invoiceId) query = query.eq("invoice_id", invoiceId);

    const { data, error, count } = await query;
    if (error) throw Errors.internal(error.message);
    ok(res, data ?? [], { page, limit, total: count ?? 0 });
  }),
);

paymentsRouter.post(
  "/",
  authorize("payments:write"),
  validate({ body: paymentCreateSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof paymentCreateSchema>;

    const { data, error } = await req.auth!.db
      .from("payments")
      .insert({
        organization_id: req.auth!.orgId,
        invoice_id: b.invoiceId,
        amount: b.amount,
        method: b.method,
        reference: b.reference ?? null,
        received_at: b.receivedAt.toISOString(),
        recorded_by: req.auth!.userId,
      })
      .select()
      .single();

    if (error) throw Errors.internal(error.message);

    // Trigger has already recomputed status; return the current projection.
    const { data: invoice } = await req.auth!.db
      .from("invoices")
      .select("id, invoice_number, status, total")
      .eq("id", b.invoiceId)
      .maybeSingle();

    await auditFromRequest(req, {
      entityType: "payment",
      entityId: (data as { id: string }).id,
      action: "create",
      diff: { invoiceId: b.invoiceId, amount: b.amount, method: b.method },
    });

    created(res, { payment: data, invoice });
  }),
);

/**
 * Reverse a payment.
 *
 * A mis-keyed amount is inevitable, and the alternative to reversing it is a
 * database edit by hand. Deleting the row is correct rather than recording a
 * negative payment: the trigger recomputes from the remaining rows, so the
 * invoice's derived status returns to the right state by itself.
 *
 * Guarded by `payments:write` (owner). The audit entry keeps the deleted amount,
 * so the reversal is visible even though the row is gone.
 */
paymentsRouter.delete(
  "/:id([0-9a-fA-F-]{36})",
  authorize("payments:write"),
  validate({ params: z.object({ id: uuidSchema }) }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;

    const { data: before, error: findErr } = await req.auth!.db
      .from("payments")
      .select("id, invoice_id, amount, currency, method, reference")
      .eq("id", id)
      .maybeSingle();

    if (findErr) throw Errors.internal(findErr.message);
    if (!before) throw Errors.notFound("Payment");

    const { error } = await req.auth!.db.from("payments").delete().eq("id", id);
    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "payment",
      entityId: id,
      action: "delete",
      diff: before as Record<string, unknown>,
    });

    // Re-read so the caller sees the reconciled invoice rather than guessing.
    const { data: invoice } = await req.auth!.db
      .from("invoices")
      .select("id, invoice_number, status, total")
      .eq("id", (before as { invoice_id: string }).invoice_id)
      .maybeSingle();

    ok(res, { deleted: true, invoice });
  }),
);
