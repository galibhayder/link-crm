import { Router } from "express";
import { supplierCreateSchema, uuidSchema } from "@crm/shared";
import { z } from "zod";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, noContent, ok, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";

/**
 * SUPPLIERS — one table for both direct publishers and link vendors.
 *
 * A site owner and a link wholesaler are the same party with different
 * capabilities, so they share the record and the portal. Keeping them in two
 * tables meant two places to record what a link costs, and margin reporting
 * would have had to guess which to trust.
 */
export const suppliersRouter: Router = Router();

const idParams = z.object({ id: uuidSchema });

suppliersRouter.get(
  "/",
  authorize("suppliers:read"),
  validate({ query: z.object({ type: z.enum(["direct_publisher", "link_vendor"]).optional() }) }),
  asyncRoute(async (req, res) => {
    const type = (req.query as { type?: string }).type;

    let query = req.auth!.db
      .from("suppliers")
      .select("*, publishers:count")
      .order("name");

    if (type) query = query.eq("supplier_type", type);

    const { data, error } = await query;
    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

suppliersRouter.get(
  "/:id",
  authorize("suppliers:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("suppliers")
      .select("*, publishers(*)")
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Supplier");
    ok(res, data);
  }),
);

suppliersRouter.post(
  "/",
  authorize("suppliers:write"),
  validate({ body: supplierCreateSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof supplierCreateSchema>;

    const { data, error } = await req.auth!.db
      .from("suppliers")
      .insert({
        organization_id: req.auth!.orgId,
        name: b.name,
        supplier_type: b.supplierType,
        contact_name: b.contactName ?? null,
        contact_email: b.contactEmail ?? null,
        payment_terms_days: b.paymentTermsDays,
        notes: b.notes ?? null,
      })
      .select()
      .single();

    if (error) throw Errors.internal(error.message);
    created(res, data);
  }),
);

suppliersRouter.patch(
  "/:id",
  authorize("suppliers:write"),
  validate({ params: idParams, body: supplierCreateSchema.partial() }),
  asyncRoute(async (req, res) => {
    const b = req.body as Partial<z.infer<typeof supplierCreateSchema>>;
    const patch: Record<string, unknown> = {};
    const map: Record<string, string> = {
      name: "name",
      supplierType: "supplier_type",
      contactName: "contact_name",
      contactEmail: "contact_email",
      paymentTermsDays: "payment_terms_days",
      notes: "notes",
    };
    for (const [camel, snake] of Object.entries(map)) {
      if ((b as Record<string, unknown>)[camel] !== undefined) patch[snake] = (b as Record<string, unknown>)[camel];
    }
    if (Object.keys(patch).length === 0) throw Errors.badRequest("No fields to update");

    const { data, error } = await req.auth!.db
      .from("suppliers")
      .update(patch)
      .eq("id", req.params.id)
      .select()
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Supplier");
    ok(res, data);
  }),
);

suppliersRouter.delete(
  "/:id",
  authorize("suppliers:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    // Archive rather than delete: supplier rows are referenced by cost history.
    const { data, error } = await req.auth!.db
      .from("suppliers")
      .update({ status: "archived" })
      .eq("id", req.params.id)
      .select("id")
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Supplier");
    noContent(res);
  }),
);
