import type { SupabaseClient } from "@supabase/supabase-js";
import { Errors } from "./errors.js";
import {
  computeChanges,
  type ImportColumn,
  type ImportSummary,
  normalizeHeader,
  pick,
  rowToRecord,
  summarize,
  type RowVerdict,
  validateRow,
} from "./csv.js";

/**
 * Import planning.
 *
 * The distinction this module exists to enforce:
 *
 *   PREVIEW decides, per row, whether it is insertable, a duplicate, an update
 *   or invalid — by querying live data. COMMIT then applies exactly the rows the
 *   user was shown. The two must not be able to disagree, so the verdict object
 *   is what gets stored and what gets applied.
 *
 * Duplicate detection has two sources that a naive implementation misses:
 *   * rows already in the database, and
 *   * two rows within the SAME file that collide with each other.
 */

/** A column definition plus how to read and validate it. */
export interface EntityImportSpec<T> {
  /** Table this entity writes to. */
  table: string;
  /** Columns the CSV may supply. */
  columns: ImportColumn[];
  /**
   * Column(s) used to select existing rows for duplicate detection.
   *
   * This is a LIST because several tables are unique on a COMPOSITE key:
   * prospects are unique per (campaign_id, domain), campaigns per
   * (client_id, name). Comparing only the first column would either wrongly
   * reject a legitimate row or fail to detect a real duplicate.
   */
  keyColumns: string[];
  /**
   * Builds the dedupe key from a PARSED row. Must produce the same shape as
   * `keyOfExisting` produces from a database row, or nothing will ever match.
   */
  keyOf: (value: T) => string;
  /** Builds the dedupe key from an existing DATABASE row. */
  keyOfExisting: (row: Record<string, unknown>) => string;
  /** Builds a database row from a validated value. */
  toRow: (value: T, orgId: string) => Record<string, unknown>;
  /** Maps a database row into the same shape as `toRow`, for diffing. */
  fromRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  /** Zod schema for one parsed record. */
  schema: { safeParse: (v: unknown) => any };
}

/**
 * Normalises a dedupe key so both sides compare identically.
 *
 * Lowercased and trimmed because domains and names arrive with inconsistent
 * casing from spreadsheets, and a case-sensitive comparison would report a
 * duplicate as new.
 */
export function normalizeKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Joins key parts with a separator that cannot appear in a domain or name. */
export function compositeKey(...parts: unknown[]): string {
  return parts.map(normalizeKey).join("\u0000");
}

export interface PrepareResult {
  verdicts: RowVerdict[];
  summary: ImportSummary;
  headers: string[];
}

/**
 * Reads one CSV row into a candidate object using the column definitions.
 * Absent values are omitted rather than set to "", so schema defaults apply.
 */
export function readRow(row: Record<string, string>, columns: ImportColumn[]): Record<string, string> {
  const candidate: Record<string, string> = {};
  for (const column of columns) {
    const value = pick(row, column);
    if (value !== undefined) candidate[column.field] = value;
  }
  return candidate;
}

/** Parses raw CSV text into header-keyed records. */
export function recordsFromCsv(
  headers: string[],
  rows: string[][],
  columns: ImportColumn[],
): { records: Array<Record<string, string>>; missingRequired: string[] } {
  // Normalise headers once so `pick` can match aliases.
  const normalisedHeaders = headers.map(normalizeHeader);
  const records = rows.map((row) => rowToRecord(normalisedHeaders, row));

  const missingRequired = columns
    .filter((c) => c.required)
    .filter((c) => !normalisedHeaders.some((h) => c.aliases.includes(h)))
    .map((c) => c.field);

  return { records, missingRequired };
}

/**
 * Normalises already-object rows (the shape the API receives as JSON) into
 * canonical field names.
 *
 * This exists because `Object.keys(rows[0])` + `Object.values(row)` silently
 * assumes both objects enumerate their keys in the same order. They do not have
 * to, and when they differ the values land in the wrong columns — a bug that
 * looks like corrupt data rather than a coding error.
 */
export function recordsFromObjects(
  rows: Array<Record<string, string>>,
  columns: ImportColumn[],
): { records: Array<Record<string, string>>; missingRequired: string[] } {
  const normalisedHeaderSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) normalisedHeaderSet.add(normalizeHeader(key));
  }

  const records = rows.map((row) => {
    const normalised: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      normalised[normalizeHeader(key)] = typeof value === "string" ? value.trim() : String(value ?? "");
    }
    return normalised;
  });

  const missingRequired = columns
    .filter((c) => c.required)
    .filter((c) => !c.aliases.some((alias) => normalisedHeaderSet.has(alias)))
    .map((c) => c.field);

  return { records, missingRequired };
}

/**
 * Plans an import: validates every row, resolves duplicates against the database
 * and against earlier rows in the same file, and produces one verdict per row.
 */
export async function prepareImport<T>(opts: {
  spec: EntityImportSpec<T>;
  db: SupabaseClient;
  orgId: string;
  /** Already-parsed records, keyed by canonical field name. */
  records: Array<Record<string, string>>;
  duplicateStrategy: "skip" | "update" | "error";
  /** Extra fields applied to every row, e.g. campaignId for prospects. */
  defaults?: Record<string, string>;
}): Promise<PrepareResult> {
  const { spec, db, orgId, records, duplicateStrategy, defaults = {} } = opts;

  // Load existing keys in one query rather than per row. `keyColumns` may be a
  // composite (prospects: campaign_id + domain), so every part is selected.
  const keySelect = ["id", ...spec.keyColumns].join(", ");
  let existingQuery = db
    .from(spec.table)
    .select(keySelect)
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .limit(20_000);

  // Scope the lookup to the parent when the key includes it. Without this, a
  // prospect import into campaign B would load campaign A's rows and treat a
  // legitimately new prospect as a duplicate.
  const scopedParent =
    spec.keyColumns.includes("campaign_id") && defaults.campaignId
      ? { column: "campaign_id", value: defaults.campaignId }
      : spec.keyColumns.includes("client_id") && defaults.clientId
        ? { column: "client_id", value: defaults.clientId }
        : null;

  if (scopedParent) {
    existingQuery = existingQuery.eq(scopedParent.column, scopedParent.value);
  }

  const { data: existingRows, error } = await existingQuery;

  if (error) throw Errors.internal(error.message);

  const existingByKey = new Map<string, string>();
  for (const row of (existingRows ?? []) as unknown as Array<Record<string, unknown>>) {
    // Use the SAME key builder as the parsed side. Deriving the key from the
    // raw column instead is how the campaign importer shipped broken: it built
    // `clientId::name` for new rows but compared against a bare `name`.
    const key = normalizeKey(spec.keyOfExisting(row));
    if (key) existingByKey.set(key, String(row.id));
  }

  // When updating, the current values are needed to compute a diff.
  const existingFull = new Map<string, Record<string, unknown>>();
  if (duplicateStrategy === "update" && existingByKey.size > 0) {
    const ids = [...existingByKey.values()];
    // Chunked to keep the URL length sane on a large import.
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data } = await db.from(spec.table).select("*").in("id", chunk);
      for (const row of data ?? []) {
        existingFull.set(String((row as Record<string, unknown>).id), row as Record<string, unknown>);
      }
    }
  }

  const seenInFile = new Map<string, number>();
  const verdicts: RowVerdict[] = [];

  records.forEach((record, rowIndex) => {
    const merged = { ...defaults, ...record };

    const validation = validateRow<T>(spec.schema as never, merged);
    if (!validation.ok) {
      verdicts.push({
        rowIndex,
        status: "error",
        message: "Validation failed",
        errors: validation.errors,
      });
      return;
    }

    const value = validation.value as T;
    const key = normalizeKey(spec.keyOf(value));

    // A collision with an earlier row in the same file. This is the case a
    // database-only duplicate check silently allows through, creating two rows
    // that violate the unique index and abort the whole commit.
    const earlierRow = seenInFile.get(key);
    if (earlierRow !== undefined) {
      verdicts.push({
        rowIndex,
        status: "error",
        message: `Duplicate of row ${earlierRow + 1} in this file`,
        errors: { [spec.keyColumns[0] ?? "record"]: "Repeated within the file" },
      });
      return;
    }
    seenInFile.set(key, rowIndex);

    const existingId = existingByKey.get(key);

    if (!existingId) {
      verdicts.push({ rowIndex, status: "ok", normalized: spec.toRow(value, orgId) });
      return;
    }

    if (duplicateStrategy === "error") {
      verdicts.push({
        rowIndex,
        status: "duplicate",
        message: "Already exists",
        existingId,
      });
      return;
    }

    if (duplicateStrategy === "skip") {
      verdicts.push({
        rowIndex,
        status: "duplicate",
        message: "Already exists — will be skipped",
        existingId,
      });
      return;
    }

    // strategy === "update"
    const incoming = spec.toRow(value, orgId);
    const current = existingFull.get(existingId);
    const currentShape = current && spec.fromRow ? spec.fromRow(current) : (current ?? {});

    verdicts.push({
      rowIndex,
      status: "update",
      message: "Already exists — will be updated",
      existingId,
      normalized: incoming,
      changes: computeChanges(currentShape as Record<string, unknown>, incoming),
    });
  });

  return { verdicts, summary: summarize(verdicts), headers: spec.columns.map((c) => c.field) };
}

/**
 * Applies a previously previewed verdict set.
 *
 * `includeRowIndexes` lets the user deselect specific rows. When omitted, every
 * row that is not an error is applied. Rows the preview marked as errors are
 * never applied, even if explicitly selected — applying a row the user was told
 * was invalid would be worse than ignoring the request.
 */
export async function commitImport(opts: {
  db: SupabaseClient;
  table: string;
  verdicts: RowVerdict[];
  includeRowIndexes?: number[];
}): Promise<{ inserted: number; updated: number; skipped: number; failed: Array<{ rowIndex: number; message: string }> }> {
  const { db, table, verdicts, includeRowIndexes } = opts;
  const allow = includeRowIndexes ? new Set(includeRowIndexes) : null;

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const failed: Array<{ rowIndex: number; message: string }> = [];

  for (const verdict of verdicts) {
    if (allow && !allow.has(verdict.rowIndex)) {
      skipped++;
      continue;
    }
    if (verdict.status === "error" || verdict.status === "duplicate") {
      skipped++;
      continue;
    }

    if (verdict.status === "update" && verdict.existingId && verdict.normalized) {
      // Only the changed columns, so an update cannot blank out a field the CSV
      // did not mention.
      const patch: Record<string, unknown> = {};
      for (const key of Object.keys(verdict.changes ?? {})) {
        patch[key] = verdict.normalized[key];
      }
      if (Object.keys(patch).length === 0) {
        skipped++;
        continue;
      }
      const { error } = await db.from(table).update(patch).eq("id", verdict.existingId);
      if (error) failed.push({ rowIndex: verdict.rowIndex, message: error.message });
      else updated++;
      continue;
    }

    if (verdict.status === "ok" && verdict.normalized) {
      const { error } = await db.from(table).insert(verdict.normalized);
      if (error) failed.push({ rowIndex: verdict.rowIndex, message: error.message });
      else inserted++;
    }
  }

  return { inserted, updated, skipped, failed };
}
