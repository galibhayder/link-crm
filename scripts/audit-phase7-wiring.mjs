/**
 * AUDITS WHICH CONFIG KEYS ARE ACTUALLY CONSUMED BY THE UI.
 *
 * The Phase 7 tests proved each setting round-trips through the API. That is not
 * the same as the setting having any effect: a key can be stored, returned, and
 * then ignored by every component. This script greps the web app for each key.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk("apps/web/src").map((f) => ({
  // Normalise to forward slashes: the walk yields Windows separators, and a
  // `includes("features/admin/")` test against a backslash path silently matched
  // nothing — which made every editor-only hit look like an applied setting.
  path: f.replace(/\\/g, "/"),
  src: readFileSync(f, "utf8"),
}));

// Files that are the Admin editor itself — writing a key there is definitionally
// not the same as the app APPLYING it.
const isEditor = (p) => p.includes("/features/admin/");

const checks = [
  { key: "navigation.labels", needle: /labels\[/, expect: "applied" },
  { key: "navigation.sectionLabels", needle: /sectionLabels/, expect: "applied" },
  { key: "modules (hidden)", needle: /config\.modules/, expect: "applied" },
  { key: "theme.accent", needle: /theme\?\.accent/, expect: "applied" },
  { key: "theme.sidebar", needle: /theme\?\.sidebar/, expect: "applied" },
  { key: "theme.radius", needle: /theme\?\.radius/, expect: "applied" },
  { key: "branding.appName", needle: /branding\?\.appName/, expect: "applied" },
  // The dashboard destructures the config into a local first, so the accessor is
  // `dashboardConfig.hidden` / `.order`. Matching only `config.dashboard.hidden`
  // reported a false "NOT APPLIED" after the wiring was added.
  { key: "dashboard.hidden", needle: /dashboard(Config)?\??\.hidden/, expect: "applied" },
  { key: "dashboard.order", needle: /dashboard(Config)?\??\.order/, expect: "applied" },
  // Same shape in the invoices list: `ui?.config.tables?.["/invoices"]?.columns`.
  { key: "tables.<module>.columns", needle: /tables\?\.\[/, expect: "applied" },
  // roleVisibility is enforced SERVER-side by effectiveModules; the client never
  // reads it directly, and should not.
  { key: "roleVisibility", needle: /roleVisibility/, expect: "server-side only" },
];

let missing = 0;
console.log("key                          status");
console.log("-".repeat(60));

for (const c of checks) {
  const hits = files.filter((f) => !isEditor(f.path) && c.needle.test(f.src));
  const applied = hits.length > 0;
  if (!applied && c.expect === "applied") missing += 1;
  console.log(
    `${c.key.padEnd(28)} ${applied ? "applied" : "NOT APPLIED"}${applied ? ` (${hits.length} file(s))` : ""}`,
  );
  if (applied && hits.length <= 2) for (const h of hits) console.log(`    ${h.path}`);
}

console.log(`\n${missing} config key(s) stored but never rendered`);
process.exit(missing === 0 ? 0 : 1);
