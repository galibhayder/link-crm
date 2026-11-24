import { Router } from "express";
import { z } from "zod";
import { asyncRoute, ok, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";

/**
 * SUPPLIER PORTAL — /supplier/v1
 *
 * One surface for both direct publishers and link vendors, because
 * suppliers.supplier_type distinguishes them but their access is identical.
 *
 * The publisher_user RLS policy pins every row to
 * supplier_id = current_supplier_id(), so this router cannot return another
 * supplier's sites even if a filter were omitted. It also never returns the
 * client rate: that is tier 1 and this role holds no policy on it.
 */
export const supplierRouter: Router = Router();

supplierRouter.get(
  "/me",
  asyncRoute(async (req, res) => {
    const { data } = await req.auth!.db
      .from("suppliers")
      .select("id, name, supplier_type, contact_email, payment_terms_days, status")
      .eq("id", req.auth!.supplierId ?? "")
      .maybeSingle();

    ok(res, {
      userId: req.auth!.userId,
      email: req.auth!.email,
      supplier: data ?? null,
    });
  }),
);

supplierRouter.get(
  "/queue",
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("prospects")
      .select("id, campaign_id, domain, contact_name, stage, priority, next_follow_up_at")
      .is("deleted_at", null)
      .order("priority", { ascending: false });

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

supplierRouter.get(
  "/prospects/:id",
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("prospects")
      .select("id, domain, contact_name, stage, priority, next_follow_up_at, reply_received")
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Prospect");
    ok(res, data);
  }),
);

supplierRouter.post(
  "/prospects/:id/touchpoints",
  validate({
    params: z.object({ id: z.string().uuid() }),
    body: z.object({
      channel: z.enum(["email", "linkedin", "contact_form", "phone", "other"]),
      direction: z.enum(["outbound", "inbound"]).default("outbound"),
      subject: z.string().max(300).optional(),
      bodyExcerpt: z.string().max(5000).optional(),
      outcome: z.enum(["no_reply", "positive", "negative", "bounce", "auto_reply"]).optional(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as Record<string, string | undefined>;

    const { data, error } = await req.auth!.db
      .from("outreach_touchpoints")
      .insert({
        organization_id: req.auth!.orgId,
        prospect_id: req.params.id,
        user_id: req.auth!.userId,
        channel: b.channel,
        direction: b.direction ?? "outbound",
        subject: b.subject ?? null,
        body_excerpt: b.bodyExcerpt ?? null,
        outcome: b.outcome ?? null,
      })
      .select()
      .single();

    if (error) throw Errors.internal(error.message);
    ok(res, data);
  }),
);

supplierRouter.get(
  "/publishers",
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("publishers")
      .select("id, domain, name, dr, da, monthly_traffic, niche, country, link_type, status")
      .is("deleted_at", null);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

supplierRouter.patch(
  "/publishers/:id",
  validate({
    params: z.object({ id: z.string().uuid() }),
    body: z.object({
      dr: z.number().int().min(0).max(100).optional(),
      monthlyTraffic: z.number().int().min(0).optional(),
      acceptsGuestPost: z.boolean().optional(),
      contactEmail: z.string().email().optional(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (b.dr !== undefined) patch.dr = b.dr;
    if (b.monthlyTraffic !== undefined) patch.monthly_traffic = b.monthlyTraffic;
    if (b.acceptsGuestPost !== undefined) patch.accepts_guest_post = b.acceptsGuestPost;
    if (b.contactEmail !== undefined) patch.contact_email = b.contactEmail;

    if (Object.keys(patch).length === 0) throw Errors.badRequest("No fields to update");

    const { data, error } = await req.auth!.db
      .from("publishers")
      .update(patch)
      .eq("id", req.params.id)
      .select()
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Publisher");
    ok(res, data);
  }),
);

/** Placements this supplier fulfilled — cost side only, never the client rate. */
supplierRouter.get(
  "/placements",
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("placements")
      .select("id, target_url, live_url, link_type, status, live_date, scheduled_date")
      .is("deleted_at", null);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

supplierRouter.get(
  "/earnings",
  asyncRoute(async (req, res) => {
    // Tier 2, own supplier only — enforced by the placement_costs policy.
    const { data, error } = await req.auth!.db
      .from("placement_costs")
      .select("id, placement_id, supplier_cost, currency, paid, created_at");

    if (error) throw Errors.internal(error.message);

    const rows = data ?? [];
    ok(res, {
      placements: rows,
      totalEarned: rows.reduce((s, r) => s + Number(r.supplier_cost ?? 0), 0),
      unpaid: rows.filter((r) => !r.paid).reduce((s, r) => s + Number(r.supplier_cost ?? 0), 0),
    });
  }),
);
