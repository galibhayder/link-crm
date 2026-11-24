/**
 * MINIMAL PDFMAKE DECLARATIONS.
 *
 * `pdfmake@0.3.x` ships no TypeScript types, and the 0.3 API differs from the
 * 0.2 API every `@types/pdfmake` package describes: fonts are registered with
 * `addFonts()` and output is produced with `createPdf(doc).getBuffer()`, not the
 * `PdfPrinter` class.
 *
 * Installing `@types/pdfmake` would therefore type-check against an API this
 * version does not have — a class of error that compiles and then fails at
 * runtime. These declarations describe only what this project uses.
 */
declare module "pdfmake" {
  interface PdfMakeDocument {
    getBuffer(): Promise<Buffer>;
    write(filename: string): Promise<void>;
  }

  interface PdfMakeInstance {
    addFonts(fonts: Record<string, Record<string, string>>): void;
    setFonts(fonts: Record<string, Record<string, string>>): void;
    createPdf(docDefinition: unknown): PdfMakeDocument;
  }

  const pdfmake: PdfMakeInstance;
  export default pdfmake;
}

// Both specifiers are declared. Development (tsx) resolves the extensionless form;
// production (plain Node ESM) requires the explicit `.js`. Without the second
// declaration the production build fails to compile even though dev works.
declare module "pdfmake/standard-fonts/Helvetica" {
  const fonts: Record<string, Record<string, string>>;
  export default fonts;
}

declare module "pdfmake/standard-fonts/Helvetica.js" {
  const fonts: Record<string, Record<string, string>>;
  export default fonts;
}

declare module "pdfmake/interfaces" {
  export type Content = Record<string, unknown> | string;
  export type TableCell = Record<string, unknown> | string;
  export interface TDocumentDefinitions {
    [key: string]: unknown;
  }
}
