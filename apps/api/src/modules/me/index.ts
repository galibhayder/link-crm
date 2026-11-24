import { Router } from "express";
import { asyncRoute, ok } from "../../lib/http.js";
import { admin } from "../../integrations/supabase.js";
import { logger } from "../../lib/logger.js";

export const meRouter: Router = Router();

/**
 * The identity endpoint the frontend calls on every session resolve.
 *
 * It doubles as the presence heartbeat. This is written with service_role rather
 * than the caller's client on purpose: migration 0005 revoked UPDATE on every
 * privileged profile column from `authenticated` — including `last_seen_at` —
 * so a caller-scoped update silently affects zero rows. Presence is server
 * bookkeeping, not a user-editable field.
 *
 * The write is fire-and-forget: presence is not worth failing an authentication
 * check over, and it must not add latency to the hot path.
 */
meRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const userId = req.auth!.userId;

    void admin()
      .from("profiles")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", userId)
      .then(({ error }) => {
        if (error) logger.debug({ err: error }, "last_seen stamp skipped");
      });

    // Branding travels with identity.
    //
    // The logo and business name are needed on the very first screen after sign-in
    // (sidebar, login, invoice header), and `/me` is already the one call every
    // session makes. Fetching them separately would add a second round trip to the
    // critical path purely for a logo.
    //
    // Read through the caller's RLS client, so an organisation's branding can only
    // be read by its own members.
    const { data: org } = await req.auth!.db
      .from("organizations")
      .select("name, logo_url, brand_color")
      .eq("id", req.auth!.orgId)
      .maybeSingle();

    const branding = (org ?? {}) as { name?: string; logo_url?: string | null; brand_color?: string | null };

    ok(res, {
      userId,
      email: req.auth!.email,
      role: req.auth!.role,
      organizationId: req.auth!.orgId,
      supplierId: req.auth!.supplierId,
      surface: req.auth!.surface,
      organizationName: branding.name ?? null,
      logoUrl: branding.logo_url ?? null,
      brandColor: branding.brand_color ?? null,
    });
  }),
);
