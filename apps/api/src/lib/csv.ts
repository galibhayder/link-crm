import { z } from "zod";
import { zodFieldErrors } from "./crud.js";

/**
 * CSV import/export engine.
 *
 * Design decisions that matter:
 *
 * 1. PARSING is done here, not trusted from the client. A browser CSV library
 *    can produce different results from the server's, and the server is what
 *    writes the rows.
 *
 * 2. Every row is validated INDEPENDENTLY. One bad row must not reject a 2,000
 *    row file — the user needs to see which rows failed and why.
 *
 * 3. Duplicates are resolved against LIVE data at preview time, not against the
 *    file. Two rows in the same file can also duplicate each other, which a
 *    naive check misses entirely.
 *
 * 4. The preview result is stored and the commit applies exactly what was shown.
 *    If preview and commit could disagree, the preview would be a lie.
 */

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * RFC 4180-style CSV parser.
 *
 * Handles quoted fields containing commas, newlines and escaped quotes ("")
 * — the cases a naive `split(",")` gets wrong and which real exports contain
 * constantly because notes fields hold commas.
 */
export function parseCsv(input: string): { headers: string[]; rows: string[][] } {
  const text = input.replace(/^\uFEFF/, ""); // strip BOM from Excel exports
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // Handled by the following \n; a lone \r is treated as a newline too.
      if (text[i + 1] !== "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
    } else {
      field += ch;
    }
  }

  // Trailing field/row, if the file did not end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = (nonEmpty[0] ?? []).map((h) => h.trim());
  return { headers, rows: nonEmpty.slice(1) };
}

/** Maps a positional row onto the header names, lowercased and trimmed. */
export function rowToRecord(headers: string[], row: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((header, index) => {
    if (!header) return;
    const value = row[index] ?? "";
    record[normalizeHeader(header)] = value.trim();
  });
  return record;
}

/**
 * Header normalisation: "Domain Rating", "domain_rating" and "DomainRating" all
 * become "domainrating". Real spreadsheets use every one of those spellings, and
 * requiring an exact match would make the import feel broken.
 */
export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[\s_\-()]/g, "").replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

export interface ImportColumn {
  /** Canonical field name on the parsed record. */
  field: string;
  /** Every accepted header spelling, already normalised. */
  aliases: string[];
  required?: boolean;
  example?: string;
  description?: string;
}

/**
 * Finds the first alias present in the row and returns its value.
 *
 * Used instead of direct key access so "DR", "Domain Rating" and "ahrefs_dr"
 * all populate `dr`.
 */
export function pick(row: Record<string, string>, column: ImportColumn): string | undefined {
  for (const alias of column.aliases) {
    const value = row[alias];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type RowStatus = "ok" | "duplicate" | "update" | "error";

export interface RowVerdict {
  rowIndex: number;
  status: RowStatus;
  message?: string;
  errors?: Record<string, string>;
  normalized?: Record<string, unknown>;
  existingId?: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
}

export interface ImportSummary {
  total: number;
  ok: number;
  duplicates: number;
  updates: number;
  errors: number;
}

export function summarize(verdicts: RowVerdict[]): ImportSummary {
  return verdicts.reduce<ImportSummary>(
    (acc, v) => {
      acc.total++;
      if (v.status === "ok") acc.ok++;
      else if (v.status === "duplicate") acc.duplicates++;
      else if (v.status === "update") acc.updates++;
      else acc.errors++;
      return acc;
    },
    { total: 0, ok: 0, duplicates: 0, updates: 0, errors: 0 },
  );
}

/**
 * Validates one row against a schema, returning either the parsed value or the
 * field-level errors that prevented it.
 */
export function validateRow<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  candidate: unknown,
): { ok: true; value: T } | { ok: false; errors: Record<string, string> } {
  const parsed = schema.safeParse(candidate);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: zodFieldErrors(parsed.error) };
}

/** Field-level differences between an existing row and the incoming values. */
export function computeChanges(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, to] of Object.entries(incoming)) {
    const from = existing[key];
    const same =
      (from === null || from === undefined) && (to === null || to === undefined)
        ? true
        : JSON.stringify(from) === JSON.stringify(to);
    if (!same) changes[key] = { from: from ?? null, to: to ?? null };
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Serialises one cell for CSV output.
 *
 * A value is quoted when it contains a delimiter, quote or newline, OR when it
 * starts with a character a spreadsheet would interpret as a formula. The
 * formula case is a real injection vector: a publisher domain beginning with
 * "=" or "+" executes when the export is opened in Excel.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(","));
  }
  // A trailing newline keeps the file POSIX-friendly and avoids the last row
  // being dropped by tools that require it.
  return `${lines.join("\r\n")}\r\n`;
}

/** A filename-safe slug, so an export cannot be given a path traversal name. */
export function exportFilename(entity: string, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10);
  const safeEntity = entity.replace(/[^a-z0-9_-]/gi, "");
  return `${safeEntity}-export-${stamp}.csv`;
}
