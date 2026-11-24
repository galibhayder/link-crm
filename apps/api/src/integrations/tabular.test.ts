import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import ExcelJS from "exceljs";
import { buildCsv, buildWorkbook, attachmentHeader, type ExportColumn } from "./tabular.js";

/**
 * TYPECHECK FOR EXPORTS.
 *
 * CSV is checked by parsing it back with a real parser rather than matching a
 * string: the failure mode that matters is a client named `Acme, Ltd.` shifting
 * every column after it, and only a round-trip catches that.
 */

const columns: ExportColumn[] = [
  { header: "Client", key: "client", type: "text" },
  { header: "Campaign", key: "campaign", type: "text" },
  { header: "Revenue", key: "revenue", type: "currency" },
  { header: "Currency", key: "currency", type: "text" },
];

const rows = [
  { client: "Acme, Ltd.", campaign: 'Say "hello"', revenue: 1500.5, currency: "USD" },
  { client: "Beta Commerce", campaign: "Q1 links", revenue: 250, currency: "USD" },
];

describe("buildCsv", () => {
  it("round-trips a value containing a comma and quotes", () => {
    const csv = buildCsv({ columns, rows });
    const parsed = Papa.parse(csv.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: true });

    expect(parsed.errors).toHaveLength(0);
    expect(parsed.data).toHaveLength(2);
    // The whole reason for using a parser: this must survive intact.
    expect((parsed.data[0] as Record<string, string>).Client).toBe("Acme, Ltd.");
    expect((parsed.data[0] as Record<string, string>).Campaign).toBe('Say "hello"');
  });

  it("prepends a UTF-8 BOM so Excel reads accents", () => {
    const csv = buildCsv({ columns, rows });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("can omit the BOM when asked", () => {
    const csv = buildCsv({ columns, rows, includeBom: false });
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("writes an empty cell for null rather than the string 'null'", () => {
    const csv = buildCsv({
      columns: [{ header: "A", key: "a" }],
      rows: [{ a: null }],
      includeBom: false,
    });
    expect(csv).not.toContain("null");
  });

  it("preserves column order exactly", () => {
    const csv = buildCsv({ columns, rows, includeBom: false });
    // PapaParse emits CRLF, which is what RFC 4180 specifies.
    const header = csv.split(/\r?\n/)[0];
    expect(header).toBe("Client,Campaign,Revenue,Currency");
  });
});

describe("buildWorkbook", () => {
  it("produces a real xlsx file and reads back the rows", async () => {
    const buffer = await buildWorkbook({ sheetName: "Profitability", columns, rows, currencyKey: "currency" });

    // PK zip signature — an xlsx is a zip container.
    expect(buffer.subarray(0, 2).toString("latin1")).toBe("PK");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Profitability");

    expect(ws).toBeTruthy();
    expect(ws!.getRow(1).getCell(1).value).toBe("Client");
    expect(ws!.getRow(2).getCell(1).value).toBe("Acme, Ltd.");
    // Currency cells stay numeric so they can be summed.
    expect(typeof ws!.getRow(2).getCell(3).value).toBe("number");
  });

  it("uses a real currency number format on money columns", async () => {
    const buffer = await buildWorkbook({ sheetName: "S", columns, rows, currencyKey: "currency" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("S")!;
    expect(String(ws.getRow(2).getCell(3).numFmt)).toContain("USD");
  });

  it("freezes the header row", async () => {
    const buffer = await buildWorkbook({ sheetName: "S", columns, rows });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("S")!;
    expect(ws.views[0]).toMatchObject({ state: "frozen" });
  });

  it("handles an empty row set without throwing", async () => {
    const buffer = await buildWorkbook({ sheetName: "Empty", columns, rows: [] });
    expect(buffer.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("truncates a sheet name past Excel's 31-character limit", async () => {
    const buffer = await buildWorkbook({
      sheetName: "A very long sheet name that exceeds excelful limits",
      columns,
      rows,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(wb.worksheets[0]!.name.length).toBeLessThanOrEqual(31);
  });
});

describe("attachmentHeader", () => {
  it("quotes a filename safely", () => {
    const header = attachmentHeader("Invoice INV-0001.pdf");
    expect(header).toContain('filename="Invoice-INV-0001.pdf"');
  });

  it("strips characters that would break the header", () => {
    const header = attachmentHeader('bad"name\nhere.pdf');
    expect(header).not.toContain("\n");
    expect(header).not.toContain('bad"');
  });
});
