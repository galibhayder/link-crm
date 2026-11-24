import { Router } from "express";

/**
 * Archive/restore via the database functions added in migration 0012.
 *
 * A plain `UPDATE ... SET deleted_at` fails under RLS: the row stops matching
 * the SELECT policy, and PostgreSQL re-checks the returned row. These helpers
 * call the SECURITY DEFINER functions that perform the write with the caller's
 * own claims, so tenancy and role are still enforced — inside the database,
 * where they cannot be bypassed.
 */

export const ARCHIVE_ROLES = {
  clients: ["owner", "account_manager"],
  agency_partners: ["owner", "account_manager"],
  publishers: ["owner", "account_manager", "prospector"],
  prospects: ["owner", "account_manager", "prospector", "outreach_specialist"],
  campaigns: ["owner", "account_manager"],
} as const;

export type ArchivableTable = keyof typeof ARCHIVE_ROLES;

export interface ArchiveResult {
  ok: boolean;
  id?: string;
  label?: string;
  message?: string;
}

/** Archives one row; returns what it archived so the caller can audit it. */
export async function archiveRecord(
  db: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  table: ArchivableTable,
  id: string,
): Promise<ArchiveResult> {
  const { data, error } = await db.rpc("archive_record_rpc", {
    p_table: table,
    p_id: id,
    p_roles: ARCHIVE_ROLES[table],
  });

  if (error) return { ok: false, message: error.message };

  // The function is set-returning, so the driver yields an array of rows.
  const rows = (data ?? []) as Array<{ id: string; label: string | null }>;
  if (rows.length === 0) return { ok: false, message: "not_found" };

  return { ok: true, id: rows[0]!.id, label: rows[0]!.label ?? undefined };
}

export async function restoreRecord(
  db: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  table: ArchivableTable,
  id: string,
): Promise<ArchiveResult> {
  const { data, error } = await db.rpc("restore_record_rpc", {
    p_table: table,
    p_id: id,
    p_roles: ARCHIVE_ROLES[table],
  });

  if (error) return { ok: false, message: error.message };
  if (data !== true) return { ok: false, message: "not_found" };

  return { ok: true, id };
}

/** Maps a database error message to the right HTTP response. */
export function archiveErrorToResponse(message: string | undefined): "not_found" | "conflict" | "forbidden" | "internal" {
  if (!message) return "internal";
  if (message === "not_found") return "not_found";
  if (/duplicate key|unique/i.test(message)) return "conflict";
  if (/may not archive|may not restore|No organization/i.test(message)) return "forbidden";
  return "internal";
}

export function archiveRouter(): Router {
  return Router();
}
