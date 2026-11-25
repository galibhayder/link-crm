/**
 * HOSTINGER ENTRY POINT (monorepo-root deployment).
 *
 * Hostinger runs a start command from the repository root after its build step.
 * The real server is the compiled API (`apps/api/dist/server.js`), which also
 * serves the built SPA from `apps/web/dist` — its default WEB_DIST_PATH resolves
 * there relative to its own location, so no extra variable is required.
 *
 * This shim exists so the platform's "Entry file"/"Start command" is a stable
 * `node server.mjs` regardless of how deep the compiled entry sits. It is ESM
 * (`.mjs`) because the root package.json is CommonJS by default, while the API
 * is compiled as ESM.
 */
import "./apps/api/dist/server.js";
