import { describe, expect, it } from "vitest";
import {
  LogoError,
  MAX_LOGO_BYTES,
  detectImageMime,
  sanitizeSvg,
  validateLogoDataUri,
} from "./logo.js";

/**
 * LOGO UPLOAD SAFETY.
 *
 * `organizations.logo_url` is rendered by the sidebar, the login screen and every
 * invoice PDF, so whatever lands there is shown to staff and to clients. These
 * tests attack the upload path rather than confirm the happy path.
 */

/** A minimal valid PNG: 1x1 transparent, 67 bytes. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const pngDataUri = (buf = PNG_1PX) => `data:image/png;base64,${buf.toString("base64")}`;

/**
 * Decodes the base64 payload out of a data URI.
 *
 * `split(",")[1]` is `string | undefined` under strict indexing; asserting it here
 * once keeps every SVG test readable instead of repeating a non-null check.
 */
function decodePayload(dataUri: string): string {
  const payload = dataUri.split(",")[1];
  if (payload === undefined) throw new Error(`not a data URI: ${dataUri.slice(0, 40)}`);
  return Buffer.from(payload, "base64").toString("utf8");
}

describe("detectImageMime — trusts bytes, not the claim", () => {
  it("detects PNG", () => {
    expect(detectImageMime(PNG_1PX)).toBe("image/png");
  });

  it("detects JPEG", () => {
    expect(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
  });

  it("detects WebP", () => {
    const webp = Buffer.concat([
      Buffer.from("RIFF", "latin1"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("WEBP", "latin1"),
    ]);
    expect(detectImageMime(webp)).toBe("image/webp");
  });

  it("returns null for HTML", () => {
    expect(detectImageMime(Buffer.from("<html><script>alert(1)</script></html>"))).toBeNull();
  });

  it("returns null for a PDF", () => {
    expect(detectImageMime(Buffer.from("%PDF-1.7\n"))).toBeNull();
  });

  it("returns null for a zip", () => {
    expect(detectImageMime(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
  });

  it("returns null for an empty buffer", () => {
    expect(detectImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe("validateLogoDataUri — rejects non-images", () => {
  it("accepts a real PNG", () => {
    const result = validateLogoDataUri(pngDataUri());
    expect(result.mime).toBe("image/png");
    expect(result.dataUri.startsWith("data:image/png;base64,")).toBe(true);
    expect(result.bytes).toBe(PNG_1PX.length);
  });

  it("rejects HTML dressed up as a PNG", () => {
    // The claimed type is image/png; the bytes are an attack. Magic-byte detection
    // is the only thing that catches this.
    const html = Buffer.from("<html><script>fetch('/api/v1/me')</script></html>");
    expect(() => validateLogoDataUri(`data:image/png;base64,${html.toString("base64")}`)).toThrow(LogoError);
  });

  it("rejects a JavaScript payload", () => {
    const js = Buffer.from("javascript:alert(1)");
    expect(() => validateLogoDataUri(`data:image/png;base64,${js.toString("base64")}`)).toThrow(LogoError);
  });

  it("rejects a non-data-URI string", () => {
    expect(() => validateLogoDataUri("https://evil.example/x.png")).toThrow(LogoError);
    expect(() => validateLogoDataUri("not a uri")).toThrow(LogoError);
  });

  it("rejects an oversized payload before decoding it", () => {
    // 400 KB of bytes, base64-encoded. Still under the 400k string limit the route
    // applies, so the size check inside the validator is what must catch it.
    const big = Buffer.alloc(MAX_LOGO_BYTES + 1024, 0x41);
    const uri = `data:image/png;base64,${big.toString("base64")}`;
    expect(() => validateLogoDataUri(uri)).toThrow(/too large/i);
  });

  it("accepts a payload just under the limit", () => {
    // A real PNG header followed by padding, to stay under the cap.
    const padded = Buffer.concat([PNG_1PX, Buffer.alloc(MAX_LOGO_BYTES - PNG_1PX.length - 16, 0x20)]);
    const result = validateLogoDataUri(pngDataUri(padded));
    expect(result.bytes).toBeLessThanOrEqual(MAX_LOGO_BYTES);
  });

  it("rejects an empty payload", () => {
    expect(() => validateLogoDataUri("data:image/png;base64,")).toThrow();
  });
});

describe("validateLogoDataUri — SVG is sanitised, not trusted", () => {
  const svg = (inner: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`).toString("base64")}`;

  it("accepts a benign SVG", () => {
    const result = validateLogoDataUri(svg('<circle cx="5" cy="5" r="4" fill="#4F5BEE"/>'));
    expect(result.mime).toBe("image/svg+xml");
  });

  it("strips a script element", () => {
    const result = validateLogoDataUri(svg('<script>alert(1)</script><rect width="1" height="1"/>'));
    const decoded = decodePayload(result.dataUri);
    expect(decoded).not.toContain("<script");
    expect(decoded).not.toContain("alert(1)");
    expect(decoded).toContain("<rect");
  });

  it("strips an onload handler", () => {
    const result = validateLogoDataUri(svg('<rect width="1" height="1" onload="alert(1)"/>'));
    const decoded = decodePayload(result.dataUri);
    expect(decoded).not.toMatch(/onload/i);
    expect(decoded).not.toContain("alert");
  });

  it("strips an onclick handler", () => {
    const result = validateLogoDataUri(svg('<rect width="1" height="1" onclick="steal()"/>'));
    const decoded = decodePayload(result.dataUri);
    expect(decoded).not.toMatch(/onclick/i);
  });

  it("strips a javascript: href", () => {
    const result = validateLogoDataUri(svg('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>'));
    const decoded = decodePayload(result.dataUri);
    expect(decoded).not.toContain("javascript:");
  });

  it("strips a foreignObject", () => {
    const result = validateLogoDataUri(svg('<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>x</script></body></foreignObject>'));
    const decoded = decodePayload(result.dataUri);
    expect(decoded).not.toContain("foreignObject");
  });

  it("rejects text that claims to be SVG but is not", () => {
    const notSvg = Buffer.from("just some text, no svg element");
    expect(() => validateLogoDataUri(`data:image/svg+xml;base64,${notSvg.toString("base64")}`)).toThrow(LogoError);
  });
});

describe("sanitizeSvg", () => {
  it("is idempotent on already-clean markup", () => {
    const clean = '<svg><circle r="1"/></svg>';
    expect(sanitizeSvg(clean)).toBe(clean);
  });

  it("removes handlers in any casing", () => {
    expect(sanitizeSvg('<svg><rect ONLOAD="x()" OnClick=\'y()\'/></svg>')).not.toMatch(/onload|onclick/i);
  });

  it("removes CSS expression()", () => {
    expect(sanitizeSvg('<svg><rect style="width: expression(alert(1))"/></svg>')).not.toContain("expression(");
  });
});
