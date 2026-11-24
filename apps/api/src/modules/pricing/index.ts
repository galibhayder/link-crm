import { Router } from "express";
import { placementPricingSchema, uuidSchema } from "@crm/shared";
import { z } from "zod";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, ok, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";

/**
 * TIER 1 — CLIENT PRICING.
 *
 * A separate router, a separate table and a separate permission from
 * placement_costs. That separation is what makes "sales/account managers never
 * see wholesale cost" an RLS fact instead of a coding convention.
 */
export const pricingRouter: Router = Router();

const placementParams = z.object({ placementId: uuidSchema });

pricingRouter.get(
  "/placements/:placementId",
  authorize("pricing:read"),
  validate({ params: placementParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("placement_pricing")
      .select("*")
      .eq("placement_id", req.params.placementId)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Pricing");
    ok(res, data);
  }),
);

pricingRouter.put(
  "/placements/:placementId",
  authorize("pricing:write"),
  validate({ params: placementParams, body: placementPricingSchema }),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof placementPricingSchema>;

    const { data, error } = await req.auth!.db
      .from("placement_pricing")
      .upsert(
        {
          organization_id: req.auth!.orgId,
          placement_id: req.params.placementId,
          client_rate: body.clientRate,
          currency: body.currency,
        },
        { onConflict: "placement_id" },
      )
      .select()
      .single();

    if (error) throw Errors.internal(error.message);
    ok(res, data);
  }),
);
