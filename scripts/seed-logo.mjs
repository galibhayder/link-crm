/**
 * Seeds the Trivero Marketing logo through the real upload endpoint.
 *
 * WHY THROUGH THE API, not a direct UPDATE in seed.sql:
 *
 * Writing `organizations.logo_url` directly would make the seed pass even if the
 * upload endpoint were broken — the column would be populated and every screenshot
 * would look right, while the feature itself did nothing. Going through
 * `PUT /settings/org/logo` means a `db:reset` proves the path end to end, including
 * magic-byte validation and the size cap.
 *
 * Idempotent: re-running replaces the logo with the same bytes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API = process.env.API_URL ?? "http://127.0.0.1:3000";
const SUPABASE = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const LOGO_PATH = fileURLToPath(new URL("../Logo/Trivero Logo.png", import.meta.url));

const png = readFileSync(LOGO_PATH);
console.log(`reading ${LOGO_PATH} (${(png.length / 1024).toFixed(1)} KB)`);

// Confirm it really is a PNG before sending it — if this fails, the problem is the
// asset, not the upload.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (!png.subarray(0, 8).equals(PNG_MAGIC)) {
  console.error("That file is not a PNG. Aborting rather than uploading a mislabelled asset.");
  process.exit(1);
}

const login = async (email) => {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`login failed for ${email}: ${JSON.stringify(body).slice(0, 120)}`);
  return body.access_token;
};

const token = await login("owner@demo.test");

const res = await fetch(`${API}/api/v1/settings/org/logo`, {
  method: "PUT",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ dataUri: `data:image/png;base64,${png.toString("base64")}` }),
});

const body = await res.json();

if (!res.ok) {
  console.error(`upload failed (${res.status}): ${body?.error?.message ?? "unknown"}`);
  process.exit(1);
}

console.log(`uploaded: ${body.data.mime}, ${body.data.bytes} bytes stored`);
console.log("logo seeded — the sidebar, login screen and invoice PDF all read this value");
