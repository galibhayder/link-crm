import { Router } from "express";
import { z } from "zod";
import { uuidSchema } from "@crm/shared";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, noContent, ok, parsedQuery, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { optionalBooleanQuery } from "../../lib/query.js";

/**
 * NOTIFICATIONS.
 *
 * In-app delivery for things that need a person's attention: a placement moved to
 * their desk, a follow-up falling due, and — new in this phase — an anchor-text
 * alert firing.
 *
 * WHY THIS IS ENTIRELY `req.auth.db`
 *
 * Migration 0003 already defines exactly the right policies:
 *
 *   notifications_own        SELECT where organization_id = current_org()
 *                                   and user_id = auth.uid()
 *   notifications_update_own UPDATE with the same predicate plus a WITH CHECK
 *
 * So a user can read and mark-read their own rows and nothing else, and the
 * WITH CHECK forbids reassigning `user_id` — a mark-read cannot be turned into a
 * hand-off. Using the caller-scoped client rather than service_role means a bug in
 * this file cannot leak another user's notifications; the database refuses.
 *
 * There is deliberately NO create endpoint. Notifications are written by the system
 * (jobs, placement transitions) over service_role, through
 * `app_private.emit_notification`. Letting a user mint notifications would make the
 * bell a spam channel.
 */
export const notificationsRouter: Router = Router();

const idParams = z.object({ id: uuidSchema });

const COLUMNS = "id, type, payload, read_at, created_at";

// ---------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------
notificationsRouter.get(
  "/",
  validate({
    query: z.object({
      unread: optionalBooleanQuery,
      limit: z.coerce.number().int().min(1).max(100).default(30),
      type: z.string().max(60).optional(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<{ unread?: boolean; limit: number; type?: string }>(req);

    let dbQuery = req.auth!.db
      .from("notifications")
      .select(COLUMNS)
      .order("created_at", { ascending: false })
      .limit(query.limit);

    if (query.unread) dbQuery = dbQuery.is("read_at", null);
    if (query.type) dbQuery = dbQuery.eq("type", query.type);

    const { data, error } = await dbQuery;
    if (error) throw Errors.internal(error.message);

    // The unread count is returned alongside the page: the bell needs it regardless
    // of how many rows the panel shows, and computing it client-side from a limited
    // page would undercount.
    const { count, error: countErr } = await req.auth!.db
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null);

    if (countErr) throw Errors.internal(countErr.message);

    ok(res, { notifications: data ?? [], unreadCount: count ?? 0 });
  }),
);

// ---------------------------------------------------------------------------
// MARK ONE READ
//
// Idempotent: marking an already-read notification returns the row unchanged rather
// than erroring, because a double-click is not a failure.
// ---------------------------------------------------------------------------
notificationsRouter.patch(
  "/:id([0-9a-fA-F-]{36})/read",
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", req.params.id)
      // A row the caller does not own matches zero rows under RLS — reported as
      // not-found so the response does not confirm that it exists.
      .select(COLUMNS)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Notification");

    noContent(res);
  }),
);

// ---------------------------------------------------------------------------
// MARK ALL READ
// ---------------------------------------------------------------------------
notificationsRouter.post(
  "/read-all",
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .is("read_at", null)
      .select("id");

    if (error) throw Errors.internal(error.message);
    ok(res, { marked: data?.length ?? 0 });
  }),
);

/**
 * A numeric readiness check for the UI: the bell polls this cheaply rather than
 * fetching thirty rows every minute.
 */
notificationsRouter.get(
  "/unread-count",
  asyncRoute(async (req, res) => {
    const { count, error } = await req.auth!.db
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null);

    if (error) throw Errors.internal(error.message);
    ok(res, { unreadCount: count ?? 0 });
  }),
);

// ---------------------------------------------------------------------------
// PREFERENCES
//
// Per-user muting. RLS on `notification_preferences` restricts every operation to
// `user_id = auth.uid()`, so even an owner cannot read or edit someone else's row
// — a notification setting your manager can change is not a user setting.
//
// A missing row means "all types enabled": the GET returns defaults rather than
// 404, so the UI never has to special-case a first visit.
// ---------------------------------------------------------------------------
const KNOWN_NOTIFICATION_TYPES = [
  "anchor_alert",
  "follow_up_due",
  "placement_stage_changed",
  // Must match `notifications_type_check` (migration 0033) and the bell's label
  // map. Three places, and a type missing from any of them renders as a
  // notification nobody can interpret.
  "link_needs_review",
] as const;

notificationsRouter.get(
  "/preferences",
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("notification_preferences")
      .select("muted_types, email_digest")
      .eq("user_id", req.auth!.userId)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);

    const row = (data ?? {}) as { muted_types?: string[]; email_digest?: boolean };

    ok(res, {
      mutedTypes: row.muted_types ?? [],
      emailDigest: row.email_digest ?? false,
      // The list the UI offers, so it cannot invent a type that is never emitted.
      availableTypes: KNOWN_NOTIFICATION_TYPES,
    });
  }),
);

notificationsRouter.put(
  "/preferences",
  validate({
    body: z.object({
      mutedTypes: z.array(z.enum(KNOWN_NOTIFICATION_TYPES)).max(20),
      emailDigest: z.boolean().default(false),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as { mutedTypes: string[]; emailDigest: boolean };

    // Upsert on the user's own row. RLS's WITH CHECK enforces that `user_id` is
    // the caller, so a forged body cannot write another person's preferences.
    const { data, error } = await req.auth!.db
      .from("notification_preferences")
      .upsert(
        {
          user_id: req.auth!.userId,
          organization_id: req.auth!.orgId,
          muted_types: b.mutedTypes,
          email_digest: b.emailDigest,
        },
        { onConflict: "user_id" },
      )
      .select("muted_types, email_digest")
      .single();

    if (error) throw Errors.internal(error.message);
    ok(res, data);
  }),
);
