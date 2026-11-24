import type { Request } from "express";
import { z } from "zod";
import { Errors } from "./errors.js";

/**
 * Shared list/pagination/sort machinery.
 *
 * Five modules need identical behaviour for search, filtering, sorting and
 * pagination. Repeating that logic five times is how the modules drift — one
 * gets a sort allowlist, another does not, and the third interpolates `sort`
 * straight into SQL.
 *
 * Every helper here is deliberately defensive about `sort`: it is compared
 * against a per-module allowlist and NEVER passed through. An unlisted value
 * falls back to the module's default rather than erroring, so a stale bookmark
 * still lands on a usable page.
 */

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  pageCount: number;
  sort: string;
  order: "asc" | "desc";
}

export function resolveSort(requested: string | undefined, allowlist: readonly string[], fallback: string): string {
  if (!requested) return fallback;
  const normalised = requested.trim().toLowerCase();
  const match = allowlist.find((col) => col.toLowerCase() === normalised);
  return match ?? fallback;
}

export function resolveOrder(requested: "asc" | "desc" | undefined, sort: string, firstSortDesc: string[] = []): "asc" | "desc" {
  if (requested) return requested;
  // Dates and numeric metric columns read better newest/highest first.
  return firstSortDesc.includes(sort) ? "desc" : "asc";
}

export function rangeFor(page: number, limit: number): { from: number; to: number } {
  const from = (page - 1) * limit;
  return { from, to: from + limit - 1 };
}

export function pageMeta(page: number, limit: number, total: number, sort: string, order: "asc" | "desc"): PageMeta {
  return {
    page,
    limit,
    total,
    pageCount: limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 0,
    sort,
    order,
  };
}

/**
 * Makes a search term safe to embed in a PostgREST `.or()` filter expression.
 *
 * PostgREST parses that string as a logic tree, where `,` separates conditions
 * and `()` group them. Two approaches DO NOT work:
 *
 *   * backslash-escaping them — the parser rejects `\,` outright, producing
 *     "failed to parse logic tree" and a 500;
 *   * quoting them — there is no quoting syntax inside a filter value.
 *
 * So the structural characters are REMOVED. A user typing `a,b(c)` is searching
 * for a literal string that almost certainly does not exist; matching on `abc`
 * is a useful approximation, whereas a 500 is not. `%` and `_` are also stripped
 * because they are LIKE wildcards, and a user should not be able to force a
 * full-table scan by typing `%`.
 */
export function escapeFilterValue(value: string): string {
  return value.replace(/[,().*%_\\'"]/g, "").trim();
}

/**
 * Builds a PostgREST `.or()` clause for a case-insensitive search across several
 * columns, or returns null when there is nothing to search for.
 *
 * Returns null when the term strips down to nothing (e.g. the user typed only
 * `%` or `,,`). Building `name.ilike.%%` at that point would match every row,
 * turning a meaningless search into a full table scan.
 */
export function searchClause(term: string | undefined, columns: string[]): string | null {
  const raw = term?.trim();
  if (!raw) return null;

  const safe = escapeFilterValue(raw);
  if (safe.length === 0) return null;

  return columns.map((col) => `${col}.ilike.%${safe}%`).join(",");
}

/** Applies a list of `{column, op, value}` filters, skipping empty values. */
export interface FilterSpec {
  column: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "is" | "in" | "contains";
  value: unknown;
}

export function buildFilters(raw: Array<FilterSpec | null>): FilterSpec[] {
  return raw.filter((f): f is FilterSpec => {
    if (!f) return false;
    if (f.value === undefined || f.value === null || f.value === "") return false;
    if (Array.isArray(f.value) && f.value.length === 0) return false;
    return true;
  });
}

/**
 * Maps a camelCase request body onto a snake_case column patch, ignoring keys
 * that were not supplied.
 *
 * This exists so "PATCH only what was sent" is one implementation rather than
 * five slightly different ones — the usual source of an accidental null-out.
 */
export function toColumnPatch(
  body: Record<string, unknown>,
  mapping: Record<string, string>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(mapping)) {
    if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined) {
      patch[column] = body[field];
    }
  }
  return patch;
}

/** Trimmed, uppercased country code, or null. */
export function normalizeCountry(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

/** A stable, sortable ISO date (YYYY-MM-DD) or null. */
export function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Ensures a referenced record belongs to the caller's organisation before it is
 * used as a foreign key.
 *
 * RLS protects reads, but an INSERT with a foreign key pointing at another
 * tenant's row would either fail opaquely or, worse, succeed and create a
 * cross-tenant link. This turns that into a clear 400.
 */
export async function assertSameOrg(
  db: { from: (table: string) => any },
  table: string,
  id: string | null | undefined,
  orgId: string,
  label: string,
): Promise<void> {
  if (!id) return;
  const { data, error } = await db.from(table).select("id").eq("id", id).eq("organization_id", orgId).maybeSingle();
  if (error) throw Errors.internal(error.message);
  if (!data) throw Errors.badRequest(`${label} not found in your organisation`);
}

export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/** Reads the caller's organisation from an authenticated request. */
export function orgOf(req: Request): string {
  const orgId = req.auth?.orgId;
  if (!orgId) throw Errors.unauthorized();
  return orgId;
}
