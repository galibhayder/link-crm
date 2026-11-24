/**
 * VERIFY THE CUSTOM ACCESS TOKEN HOOK IS STAMPING TENANCY CLAIMS.
 *
 * Signing in successfully proves nothing about this. The hook's whole job is to
 * put `app_metadata.org_id` and `app_metadata.role` into the JWT, and
 * `app_private.current_org_id()` reads exactly those — so with the hook off you
 * authenticate fine and then every RLS policy filters on NULL and matches nothing.
 * Every screen is empty and nothing errors.
 *
 * This decodes the token and says whether the claims are there.
 *
 * USAGE — credentials come from the environment, never hard-coded:
 *
 *   PowerShell:
 *     $env:SUPABASE_URL="https://xxxx.supabase.co"
 *     $env:SUPABASE_ANON_KEY="eyJ..."
 *     $env:VERIFY_EMAIL="galib@triveromarketing.com"
 *     $env:VERIFY_PASSWORD="..."
 *     node scripts/verify-auth-claims.mjs
 *
 * Exits non-zero if a claim is missing, so it can gate a deploy.
 */

const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;
const email = process.env.VERIFY_EMAIL;
const password = process.env.VERIFY_PASSWORD;

const missing = Object.entries({ SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, VERIFY_EMAIL: email, VERIFY_PASSWORD: password })
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length > 0) {
  console.error(`Missing environment variable(s): ${missing.join(", ")}`);
  console.error("Set them for this command only — do not commit them.");
  process.exit(2);
}

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
console.log(`1. signing in as ${email}`);
// ---------------------------------------------------------------------------
let token;
try {
  const res = await fetch(`${url.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(`  ✗ sign-in failed (${res.status}): ${body.error_description ?? body.msg ?? body.error ?? ""}`);
    process.exit(1);
  }
  token = body.access_token;
  check("signed in", Boolean(token));
} catch (err) {
  console.error(`  ✗ could not reach ${url}: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
console.log("\n2. decoding the JWT payload");
// ---------------------------------------------------------------------------
const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
const app = claims.app_metadata ?? {};

console.log(`     keys in app_metadata: ${Object.keys(app).join(", ") || "(none)"}`);
console.log(`     sub: ${claims.sub ?? "(none)"}`);
console.log(`     aud: ${claims.aud ?? "(none)"}`);

// ---------------------------------------------------------------------------
console.log("\n3. the claims RLS depends on");
// ---------------------------------------------------------------------------
// `app_private.current_org_id()` is
//   select nullif(auth.jwt() -> 'app_metadata' ->> 'org_id', '')
// so this exact key is what every policy filters by.
check("app_metadata.org_id is present", Boolean(app.org_id), app.org_id ?? "MISSING — the hook is not stamping it");
check("app_metadata.role is present", Boolean(app.role), app.role ?? "MISSING — the hook is not stamping it");

if (app.role) {
  check(
    "role is one the app recognises",
    ["owner", "account_manager", "prospector", "outreach_specialist", "content_writer", "client_user", "publisher_user"].includes(app.role),
    app.role,
  );
}

// A user the hook considers unprovisioned gets NO claims, deliberately. Seeing a
// role here means the profile exists and is active, which is what we want.
if (!app.org_id) {
  console.log("\n     The hook returned no tenancy claims. Two possible causes:");
  console.log("       - the hook is not enabled on this project;");
  console.log("       - this user has no active profile row, and the hook strips claims");
  console.log("         on purpose so every policy fails closed.");
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "PASS — tenancy claims present, RLS will work" : "FAIL — do not deploy yet"}`);
process.exit(failures === 0 ? 0 : 1);
