import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Request, RequestHandler, Response } from "express";
import { isProd } from "../config/env.js";

/**
 * SERVES THE COMPILED REACT APP FROM THE SAME PROCESS AS THE API.
 *
 * In development Vite serves the SPA on :5173 and proxies /api here. In production
 * there is one origin: Express answers /api/*, /portal/v1/*, /supplier/v1/* and
 * /public/v1/* as JSON, and everything else as the SPA. That removes CORS from the
 * deployment entirely and means the browser needs no absolute API URL.
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * Headers that only make sense for the HTML shell.
 *
 * A CSP is applied here rather than globally because the API returns JSON and a
 * document-level policy would be meaningless noise on those responses.
 *
 * `script-src` needs `'unsafe-inline'` for exactly one thing: the theme bootstrap
 * in index.html that runs before first paint. Without it the browser blocks that
 * script and every user gets a flash of the wrong theme. The alternative is a
 * hash, which would have to be regenerated whenever the snippet changes — a
 * silent breakage waiting to happen. Everything else stays locked down.
 */
function htmlHeaders(res: Response) {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // The browser talks to Supabase Auth and Storage directly, and it may be a
      // different origin from the app (hosted Supabase).
      "connect-src 'self' https: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Hashed asset names make the shell itself the only thing that can go stale.
  res.setHeader("Cache-Control", "no-cache");
}

export function createStaticMiddleware(webDistPath: string): RequestHandler {
  const root = resolve(webDistPath);
  const indexHtml = join(root, "index.html");

  /**
   * Paths that must never be answered with HTML.
   *
   * If the SPA fallback ever caught one of these, a client parsing the response as
   * JSON would receive index.html — the failure mode that looks like a CORS or
   * "unexpected token <" error rather than a missing route.
   *
   * The `/v1` suffix matters. `/portal` and `/supplier` are ALSO client-side routes
   * (`/portal/drafts` is a page), so excluding the bare prefix makes those pages
   * 404 on a hard refresh. Only the versioned API prefixes are excluded. This is
   * the same distinction that the Vite proxy has to make, and getting it wrong here
   * reproduces the Phase 5.1 login failure in a new file.
   */
  const API_PREFIXES = ["/api/v1", "/portal/v1", "/supplier/v1", "/public/v1", "/health"];
  const isApiPath = (p: string) => API_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));

  return async function serveStatic(req: Request, res: Response, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (isApiPath(req.path)) return next();

    // A traversal attempt must not escape the build directory. `normalize` collapses
    // ".." before this check, and the resolved path is re-verified below, because a
    // decoded "%2e%2e%2f" arrives here already normalised by Express — belt and braces.
    const decoded = decodeURIComponent(req.path);
    const relative = normalize(decoded).replace(/^([/\\])+/, "");
    const candidate = resolve(root, relative);

    if (!candidate.startsWith(root + sep) && candidate !== root) return next();

    // A real file wins. Extension-less requests are SPA routes, not missing files.
    if (extname(decoded) && existsSync(candidate)) {
      const ext = extname(decoded).toLowerCase();
      res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
      // Vite fingerprints asset filenames, so they are immutable by construction.
      res.setHeader(
        "Cache-Control",
        decoded.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600",
      );
      try {
        const body = await readFile(candidate);
        res.status(200).end(body);
      } catch {
        next();
      }
      return;
    }

    // Anything with a file extension that did not resolve is genuinely missing —
    // returning the HTML shell would make a broken asset load look like success.
    if (extname(decoded)) return next();

    // Everything else is a client-side route. Deep links such as /invoices/:id must
    // work on a hard refresh, so the shell is returned with a 200.
    try {
      const html = await readFile(indexHtml);
      htmlHeaders(res);
      res.status(200).type("html").end(html);
    } catch {
      // No build present. In production that is a broken deploy and must be visible,
      // not a silent fallback to a 404 that looks like a routing bug.
      if (isProd) {
        res
          .status(500)
          .type("text/plain")
          .send("Frontend build not found. Run `pnpm build` before starting the server.");
        return;
      }
      next();
    }
  };
}

/** Where the built SPA is expected, relative to the API's own dist directory. */
export function defaultWebDistPath(): string {
  // apps/api/dist -> apps/web/dist
  return resolve(import.meta.dirname, "../../../web/dist");
}
