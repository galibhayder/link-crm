import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, ok, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest } from "../../lib/audit.js";

export const settingsRouter: Router = Router();

settingsRouter.get(
  "/org",
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("organizations")
      .select("id, name, slug, timezone, currency, invoice_prefix, logo_url, brand_color, settings")
      .eq("id", req.auth!.orgId)
      .single();

    if (error) throw Errors.internal(error.message);
    ok(res, data);
  }),
);

settingsRouter.patch(
  "/org",
  authorize("settings:manage"),
  validate({
    body: z.object({
      name: z.string().min(1).max(120).optional(),
      timezone: z.string().min(1).optional(),
      currency: z.string().length(3).optional(),
      invoicePrefix: z.string().max(12).optional(),
      brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      logoUrl: z.string().url().optional(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.timezone !== undefined) patch.timezone = b.timezone;
    if (b.currency !== undefined) patch.currency = b.currency;
    if (b.invoicePrefix !== undefined) patch.invoice_prefix = b.invoicePrefix;
    if (b.brandColor !== undefined) patch.brand_color = b.brandColor;
    if (b.logoUrl !== undefined) patch.logo_url = b.logoUrl;

    if (Object.keys(patch).length === 0) throw Errors.badRequest("No fields to update");

    const { data, error } = await req.auth!.db
      .from("organizations")
      .update(patch)
      .eq("id", req.auth!.orgId)
      .select()
      .single();

    if (error) throw Errors.internal(error.message);
    ok(res, data);
  }),
);

// ---------------------------------------------------------------------------
// BRANDING — the logo
//
// Stored as a bounded data URI on `organizations.logo_url`, because that column is
// already read by the sidebar, the login screen and the invoice PDF. One value,
// one place: uploading a mark here changes the invoice a client receives.
//
// Validation lives in integrations/logo.ts — size, magic bytes, SVG sanitising.
// ---------------------------------------------------------------------------
settingsRouter.put(
  "/org/logo",
  authorize("settings:manage"),
  validate({ body: z.object({ dataUri: z.string().min(1).max(400_000) }) }),
  asyncRoute(async (req, res) => {
    const { validateLogoDataUri, LogoError } = await import("../../integrations/logo.js");

    let validated;
    try {
      validated = validateLogoDataUri((req.body as { dataUri: string }).dataUri);
    } catch (err) {
      if (err instanceof LogoError) throw Errors.badRequest(err.message);
      throw err;
    }

    const { data, error } = await req.auth!.db
      .from("organizations")
      .update({ logo_url: validated.dataUri })
      .eq("id", req.auth!.orgId)
      .select("id, logo_url")
      .single();

    if (error) throw Errors.internal(error.message);

    // The data URI is not logged: it is a 95 KB blob and would drown the audit row.
    await auditFromRequest(req, {
      entityType: "organization",
      entityId: req.auth!.orgId,
      action: "update",
      diff: { logo: { mime: validated.mime, bytes: validated.bytes } },
    });

    ok(res, { ...data, mime: validated.mime, bytes: validated.bytes });
  }),
);

settingsRouter.delete(
  "/org/logo",
  authorize("settings:manage"),
  asyncRoute(async (req, res) => {
    const { error } = await req.auth!.db
      .from("organizations")
      .update({ logo_url: null })
      .eq("id", req.auth!.orgId);

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "organization",
      entityId: req.auth!.orgId,
      action: "update",
      diff: { logo: "removed" },
    });

    ok(res, { removed: true });
  }),
);

// ---------------------------------------------------------------------------
// Pipeline stages — configurable per org, so "customizable" is real
// ---------------------------------------------------------------------------
settingsRouter.get(
  "/pipeline-stages",
  validate({ query: z.object({ appliesTo: z.enum(["prospect", "placement"]).optional() }) }),
  asyncRoute(async (req, res) => {
    const appliesTo = (req.query.appliesTo as string | undefined) ?? "prospect";

    const { data, error } = await req.auth!.db
      .from("pipeline_stages")
      .select("*")
      // Scoped: the table holds both pipelines since migration 0014, so an
      // unscoped read returns interleaved rows for two different workflows.
      .eq("applies_to", appliesTo)
      .order("sort_order");

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

settingsRouter.post(
  "/pipeline-stages",
  authorize("pipeline:configure"),
  validate({
    body: z.object({
      key: z.string().regex(/^[a-z0-9_]+$/).max(60),
      label: z.string().min(1).max(80),
      sortOrder: z.number().int().default(0),
      isWon: z.boolean().default(false),
      isLost: z.boolean().default(false),
      /** Which pipeline this stage belongs to. Defaults to prospect. */
      appliesTo: z.enum(["prospect", "placement"]).default("prospect"),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as {
      key: string;
      label: string;
      sortOrder: number;
      isWon: boolean;
      isLost: boolean;
      appliesTo: "prospect" | "placement";
    };

    const { data, error } = await req.auth!.db
      .from("pipeline_stages")
      .insert({
        organization_id: req.auth!.orgId,
        applies_to: b.appliesTo,
        key: b.key,
        label: b.label,
        sort_order: b.sortOrder,
        is_won: b.isWon,
        is_lost: b.isLost,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("That stage key already exists");
      throw Errors.internal(error.message);
    }
    ok(res, data);
  }),
);
