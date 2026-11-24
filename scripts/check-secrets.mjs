/**
 * Security check: no server secret may appear in the frontend bundle.
 *
 * Vite inlines every VITE_* variable, so a single mis-prefixed variable would
 * publish the service-role key to every visitor. This script fails the build if
 * it finds one. Run it in CI after `pnpm --filter @crm/web build`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = process.env.DIST_DIR ?? "apps/web/dist";

/** Patterns that must never appear in shipped browser code. */
const FORBIDDEN = [
  { name: "service_role literal", pattern: /service_role/i, severity: "error" },
  { name: "SERVICE_ROLE env var", pattern: /SERVICE_ROLE_KEY/, severity: "error" },
  { name: "SUPABASE_SERVICE_ROLE_KEY", pattern: /SUPABASE_SERVICE_ROLE_KEY/, severity: "error" },
  { name: "JOB_HMAC_SECRET", pattern: /JOB_HMAC_SECRET/, severity: "error" },
  { name: "server-only env reference", pattern: /process\.env\.(?!NODE_ENV)/, severity: "warn" },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|css|html|map)$/.test(entry.name)) out.push(full);
  }
  return out;
}

let files;
try {
  files = walk(DIST);
} catch {
  console.error(`\n✗ Build output not found at ${DIST}. Run the build first.`);
  process.exit(1);
}

console.log(`Scanning ${files.length} built files in ${DIST}…\n`);

let errors = 0;
let warnings = 0;

for (const file of files) {
  const content = readFileSync(file, "utf8");
  const size = statSync(file).size;

  for (const rule of FORBIDDEN) {
    const match = content.match(rule.pattern);
    if (!match) continue;

    // An inline public key string containing "service_role" inside a JWT claim
    // would be the exact failure we are guarding against, so any occurrence is
    // reported rather than filtered out.
    if (rule.severity === "error") {
      errors++;
      // Show the surrounding characters to make the leak obvious without
      // dumping an entire minified bundle into the log.
      const idx = Math.max(0, (match.index ?? 0) - 40);
      const excerpt = content.slice(idx, idx + 120).replace(/\s+/g, " ");
      console.error(`✗ ${rule.name} in ${file} (${size} bytes)`);
      console.error(`    …${excerpt}…\n`);
    } else {
      warnings++;
      console.warn(`! ${rule.name} in ${file}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Confirm the only Supabase key in the bundle is the anon key.
//
// A JWT's payload is base64url, so matching literal `"role":"anon"` finds
// nothing. Decode every JWT-shaped string and report the role each one claims —
// that is the check that would actually catch a service-role key.
// ---------------------------------------------------------------------------
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const foundRoles = new Set();
const foundJwts = new Set();

for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const jwt of content.match(JWT_PATTERN) ?? []) {
    if (foundJwts.has(jwt)) continue;
    foundJwts.add(jwt);
    try {
      const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
      if (typeof payload.role === "string") foundRoles.add(payload.role);
    } catch {
      // A malformed JWT-shaped string is not a key we can classify.
    }
  }
}

console.log("");
if (foundRoles.size === 0) {
  console.warn("! No JWT found in the bundle — check VITE_SUPABASE_ANON_KEY is set at build time");
} else {
  for (const role of foundRoles) {
    if (role === "anon") {
      console.log("✓ Found the anon key (safe to expose; RLS decides what it can reach)");
    } else {
      errors++;
      console.error(`✗ CRITICAL: a JWT with role "${role}" is in the browser bundle`);
    }
  }
  console.log(`  ${foundJwts.size} distinct JWT(s) embedded.`);
}

if (errors > 0) {
  console.error(`\n✗ FAILED: ${errors} secret leak(s) found in the frontend bundle.`);
  process.exit(1);
}

console.log(`\n✓ No server secrets in the browser bundle${warnings ? ` (${warnings} warning(s))` : ""}.`);
