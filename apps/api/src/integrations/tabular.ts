import Papa from "papaparse";
import ExcelJS from "exceljs";

/**
 * TABULAR EXPORTS — CSV and XLSX.
 *
 * Shared by every report so an export cannot disagree with the screen it was
 * generated from: both take the same `columns` + `rows` shape the API returns.
 *
 * CSV. PapaParse handles RFC 4180 quoting, which matters more than it sounds: a
 * client named `Acme, Ltd.` or an address with a newline silently shifts every
 * subsequent column if the quoting is hand-rolled. A UTF-8 BOM is prepended so
 * Excel opens accented names correctly instead of showing mojibake.
 *
 * XLSX. ExcelJS with a frozen header row and real number formats, so a currency
 * column is a number in Excel rather than text that cannot be summed.
 */

export interface ExportColumn {
  header: string;
  key: string;
  /** `currency` needs the row's currency code to format. */
  type?: "text" | "number" | "currency" | "date";
  width?: number;
  align?: "left" | "right";
}

export type ExportRow = Record<string, string | number | null | undefined>;

/**
 * Excel export.
 *
 * `currencyKey` names the column holding the ISO code per row, so a sheet that
 * mixes currencies still formats each cell correctly instead of forcing one
 * format on the whole column.
 */
export async function buildWorkbook(input: {
  sheetName: string;
  title?: string;
  columns: ExportColumn[];
  rows: ExportRow[];
  currencyKey?: string;
  summary?: Array<{ label: string; value: string | number; type?: "text" | "currency" }>;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Trivero Marketing";
  wb.created = new Date();

  const ws = wb.addWorksheet(input.sheetName.slice(0, 31), {
    views: [{ state: "frozen", ySplit: input.title ? 3 : 1 }],
  });

  let headerRowIndex = 1;

  if (input.title) {
    ws.mergeCells(1, 1, 1, Math.max(input.columns.length, 1));
    const titleCell = ws.getCell(1, 1);
    titleCell.value = input.title;
    titleCell.font = { bold: true, size: 14 };
    headerRowIndex = 3;
  }

  const headerRow = ws.getRow(headerRowIndex);
  input.columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, size: 10, color: { argb: "FF6B7280" } };
    cell.alignment = { vertical: "middle", horizontal: col.align ?? "left" };
    cell.border = { bottom: { style: "thin", color: { argb: "FFE5E7EB" } } };
  });
  headerRow.height = 18;

  input.columns.forEach((col, i) => {
    ws.getColumn(i + 1).width = col.width ?? 18;
  });

  input.rows.forEach((row, r) => {
    const excelRow = ws.getRow(headerRowIndex + 1 + r);

    input.columns.forEach((col, i) => {
      const cell = excelRow.getCell(i + 1);
      const raw = row[col.key];

      if (raw === null || raw === undefined || raw === "") {
        cell.value = null;
        return;
      }

      if (col.type === "number") {
        cell.value = typeof raw === "number" ? raw : Number(raw);
        cell.numFmt = "#,##0.00";
        cell.alignment = { horizontal: "right" };
        return;
      }

      if (col.type === "currency") {
        cell.value = typeof raw === "number" ? raw : Number(raw);
        const code = input.currencyKey
          ? String(row[input.currencyKey] ?? "USD")
          : "USD";
        // A real currency format, not a text prefix — so the cell sums.
        cell.numFmt = `"${code} "#,##0.00`;
        cell.alignment = { horizontal: "right" };
        return;
      }

      if (col.type === "date") {
        const d = new Date(String(raw));
        cell.value = Number.isNaN(d.getTime()) ? String(raw) : d;
        cell.numFmt = "yyyy-mm-dd";
        return;
      }

      cell.value = String(raw);
      cell.alignment = { horizontal: col.align ?? "left" };
    });
  });

  if (input.summary && input.summary.length) {
    const start = headerRowIndex + input.rows.length + 2;
    input.summary.forEach((item, i) => {
      const row = ws.getRow(start + i);
      const labelCell = row.getCell(Math.max(input.columns.length - 1, 1));
      labelCell.value = item.label;
      labelCell.font = { bold: true };

      const valueCell = row.getCell(Math.max(input.columns.length, 2));
      if (item.type === "currency" && typeof item.value === "number") {
        valueCell.value = item.value;
        valueCell.numFmt = '"USD "#,##0.00';
      } else {
        valueCell.value = item.value;
      }
      valueCell.font = { bold: true };
    });
  }

  // ExcelJS emits an ArrayBuffer; Node callers want a Buffer for res.send.
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}

/**
 * CSV export.
 *
 * Returns a string, not a Buffer, so the caller can decide on the BOM. It is
 * prepended here because the target is Excel, which misreads UTF-8 without one.
 */
export function buildCsv(input: {
  columns: ExportColumn[];
  rows: ExportRow[];
  includeBom?: boolean;
}): string {
  const data = input.rows.map((row) =>
    Object.fromEntries(
      input.columns.map((col) => {
        const v = row[col.key];
        return [col.header, v === null || v === undefined ? "" : String(v)];
      }),
    ),
  );

  const csv = Papa.unparse(data, {
    columns: input.columns.map((c) => c.header),
    quotes: false,
    // Quote only what needs it — a sheet of numbers should not be all quotes.
    escapeFormulae: false,
  });

  return input.includeBom === false ? csv : `\uFEFF${csv}`;
}

/** Content-Disposition that survives a filename with spaces or quotes. */
export function attachmentHeader(filename: string): string {
  const safe = filename.replace(/[^\w.\-]+/g, "-").replace(/-+/g, "-");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
