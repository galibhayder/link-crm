import { Router } from "express";
import { z } from "zod";
import { asyncRoute, ok, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest, diffOf } from "../../lib/audit.js";

/**
 * SELF-SERVICE PROFILE.
 *
 * Deliberately limited to name, phone and avatar. Role, activation and
 * organization are NOT editable here — migration 0005 revokes UPDATE on those
 * columns from `authenticated` and adds a trigger, so even a direct PostgREST
 * call cannot change them.
 */
export const profileRouter: Router = Router();

const PROFILE_COLUMNS =
  "id, full_name, email, role, phone, avatar_url, is_active, last_seen_at, created_at, role_changed_at";

profileRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .eq("id", req.auth!.userId)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Profile");

    // NOTE: presence is stamped in GET /api/v1/me, using service_role. It cannot
    // be written here: migration 0005 revoked UPDATE on `last_seen_at` from
    // `authenticated`, so a caller-scoped update silently affects zero rows.
    // This endpoint is a pure read.
    ok(res, data);
  }),
);

profileRouter.patch(
  "/",
  validate({
    body: z.object({
      fullName: z.string().trim().min(1).max(160).optional(),
      phone: z.string().trim().max(40).optional(),
      avatarUrl: z.string().url().max(500).optional(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as { fullName?: string; phone?: string; avatarUrl?: string };

    const patch: Record<string, unknown> = {};
    if (b.fullName !== undefined) patch.full_name = b.fullName;
    if (b.phone !== undefined) patch.phone = b.phone;
    if (b.avatarUrl !== undefined) patch.avatar_url = b.avatarUrl;

    if (Object.keys(patch).length === 0) throw Errors.badRequest("No changes supplied");

    const { data: before } = await req.auth!.db
      .from("profiles")
      .select("full_name, phone, avatar_url")
      .eq("id", req.auth!.userId)
      .maybeSingle();

    const { data, error } = await req.auth!.db
      .from("profiles")
      .update(patch)
      .eq("id", req.auth!.userId)
      .select(PROFILE_COLUMNS)
      .single();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "profile",
      entityId: req.auth!.userId,
      action: "update",
      diff: diffOf(before as unknown as Record<string, unknown> | null, patch),
    });

    ok(res, data);
  }),
);
