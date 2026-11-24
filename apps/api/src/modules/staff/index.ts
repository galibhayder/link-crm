import { Router } from "express";
import { paginationSchema, roleSchema, uuidSchema } from "@crm/shared";
import { z } from "zod";
import { authorize, clearProfileCache } from "../../middleware/authenticate.js";
import { asyncRoute, created, ok, noContent, validate, parsedQuery } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { admin } from "../../integrations/supabase.js";
import { audit, auditFromRequest, diffOf, clientMeta } from "../../lib/audit.js";

export const staffRouter: Router = Router();

const idParams = z.object({ id: uuidSchema });

/**
 * Columns an administrator may read about a colleague.
 *
 * `email` is included because user management is impossible without it, but
 * nothing here exposes a password hash or a token — those live in auth.users,
 * which this API never returns.
 */
const PROFILE_COLUMNS =
  "id, full_name, email, role, supplier_id, is_active, suspended_at, suspension_reason, role_changed_at, last_seen_at, created_at";

/** Roles an owner may assign. Ownership itself is transferred, not granted. */
const ASSIGNABLE_ROLES = roleSchema.exclude(["owner"]);

// ---------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------
staffRouter.get(
  "/",
  authorize("staff:read"),
  validate({
    query: paginationSchema.extend({
      role: z.string().optional(),
      status: z.enum(["active", "suspended", "all"]).default("all"),
      q: z.string().max(200).optional(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const { page, limit, role, status, q } = parsedQuery<
      z.infer<typeof paginationSchema> & { role?: string; status: "active" | "suspended" | "all"; q?: string }
    >(req);

    let query = req.auth!.db
      .from("profiles")
      .select(PROFILE_COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (role) query = query.eq("role", role);
    if (status === "active") query = query.eq("is_active", true);
    if (status === "suspended") query = query.eq("is_active", false);
    if (q) query = query.or(`full_name.ilike.%${q}%,email.ilike.%${q}%`);

    const { data, error, count } = await query;
    if (error) throw Errors.internal(error.message);

    ok(res, data ?? [], { page, limit, total: count ?? 0 });
  }),
);

// ---------------------------------------------------------------------------
// INVITE  (create user)
//
// The role and organization come from the ADMIN's request, validated against the
// session; the invitee cannot choose either. Provisioning then reads the
// invitation, never the sign-up payload — see migration 0006.
// ---------------------------------------------------------------------------
staffRouter.post(
  "/invite",
  authorize("staff:manage"),
  validate({
    body: z.object({
      email: z.string().email(),
      fullName: z.string().min(1).max(160),
      role: ASSIGNABLE_ROLES,
      supplierId: uuidSchema.nullish(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as { email: string; fullName: string; role: string; supplierId?: string | null };
    const email = b.email.trim().toLowerCase();

    if (b.role === "publisher_user" && !b.supplierId) {
      throw Errors.badRequest("A publisher user must be linked to a supplier");
    }
    if (b.role !== "publisher_user" && b.supplierId) {
      throw Errors.badRequest("Only a publisher user may be linked to a supplier");
    }

    // Role privileges cannot be exceeded: an administrator may not invite
    // someone more privileged than themselves. Only the owner can create
    // another owner-class user, and ownership is transferred separately.
    if (req.auth!.role !== "owner" && b.role !== "client_user" && b.role !== "publisher_user") {
      // account_manager holds staff:manage in some deployments; restrict them
      // to external roles so they cannot create a peer who can then widen scope.
      throw Errors.forbidden("Only the owner may invite internal staff");
    }

    // Reject a duplicate before creating anything in auth.
    const { data: existing } = await admin()
      .from("profiles")
      .select("id")
      .eq("organization_id", req.auth!.orgId)
      .eq("email", email)
      .maybeSingle();

    if (existing) throw Errors.conflict("A user with that email already exists");

    const { data: pendingInvite } = await admin()
      .from("invitations")
      .select("id")
      .eq("organization_id", req.auth!.orgId)
      .eq("email", email)
      .eq("status", "pending")
      .maybeSingle();

    if (pendingInvite) throw Errors.conflict("That address already has a pending invitation");

    const { data: invitation, error: inviteErr } = await admin()
      .from("invitations")
      .insert({
        organization_id: req.auth!.orgId,
        email,
        full_name: b.fullName,
        role: b.role,
        supplier_id: b.supplierId ?? null,
        invited_by: req.auth!.userId,
      })
      .select()
      .single();

    if (inviteErr) {
      if (inviteErr.code === "23505") throw Errors.conflict("That address already has a pending invitation");
      throw Errors.internal(inviteErr.message);
    }

    // Sends the Supabase invite email. If that fails the invitation row remains,
    // so the administrator can resend rather than losing the record.
    const { error: authErr } = await admin().auth.admin.inviteUserByEmail(email, {
      data: { full_name: b.fullName },
      redirectTo: undefined,
    });

    const { ip, userAgent } = clientMeta(req);
    await audit({
      organizationId: req.auth!.orgId,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      entityType: "invitation",
      entityId: invitation.id,
      action: "invite",
      diff: { email, role: b.role, emailSent: !authErr },
      ip,
      userAgent,
    });

    if (authErr) {
      // The invitation exists; surface the email problem without discarding it.
      throw Errors.unprocessable(
        `Invitation recorded, but the email could not be sent: ${authErr.message}`,
        { invitationId: invitation.id, retryable: true },
      );
    }

    created(res, invitation);
  }),
);

// ---------------------------------------------------------------------------
// RESEND INVITATION
//
// GoTrue created the user at invite time, so calling inviteUserByEmail again
// returns "user already registered". The correct resend for an existing,
// unconfirmed account is a fresh confirmation email — which is what the invitee
// actually needs in order to accept.
// ---------------------------------------------------------------------------
staffRouter.post(
  "/invitations/:id/resend",
  authorize("staff:manage"),
  validate({ params: z.object({ id: uuidSchema }) }),
  asyncRoute(async (req, res) => {
    const { data: invitation, error } = await admin()
      .from("invitations")
      .select("id, email, status, expires_at")
      .eq("id", req.params.id)
      .eq("organization_id", req.auth!.orgId)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!invitation) throw Errors.notFound("Invitation");
    if (invitation.status !== "pending") {
      throw Errors.badRequest("That invitation is no longer pending");
    }

    // Try a fresh invite first (works if the auth user was cleaned up); fall back
    // to resending the confirmation for the existing account.
    const inviteAttempt = await admin().auth.admin.inviteUserByEmail(invitation.email);

    if (inviteAttempt.error) {
      const resend = await admin().auth.resend({
        type: "signup",
        email: invitation.email,
      });

      if (resend.error) {
        throw Errors.unprocessable(
          `Could not resend the invitation: ${resend.error.message}`,
          { invitationId: invitation.id },
        );
      }
    }

    await auditFromRequest(req, {
      entityType: "invitation",
      entityId: invitation.id,
      action: "invite",
      diff: { resent: true, to: invitation.email },
    });

    ok(res, { resent: true, email: invitation.email });
  }),
);

// ---------------------------------------------------------------------------
// REVOKE INVITATION
//
// Revoking must also revoke ACCESS. Because the profile is provisioned at invite
// time, a revoked invitee would otherwise still hold a working account with the
// invited role. So this deactivates the profile too, and signs the user out.
// ---------------------------------------------------------------------------
staffRouter.delete(
  "/invitations/:id",
  authorize("staff:manage"),
  validate({ params: z.object({ id: uuidSchema }) }),
  asyncRoute(async (req, res) => {
    const { data: invitation, error: readErr } = await admin()
      .from("invitations")
      .select("id, email, status")
      .eq("id", req.params.id)
      .eq("organization_id", req.auth!.orgId)
      .maybeSingle();

    if (readErr) throw Errors.internal(readErr.message);
    if (!invitation) throw Errors.notFound("Invitation");
    if (invitation.status !== "pending") {
      throw Errors.badRequest("Only a pending invitation can be revoked");
    }

    const { error } = await admin()
      .from("invitations")
      .update({ status: "revoked" })
      .eq("id", invitation.id);

    if (error) throw Errors.internal(error.message);

    // Deactivate the provisioned account so revoking the invitation actually
    // removes access rather than just relabelling a row.
    const { data: profile } = await admin()
      .from("profiles")
      .select("id")
      .eq("organization_id", req.auth!.orgId)
      .eq("email", invitation.email)
      .maybeSingle();

    if (profile) {
      await admin()
        .from("profiles")
        .update({
          is_active: false,
          suspended_at: new Date().toISOString(),
          suspended_by: req.auth!.userId,
          suspension_reason: "Invitation revoked by administrator",
        })
        .eq("id", profile.id);

      clearProfileCache(profile.id);
      await admin().auth.admin.signOut(profile.id, "global").catch(() => undefined);
    }

    await auditFromRequest(req, {
      entityType: "invitation",
      entityId: invitation.id,
      action: "delete",
      diff: { email: invitation.email, revoked: true, profileDeactivated: Boolean(profile) },
    });

    noContent(res);
  }),
);

// ---------------------------------------------------------------------------
// LIST INVITATIONS
//
// Registered BEFORE /:id below. Express matches in declaration order, so a
// parameterised route declared first would capture "invitations" and reject it
// with "Invalid uuid" — which is exactly what happened before this was moved.
// ---------------------------------------------------------------------------
staffRouter.get(
  "/invitations",
  authorize("staff:read"),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("invitations")
      .select("id, email, full_name, role, status, expires_at, created_at, invited_by")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

// ---------------------------------------------------------------------------
// READ ONE
//
// Deliberately declared AFTER every literal route below (/invitations, /invite).
// Express matches in declaration order, so declaring "/:id" first captures
// "/invitations" and fails UUID validation — the bug this ordering fixes.
// ---------------------------------------------------------------------------
staffRouter.get(
  "/:id",
  authorize("staff:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("User");

    // Associated portal grants, so the admin screen can show client scoping.
    const { data: grants } = await req.auth!.db
      .from("user_client_access")
      .select("client_id, clients(id, name, domain)")
      .eq("user_id", req.params.id);

    ok(res, { ...data, portalClients: grants ?? [] });
  }),
);


// ---------------------------------------------------------------------------
// UPDATE  (role / supplier assignment)
//
// Role changes are the most sensitive mutation in the system, so they get:
//   * an explicit last-owner guard,
//   * an audit entry with a before/after diff,
//   * cache invalidation and global sign-out so the new role takes effect
//     immediately rather than at token expiry.
// ---------------------------------------------------------------------------
staffRouter.patch(
  "/:id",
  authorize("staff:manage"),
  validate({
    params: idParams,
    body: z.object({
      fullName: z.string().min(1).max(160).optional(),
      role: ASSIGNABLE_ROLES.optional(),
      supplierId: uuidSchema.nullish(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as { fullName?: string; role?: string; supplierId?: string | null };

    if (b.role === "owner") throw Errors.forbidden("Ownership is transferred, not assigned");

    const { data: target, error: readErr } = await admin()
      .from("profiles")
      .select("id, role, is_active, full_name, supplier_id")
      .eq("id", req.params.id)
      .eq("organization_id", req.auth!.orgId)
      .maybeSingle();

    if (readErr) throw Errors.internal(readErr.message);
    if (!target) throw Errors.notFound("User");

    if (target.role === "owner") {
      throw Errors.forbidden("The owner account cannot be edited through user management");
    }

    if (req.auth!.role !== "owner" && b.role !== undefined && b.role !== target.role) {
      throw Errors.forbidden("Only the owner may change a role");
    }

    const patch: Record<string, unknown> = {};
    if (b.fullName !== undefined) patch.full_name = b.fullName;
    if (b.role !== undefined && b.role !== target.role) {
      patch.role = b.role;
      patch.role_changed_at = new Date().toISOString();
    }
    if (b.supplierId !== undefined) patch.supplier_id = b.supplierId;

    const effectiveRole = (b.role ?? target.role) as string;
    if (effectiveRole === "publisher_user" && !(b.supplierId ?? target.supplier_id)) {
      throw Errors.badRequest("A publisher user must be linked to a supplier");
    }
    if (effectiveRole !== "publisher_user" && (b.supplierId ?? target.supplier_id)) {
      patch.supplier_id = null;
    }

    if (Object.keys(patch).length === 0) throw Errors.badRequest("No changes supplied");

    const { data: updated, error } = await admin()
      .from("profiles")
      .update(patch)
      .eq("id", req.params.id)
      .eq("organization_id", req.auth!.orgId)
      .select(PROFILE_COLUMNS)
      .single();

    if (error) throw Errors.internal(error.message);

    const roleChanged = b.role !== undefined && b.role !== target.role;

    await auditFromRequest(req, {
      entityType: "profile",
      entityId: target.id,
      action: roleChanged ? "role_change" : "update",
      diff: diffOf(target as unknown as Record<string, unknown>, patch),
    });

    if (roleChanged) {
      // New role must not wait for token expiry.
      clearProfileCache(target.id);
      await admin().auth.admin.signOut(target.id, "global").catch(() => undefined);
    }

    ok(res, updated);
  }),
);

// ---------------------------------------------------------------------------
// ACTIVATE / SUSPEND
//
// Suspension is a soft, reversible state change rather than a delete: the user's
// history, placements and audit trail must survive. It revokes their sessions so
// an active tab cannot continue.
// ---------------------------------------------------------------------------
staffRouter.post(
  "/:id/suspend",
  authorize("staff:manage"),
  validate({
    params: idParams,
    body: z.object({ reason: z.string().trim().min(3).max(500) }),
  }),
  asyncRoute(async (req, res) => {
    const reason = (req.body as { reason: string }).reason;

    if (req.params.id === req.auth!.userId) {
      throw Errors.badRequest("You cannot suspend your own account");
    }

    const { data: target, error: readErr } = await admin()
      .from("profiles")
      .select("id, role, is_active")
      .eq("id", req.params.id)
      .eq("organization_id", req.auth!.orgId)
      .maybeSingle();

    if (readErr) throw Errors.internal(readErr.message);
    if (!target) throw Errors.notFound("User");
    if (target.role === "owner") throw Errors.forbidden("The owner account cannot be suspended");
    if (!target.is_active) throw Errors.conflict("That account is already suspended");

    const { data, error } = await admin()
      .from("profiles")
      .update({
        is_active: false,
        suspended_at: new Date().toISOString(),
        suspended_by: req.auth!.userId,
        suspension_reason: reason,
      })
      .eq("id", target.id)
      .select(PROFILE_COLUMNS)
      .single();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "profile",
      entityId: target.id,
      action: "suspend",
      diff: { reason, previousActive: target.is_active },
    });

    clearProfileCache(target.id);
    await admin().auth.admin.signOut(target.id, "global").catch(() => undefined);

    ok(res, data);
  }),
);

staffRouter.post(
  "/:id/activate",
  authorize("staff:manage"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data: target, error: readErr } = await admin()
      .from("profiles")
      .select("id, is_active")
      .eq("id", req.params.id)
      .eq("organization_id", req.auth!.orgId)
      .maybeSingle();

    if (readErr) throw Errors.internal(readErr.message);
    if (!target) throw Errors.notFound("User");
    if (target.is_active) throw Errors.conflict("That account is already active");

    const { data, error } = await admin()
      .from("profiles")
      .update({ is_active: true, suspended_at: null, suspended_by: null, suspension_reason: null })
      .eq("id", target.id)
      .select(PROFILE_COLUMNS)
      .single();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "profile",
      entityId: target.id,
      action: "activate",
      diff: { reactivated: true },
    });

    clearProfileCache(target.id);
    ok(res, data);
  }),
);

// ---------------------------------------------------------------------------
// PORTAL CLIENT ACCESS  (which clients a client_user may see)
// ---------------------------------------------------------------------------
staffRouter.get(
  "/:id/portal-clients",
  authorize("portal_access:manage"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("user_client_access")
      .select("client_id, clients(id, name, domain)")
      .eq("user_id", req.params.id);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

staffRouter.post(
  "/:id/portal-clients",
  authorize("portal_access:manage"),
  validate({ params: idParams, body: z.object({ clientIds: z.array(uuidSchema).max(200) }) }),
  asyncRoute(async (req, res) => {
    const { clientIds } = req.body as { clientIds: string[] };
    const userId = req.params.id!;

    const { data: target } = await admin()
      .from("profiles")
      .select("id, role")
      .eq("id", userId)
      .eq("organization_id", req.auth!.orgId)
      .maybeSingle();

    if (!target) throw Errors.notFound("User");
    if (target.role !== "client_user") {
      throw Errors.badRequest("Portal client access only applies to client users");
    }

    // Replace rather than append, so the request is the full desired state and
    // removing access is possible.
    await admin().from("user_client_access").delete().eq("user_id", userId);

    if (clientIds.length > 0) {
      const { error } = await admin()
        .from("user_client_access")
        .insert(clientIds.map((clientId) => ({ user_id: userId, client_id: clientId, organization_id: req.auth!.orgId })));

      if (error) throw Errors.internal(error.message);
    }

    await auditFromRequest(req, {
      entityType: "profile",
      entityId: userId,
      action: "update",
      diff: { portalClients: clientIds },
    });

    ok(res, { clientIds });
  }),
);
