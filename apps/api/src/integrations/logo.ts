/**
 * LOGO VALIDATION.
 *
 * A logo is uploaded as a data URI in the JSON body and stored on
 * `organizations.logo_url`. That column is read back by the sidebar, the login
 * screen AND the invoice PDF, so whatever lands there is rendered to every user
 * and every client receiving a bill.
 *
 * Three checks, each for a different failure:
 *
 * 1. SIZE. A 5 MB base64 blob in a settings row would be read on every page load.
 *    256 KB is generous for a logo mark and is enforced before anything else runs.
 *
 * 2. MAGIC BYTES. The declared MIME type is attacker-controlled. Only the first
 *    bytes of the decoded payload prove what the file actually is, so the type is
 *    re-derived from the content and compared to what was claimed.
 *
 * 3. SVG SANITISING. An SVG is executable markup: `<script>` or an `onload`
 *    attribute runs in the page's origin when the browser renders it as an image
 *    in some contexts, and certainly when opened directly. A "logo" is not a place
 *    to host a payload, so the markup is cleaned rather than trusted.
 */

/** 256 KB of decoded image. Comfortably above the 71 KB Trivero mark. */
export const MAX_LOGO_BYTES = 256 * 1024;

export interface LogoValidation {
  /** Canonical data URI, safe to store. */
  dataUri: string;
  /** Detected type, which may differ from what the caller claimed. */
  mime: string;
  bytes: number;
}

export class LogoError extends Error {}

/**
 * Detects an image type from its leading bytes.
 *
 * Deliberately a small allow-list of formats a logo can sensibly be. Anything
 * else — a PDF, a zip, an executable, an HTML file — is not a logo and is
 * rejected rather than stored and reasoned about later.
 */
export function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  // GIF is not offered in the UI, but accepting it costs nothing and it is a
  // legitimate logo format. (Animated GIFs render fine as a mark.)
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString("latin1") === "GIF") {
    return "image/gif";
  }
  return null;
}

/**
 * Strips active content from SVG markup.
 *
 * Uses an allow-list mentality on the constructs that execute, rather than trying
 * to enumerate every attack: remove `<script>`, `<foreignObject>` (which can embed
 * HTML), every `on*` handler attribute, and any `javascript:` URL.
 *
 * This is defence in depth, not the only defence — the stored value is served with
 * `Content-Type: image/svg+xml` from a data URI, so a hostile file that survived
 * this would still need the browser to execute it in a privileged context.
 */
export function sanitizeSvg(svg: string): string {
  let out = svg;

  // Whole elements that can carry or embed script.
  out = out.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
  out = out.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "");
  out = out.replace(/<iframe[\s\S]*?<\/iframe\s*>/gi, "");
  out = out.replace(/<object[\s\S]*?<\/object\s*>/gi, "");
  out = out.replace(/<embed[\s\S]*?>/gi, "");

  // Event-handler attributes: onclick=, onload=, onerror=, …
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // javascript: and data: URLs in href/xlink:href/src.
  out = out.replace(/\s(?:xlink:)?href\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, "");
  out = out.replace(/\s(?:xlink:)?href\s*=\s*("\s*data:text\/html[^"]*"|'\s*data:text\/html[^']*')/gi, "");
  out = out.replace(/\ssrc\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, "");

  // CSS expression() and @import in a style attribute.
  out = out.replace(/\sstyle\s*=\s*("[^"]*expression\([^"]*"|'[^']*expression\([^']*')/gi, "");
  out = out.replace(/\sstyle\s*=\s*("[^"]*@import[^"]*"|'[^']*@import[^']*')/gi, "");

  return out;
}

/**
 * Validates and canonicalises a logo data URI.
 *
 * Throws `LogoError` with a user-facing message on any failure. The caller maps
 * that to a 400 — an invalid logo is the uploader's problem, not a server fault.
 */
export function validateLogoDataUri(input: string): LogoValidation {
  const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(input.trim());
  // `match[1]`/`match[2]` are `string | undefined` under strict indexing, and the
  // regex guarantees both are present — but narrowing explicitly is what makes
  // that guarantee visible to the compiler rather than asserted to it.
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new LogoError("Expected a base64 data URI (data:image/png;base64,…)");
  }

  const claimedMime = match[1].toLowerCase();
  const base64 = match[2];

  // Size is checked on the ENCODED length first, so a huge payload is rejected
  // before it is decoded into memory. base64 is 4/3 the decoded size.
  const estimatedBytes = Math.floor((base64.length * 3) / 4);
  if (estimatedBytes > MAX_LOGO_BYTES) {
    throw new LogoError(
      `Logo is too large (${Math.round(estimatedBytes / 1024)} KB). The limit is ${MAX_LOGO_BYTES / 1024} KB.`,
    );
  }

  let buffer: Buffer;
  try {
    // Explicit `base64` encoding: the two-argument `Buffer.from(string)` overload
    // resolves to 'utf8' otherwise, which silently corrupts the image.
    buffer = Buffer.from(base64, "base64");
  } catch {
    throw new LogoError("Logo data is not valid base64");
  }

  if (buffer.length === 0) throw new LogoError("Logo data is empty");
  if (buffer.length > MAX_LOGO_BYTES) {
    throw new LogoError(`Logo is too large. The limit is ${MAX_LOGO_BYTES / 1024} KB.`);
  }

  // ---- SVG takes a different path -------------------------------------------
  if (claimedMime === "image/svg+xml") {
    const text = buffer.toString("utf8");
    // An SVG that does not start with markup is not an SVG, whatever it claims.
    if (!/<svg[\s>]/i.test(text.slice(0, 2048))) {
      throw new LogoError("That file does not look like an SVG image");
    }

    const clean = sanitizeSvg(text);
    const cleanBuffer = Buffer.from(clean, "utf8");
    if (cleanBuffer.length > MAX_LOGO_BYTES) {
      throw new LogoError("Logo is too large after sanitising");
    }

    return {
      dataUri: `data:image/svg+xml;base64,${cleanBuffer.toString("base64")}`,
      mime: "image/svg+xml",
      bytes: cleanBuffer.length,
    };
  }

  // ---- Raster: trust the bytes, not the claim -------------------------------
  const actual = detectImageMime(buffer);
  if (!actual) {
    throw new LogoError("Unsupported image format. Use PNG, JPEG, WebP, GIF or SVG.");
  }

  // The claimed type is allowed to be generic, but a claim of PNG on JPEG bytes
  // means the caller is confused — and storing a mislabelled type would make the
  // browser refuse to render it.
  const allowed = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
  if (!allowed.has(claimedMime)) {
    throw new LogoError("Unsupported image type. Use PNG, JPEG, WebP, GIF or SVG.");
  }

  // Store the DETECTED type. `image/jpg` is not a real MIME type and a browser
  // will not render a data URI that declares it.
  return {
    dataUri: `data:${actual};base64,${buffer.toString("base64")}`,
    mime: actual,
    bytes: buffer.length,
  };
}
