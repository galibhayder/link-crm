/**
 * PRODUCTION SERVE AUDIT.
 *
 * Runs against the COMPILED server (`node dist/server.js`), not tsx. Everything
 * here is a property that only holds in a single-origin deployment, and each was
 * checked deliberately because these are the failures that appear only after
 * deploy — dev-mode Vite hides all of them behind its own dev server.
 */
const BASE = process.env.PROD_URL ?? "http://127.0.0.1:3001";

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d });
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

async function get(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual", ...opts });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

// ---------------------------------------------------------------------------
console.log("1. the SPA shell is served at the root");
// ---------------------------------------------------------------------------
{
  const r = await get("/");
  check("GET / returns 200", r.status === 200, String(r.status));
  check("GET / is HTML", (r.headers.get("content-type") ?? "").includes("text/html"), r.headers.get("content-type"));
  check("the shell contains the React mount point", r.text.includes('id="root"'));
  check("the shell links a hashed asset bundle", /src="\/assets\/index-[^"]+\.js"/.test(r.text));
  check("the document has no stale dev script", !r.text.includes("/src/main.tsx"));
}

// ---------------------------------------------------------------------------
console.log("\n2. deep links return the shell, so a hard refresh works");
// ---------------------------------------------------------------------------
for (const route of ["/invoices", "/invoices/abc-123", "/admin", "/portal/drafts", "/placements/42/edit"]) {
  const r = await get(route);
  check(`${route} returns the app shell`, r.status === 200 && r.text.includes('id="root"'), String(r.status));
}

// This is the one from the Phase 5.1 review: `/portal/drafts` is an SPA route while
// `/portal/v1/*` is the API. A prefix match on `/portal` would swallow the page.
{
  const r = await get("/portal/drafts");
  check("/portal/drafts is NOT answered by the API", !/No route for GET/.test(r.text));
}

// ---------------------------------------------------------------------------
console.log("\n3. API paths still answer JSON, never HTML");
// ---------------------------------------------------------------------------
{
  const live = await get("/health/live");
  check("/health/live returns JSON", (live.headers.get("content-type") ?? "").includes("application/json"), live.headers.get("content-type"));
  check("/health/live body parses", (() => { try { JSON.parse(live.text); return true; } catch { return false; } })());

  const ready = await get("/health/ready");
  check("/health/ready touches the database", ready.status === 200, String(ready.status));
  const readyBody = JSON.parse(ready.text);
  check("the database is actually reachable", readyBody?.data?.database === "reachable", readyBody?.data?.database);
}

// An unknown API path must be a JSON 404. If the SPA fallback caught it, a client
// parsing JSON would get index.html and report "Unexpected token <".
//
// Anonymous requests get 401 first: `authenticate` guards the entire mount before
// routing, so an unknown path under /api/v1 is indistinguishable from a known one
// without a token. That is correct — it does not reveal which routes exist. The
// interesting case is therefore an AUTHENTICATED request to a path that does not
// exist, which must be a JSON 404 rather than the HTML shell.
const SUPABASE = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const ownerToken = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "content-type": "application/json" },
  body: JSON.stringify({ email: "owner@demo.test", password: "password123" }),
})
  .then((r) => r.json())
  .then((b) => b.access_token)
  .catch(() => null);

{
  const anon = await get("/api/v1/nonexistent");
  check(
    "an unknown API path without a token is 401 (does not reveal the route table)",
    anon.status === 401,
    String(anon.status),
  );
}

if (ownerToken) {
  const authed = await get("/api/v1/nonexistent", { headers: { authorization: `Bearer ${ownerToken}` } });
  const isJson = (authed.headers.get("content-type") ?? "").includes("application/json");
  check("an authenticated unknown API path is a JSON 404", authed.status === 404 && isJson, `${authed.status}`);
  check("...and does not return the HTML shell", !authed.text.includes('id="root"'));
} else {
  check("could not obtain a token to test the authenticated 404", false, "login failed");
}

// The public surface has no auth guard, so an unknown path there is directly 404.
{
  const r = await get("/public/v1/nonexistent");
  check(
    "/public/v1 unknown path is a JSON 404",
    r.status === 404 && (r.headers.get("content-type") ?? "").includes("application/json"),
    String(r.status),
  );
}

// An authenticated path with no token must be 401 JSON, not a login page.
{
  const r = await get("/api/v1/clients");
  check("an unauthenticated API call returns 401 JSON", r.status === 401, String(r.status));
  check("...and not the HTML shell", !r.text.includes('id="root"'));
}

// ---------------------------------------------------------------------------
console.log("\n4. static assets are served with long-lived caching");
// ---------------------------------------------------------------------------
{
  const shell = await get("/");
  const asset = shell.text.match(/src="(\/assets\/[^"]+)"/)?.[1];
  check("the bundle path was extracted from the shell", Boolean(asset), asset);

  if (asset) {
    const r = await get(asset);
    check("the bundle is served", r.status === 200, String(r.status));
    check("it is JavaScript", (r.headers.get("content-type") ?? "").includes("javascript"), r.headers.get("content-type"));
    check(
      "hashed assets are immutable-cached",
      (r.headers.get("cache-control") ?? "").includes("immutable"),
      r.headers.get("cache-control"),
    );
    check("the bundle is substantial (not an error page)", r.text.length > 100_000, `${r.text.length} bytes`);
  }

  const css = shell.text.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
  if (css) {
    const r = await get(css);
    check("the stylesheet is served as CSS", (r.headers.get("content-type") ?? "").includes("text/css"), r.headers.get("content-type"));
  }

  const favicon = await get("/favicon.svg");
  check("the favicon is served", favicon.status === 200, String(favicon.status));
}

// ---------------------------------------------------------------------------
console.log("\n5. the shell carries a CSP that permits the theme bootstrap");
// ---------------------------------------------------------------------------
{
  const r = await get("/");
  const csp = r.headers.get("content-security-policy") ?? "";
  check("a CSP is present on the shell", csp.length > 0);
  // index.html has an inline theme script. Without 'unsafe-inline' the browser
  // blocks it and every user sees a flash of the wrong theme on load.
  check("script-src allows the inline theme bootstrap", /script-src[^;]*'unsafe-inline'/.test(csp), csp.slice(0, 80));
  check("frames are refused", csp.includes("frame-ancestors 'none'"));
  check("the shell is not cached", (r.headers.get("cache-control") ?? "").includes("no-cache"), r.headers.get("cache-control"));
  check("nosniff is set", r.headers.get("x-content-type-options") === "nosniff");
}

// ---------------------------------------------------------------------------
console.log("\n6. path traversal cannot escape the build directory");
// ---------------------------------------------------------------------------
for (const attack of ["/../package.json", "/assets/../../package.json", "/..%2f..%2fpackage.json"]) {
  const r = await get(attack);
  const leaked = /"name":\s*"@crm\/api"|"dependencies"/.test(r.text);
  check(`${attack} does not leak a source file`, !leaked, `${r.status}`);
}

// A missing asset must 404 rather than return HTML — otherwise a broken bundle
// load looks like a successful page.
{
  const r = await get("/assets/does-not-exist-abc123.js");
  check("a missing asset is a real 404", r.status === 404, String(r.status));
  check("...and is not the HTML shell", !r.text.includes('id="root"'));
}

// ---------------------------------------------------------------------------
console.log("\n7. errors are JSON and leak nothing");
// ---------------------------------------------------------------------------
{
  const r = await get("/api/v1/clients", { headers: { authorization: "Bearer not-a-token" } });
  check("a bad token is 401", r.status === 401, String(r.status));
  const blob = r.text.toLowerCase();
  check("no stack trace in the response", !blob.includes("at object.") && !blob.includes("node_modules"));
  check("no service key in the response", !blob.includes("service_role"));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.n} — ${f.d}`);
  process.exit(1);
}
