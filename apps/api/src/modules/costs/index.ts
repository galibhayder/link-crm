import { Router } from "express";
import { placementCostSchema, uuidSchema } from "@crm/shared";
import { z } from "zod";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, ok, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest } from "../../lib/audit.js";

/**
 * TIER 2 — WHOLESALE COST.
 *
 * Readable by owner, prospector, outreach_specialist and the supplier being
 * paid. account_manager is absent from this permission by design, and also has
 * no RLS policy on the base table — so even a bug that skipped authorize()
 * would return zero rows rather than a cost.
 */
export const costsRouter: Router = Router();

const placementParams = z.object({ placementId: uuidSchema });

costsRouter.get(
  "/placements/:placementId",
  authorize("costs:read"),
  validate({ params: placementParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("placement_costs")
      .select("*")
      .eq("placement_id", req.params.placementId)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Cost");
    ok(res, data);
  }),
);

costsRouter.put(
  "/placements/:placementId",
  authorize("costs:write"),
  validate({ params: placementParams, body: placementCostSchema }),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof placementCostSchema>;

    const { data, error } = await req.auth!.db
      .from("placement_costs")
      .upsert(
        {
          organization_id: req.auth!.orgId,
          placement_id: req.params.placementId,
          supplier_cost: body.supplierCost,
          currency: body.currency,
          supplier_id: body.supplierId ?? null,
        },
        { onConflict: "placement_id" },
      )
      .select()
      .single();

    if (error) throw Errors.internal(error.message);

    // Wholesale cost is the most commercially sensitive number in the system,
    // so every change to it is attributable.
    await auditFromRequest(req, {
      entityType: "placement_cost",
      entityId: req.params.placementId,
      action: "update",
      diff: { supplierCost: body.supplierCost, currency: body.currency },
    });

    ok(res, data);
  }),
);
