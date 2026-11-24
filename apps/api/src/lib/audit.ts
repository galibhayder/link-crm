import type { Request } from "express";
import { admin } from "../integrations/supabase.js";
import { logger } from "./logger.js";

/**
 * AUDIT LOGGING.
 *
 * Written through service_role on purpose: `activity_log` has no INSERT policy
 * for any end-user role, so the only way a row can appear is through this
 * module. That means an audit entry cannot be forged, edited or suppressed by a
 * caller — and a table nobody writes to is worse than no table at all, which is
 * what Phase 1 shipped.
 *
 * Failure to write an audit row must never fail the request it describes, but it
 * must be loud in the logs: a silent gap in the trail is the thing an auditor
 * will ask about.
 */

export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "status_change"
  | "login"
  | "logout"
  | "export"
  | "invite"
  | "impersonate"
  | "password_reset"
  | "role_change"
  | "activate"
  | "suspend"
  // Phase 6 — invoice publishing and share-link lifecycle.
  //
  // This union must stay in step with the `activity_log_action_check` CHECK in
  // migration 0028. When they drift, the insert is rejected, `audit()` logs it,
  // and the operation proceeds without a trail — which is exactly the silent gap
  // Phase 2 shipped once. Migration 0028 self-tests every value for that reason.
  | "publish"
  | "unpublish"
  | "share_link_created"
  | "share_link_revoked"
  | "view"
  | "download";

export interface AuditEntry {
  organizationId: string;
  actorId: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  entityType: string;
  entityId?: string | null;
  action: AuditAction;
  /** Keys whose values changed, plus before/after where safe to store. */
  diff?: Record<string, unknown>;
  /** Overrides taken from the request when present. */
  ip?: string | null;
  userAgent?: string | null;
}

/** Values that must never be written to an audit row, even in a diff. */
const REDACTED_KEYS = new Set([
  "password",
  "token",
  "access_token",
  "refresh_token",
  "encrypted_password",
  "secret",
  "api_key",
]);

/**
 * True for a key that carries a credential, in any casing or naming style.
 *
 * Substring matching, not equality: a column called `passwordResetToken` or
 * `new_secret` is just as sensitive as `password`, and an equality check would
 * let it through.
 */
function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return (REDACTED_KEYS.has(k) || /password|secret|token|api_?key/.test(k)) && !/token_count|tokenise|tokenize/i.test(k);
}

/**
 * Redacts sensitive values from a diff, recursively.
 *
 * The original implementation inspected only top-level keys, so a nested
 * before/after object such as `{ password: { from, to } }` stored the secret in
 * plaintext. The audit log is the one table a reader would most like to mine, so
 * this walks the whole structure.
 */
export function redact(diff: Record<string, unknown> | undefined, depth = 0): Record<string, unknown> {
  if (!diff) return {};
  if (depth > 6) return { _redacted: "[depth limit]" };

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(diff)) {
    if (isSensitiveKey(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redact(value as Record<string, unknown>, depth + 1);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item && typeof item === "object" ? redact(item as Record<string, unknown>, depth + 1) : item,
      );
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function clientMeta(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  };
}

/**
 * Records an audit entry. Awaited by callers so a mutation is not reported as
 * successful before its trail exists.
 *
 * IMPORTANT: a failed insert is logged at error level with the full entry, but
 * does not throw. That is a deliberate trade-off — an audit outage must not take
 * down the CRM — but it is exactly how a silent gap appears, so the failure has
 * to be loud. Migration 0007 widened the action CHECK after this module
 * introduced actions the constraint rejected, and the gap went unnoticed because
 * the only signal was a log line nobody was reading.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  const meta = entry.ip !== undefined ? { ip: entry.ip, userAgent: entry.userAgent ?? null } : {};

  try {
    const { error } = await admin().from("activity_log").insert({
      organization_id: entry.organizationId,
      actor_id: entry.actorId,
      actor_name_snapshot: entry.actorName ?? null,
      actor_role: entry.actorRole ?? null,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      action: entry.action,
      diff: redact(entry.diff),
      ip: meta.ip ?? null,
      user_agent: meta.userAgent ?? null,
    });

    if (error) {
      // Includes the rejected payload so the gap is reconstructable from logs.
      logger.error(
        { err: { code: error.code, message: error.message }, entry, severity: "audit_gap" },
        "AUDIT WRITE REJECTED — the operation proceeded without a trail",
      );
    }
  } catch (err) {
    logger.error({ err, entry, severity: "audit_gap" }, "AUDIT WRITE THREW");
  }
}

/** Convenience wrapper that pulls actor identity and request metadata together. */
export function auditFromRequest(
  req: Request,
  entry: Omit<AuditEntry, "organizationId" | "actorId" | "actorRole" | "ip" | "userAgent"> & {
    actorName?: string | null;
  },
): Promise<void> {
  const auth = req.auth;
  const meta = clientMeta(req);

  return audit({
    ...entry,
    organizationId: auth?.orgId ?? "",
    actorId: auth?.userId ?? null,
    actorRole: auth?.role ?? null,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}

/**
 * Builds a before/after diff containing only changed fields.
 *
 * Accepts `unknown` because Supabase results are untyped (see the note in
 * integrations/supabase.ts); narrowing here keeps the call sites readable rather
 * than forcing a cast at every diff.
 */
export function diffOf(before: unknown, after: unknown): Record<string, unknown> {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return {};
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;

  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(a)) {
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
      changes[key] = { from: b[key] ?? null, to: a[key] ?? null };
    }
  }
  return changes;
}
