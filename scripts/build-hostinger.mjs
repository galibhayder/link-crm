/**
 * BUILDS A DEPLOYABLE ARTIFACT FOR HOSTINGER BUSINESS NODE.JS HOSTING.
 *
 * Hostinger runs `npm install --production` and a start command in a directory it
 * manages. It has no pnpm workspace, no `apps/` tree and no monorepo resolution —
 * so the monorepo cannot be uploaded as-is. This produces `dist-hostinger/`, which
 * is a plain single-package Node app:
 *
 *   dist-hostinger/
 *     server.js            the compiled API (entry point)
 *     dist/                the compiled API modules
 *     web-dist/            the built React app, served by server.js
 *     package.json         production dependencies only
 *
 * `@crm/shared` is compiled into `dist/` rather than left as a workspace link,
 * because the host cannot resolve `workspace:*`.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const OUT = "dist-hostinger";
const log = (m) => console.log(`[hostinger] ${m}`);

function must(condition, message) {
  if (!condition) {
    console.error(`[hostinger] FAILED: ${message}`);
    process.exit(1);
  }
}

log("cleaning output directory");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Build the monorepo
// ---------------------------------------------------------------------------
log("building workspaces (shared -> api -> web)");
execSync("pnpm build", { stdio: "inherit" });

must(existsSync("apps/api/dist/server.js"), "apps/api/dist/server.js was not produced");
must(existsSync("apps/web/dist/index.html"), "apps/web/dist/index.html was not produced");

// ---------------------------------------------------------------------------
// 2. Copy the compiled API
// ---------------------------------------------------------------------------
log("copying compiled API");
cpSync("apps/api/dist", `${OUT}/dist`, { recursive: true });

// The entry point stays at the root so the host's start command is simply
// `node server.js`.
writeFileSync(
  `${OUT}/server.js`,
  `// Hostinger entry point.\n// The real application lives in ./dist — this shim keeps the start command\n// trivial and independent of how the host resolves its working directory.\nimport "./dist/server.js";\n`,
);

// ---------------------------------------------------------------------------
// 3. Copy the built SPA
// ---------------------------------------------------------------------------
log("copying built frontend");
cpSync("apps/web/dist", `${OUT}/web-dist`, { recursive: true });

// ---------------------------------------------------------------------------
// 4. Generate a production package.json
// ---------------------------------------------------------------------------
log("writing production package.json");
const apiPkg = JSON.parse(readFileSync("apps/api/package.json", "utf8"));
const rootPkg = JSON.parse(readFileSync("package.json", "utf8"));

// `@crm/shared` is a workspace link and must not appear in dependencies:
// `workspace:*` cannot be installed from a registry, and `npm install` would fail
// outright. It is vendored into node_modules after the install instead.
const deps = { ...apiPkg.dependencies };
delete deps["@crm/shared"];

const outPkg = {
  name: "trivero-crm",
  version: apiPkg.version,
  private: true,
  type: "module",
  // Node 20.6+ is required for process.loadEnvFile, which config/env.ts uses.
  engines: { node: rootPkg.engines?.node ?? ">=20" },
  main: "server.js",
  scripts: {
    start: "node server.js",
  },
  dependencies: deps,
};
writeFileSync(`${OUT}/package.json`, `${JSON.stringify(outPkg, null, 2)}\n`);

// ---------------------------------------------------------------------------
// 5. Install production dependencies
//
// Must run BEFORE the shared package is vendored: `npm install` prunes anything in
// node_modules it does not own, which would delete it.
// ---------------------------------------------------------------------------
log("installing production dependencies into the artifact");
execSync("npm install --omit=dev --no-audit --no-fund", { cwd: OUT, stdio: "inherit" });

// ---------------------------------------------------------------------------
// 6. Vendor @crm/shared
//
// The compiled API still imports `@crm/shared` at runtime, but the host has no
// workspace. Copying the package in with its own compiled dist makes the artifact
// self-contained.
//
// This was a real deployment failure the verifier caught: the artifact built
// cleanly, installed cleanly, then died on boot with ERR_MODULE_NOT_FOUND for
// @crm/shared. Without the boot test this ships broken.
// ---------------------------------------------------------------------------
log("vendoring @crm/shared into node_modules");
const sharedTarget = `${OUT}/node_modules/@crm/shared`;
cpSync("packages/shared/dist", `${sharedTarget}/dist`, { recursive: true });
writeFileSync(
  `${sharedTarget}/package.json`,
  `${JSON.stringify(
    {
      name: "@crm/shared",
      version: "0.1.0",
      private: true,
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    },
    null,
    2,
  )}\n`,
);

// ---------------------------------------------------------------------------
// 7. Prove it boots — the whole point of this script
// ---------------------------------------------------------------------------
log("verifying the artifact starts and serves the SPA");
execSync("node scripts/verify-hostinger-artifact.mjs", { stdio: "inherit" });

log("");
log(`done -> ${OUT}/`);
log("");
log("Upload the CONTENTS of that directory. Set these environment variables in the");
log("Hostinger panel (see docs/PRODUCTION-ENV.md):");
log("  NODE_ENV=production  SUPABASE_URL  SUPABASE_ANON_KEY");
log("  SUPABASE_SERVICE_ROLE_KEY  JOB_HMAC_SECRET  CORS_ORIGINS");
log("  WEB_DIST_PATH=./web-dist");
