/**
 * APPLICATION ERROR HANDLING AUDIT.
 *
 * The question is not "does a bad request fail" — it is "does a bad request fail in
 * a way an operator can act on, without leaking anything?" Three properties per
 * case: the right status, a stable machine code, and no internal detail.
 */
const API = process.env.API_URL ?? "http://127.0.0.1:3000";
const SUPABASE = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d });
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

const token = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "content-type": "application/json" },
  body: JSON.stringify({ email: "owner@demo.test", password: "password123" }),
})
  .then((r) => r.json())
  .then((b) => b.access_token);

async function call(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, text, headers: res.headers };
}

/** No response may contain a stack, a driver message, or a secret. */
function assertClean(label, r) {
  const blob = r.text.toLowerCase();
  check(`${label}: no stack trace`, !blob.includes("at object.") && !blob.includes("node_modules"), "");
  check(`${label}: no driver internals`, !/relation "|pg_|postgrest|sqlstate/.test(blob), "");
  check(`${label}: no secret material`, !blob.includes("service_role") && !blob.includes("supabase_service"), "");
  check(`${label}: carries a request id`, Boolean(r.headers.get("x-request-id")), r.headers.get("x-request-id"));
}

// ---------------------------------------------------------------------------
console.log("1. validation errors are field-addressable");
// ---------------------------------------------------------------------------
{
  const r = await call("/api/v1/clients", { method: "POST", body: JSON.stringify({ name: "" }) });
  check("an empty required field is a 400", r.status === 400, String(r.status));
  check("the code is stable", r.body?.error?.code === "bad_request", r.body?.error?.code);
  const details = r.body?.error?.details;
  check("the failing field is named", JSON.stringify(details ?? "").includes("name"), JSON.stringify(details).slice(0, 120));
  assertClean("validation error", r);
}

// ---------------------------------------------------------------------------
console.log("\n2. a missing record is an honest 404");
// ---------------------------------------------------------------------------
{
  const r = await call("/api/v1/clients/00000000-0000-4000-8000-000000000000");
  check("an unknown id is a 404", r.status === 404, String(r.status));
  check("it does not distinguish unknown from forbidden", r.body?.error?.code === "not_found", r.body?.error?.code);
  assertClean("404", r);
}

// ---------------------------------------------------------------------------
console.log("\n3. a malformed uuid is rejected before the database");
// ---------------------------------------------------------------------------
{
  const r = await call("/api/v1/clients/not-a-uuid");
  // Either 400 (validated) or 404 is acceptable; a 500 would mean the id reached
  // Postgres and blew up there.
  check("a malformed uuid is not a 500", r.status === 400 || r.status === 404, String(r.status));
  assertClean("malformed uuid", r);
}

// ---------------------------------------------------------------------------
console.log("\n4. malformed JSON is a clean 400");
// ---------------------------------------------------------------------------
{
  const r = await call("/api/v1/clients", { method: "POST", body: "{ this is not json" });
  check("broken JSON is a 400", r.status === 400, String(r.status));
  assertClean("broken JSON", r);
}

// ---------------------------------------------------------------------------
console.log("\n5. an oversized body is refused, not buffered forever");
// ---------------------------------------------------------------------------
{
  const huge = JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) });
  const r = await call("/api/v1/clients", { method: "POST", body: huge });
  check("a 2MB body is refused", r.status === 413 || r.status === 400, String(r.status));
  assertClean("oversized body", r);
}

// ---------------------------------------------------------------------------
console.log("\n6. wrong HTTP methods and unknown routes");
// ---------------------------------------------------------------------------
{
  const badMethod = await call("/api/v1/clients", { method: "PATCH", body: "{}" });
  check("PATCH on a collection is rejected", badMethod.status === 404 || badMethod.status === 405, String(badMethod.status));

  const unknown = await call("/api/v1/definitely-not-a-route");
  check("an unknown route is a JSON 404", unknown.status === 404, String(unknown.status));
  check("...with a not_found code", unknown.body?.error?.code === "not_found", unknown.body?.error?.code);
  assertClean("unknown route", unknown);
}

// ---------------------------------------------------------------------------
console.log("\n7. a database failure degrades rather than crashing");
// ---------------------------------------------------------------------------
{
  // A query that cannot succeed must produce a 4xx/5xx JSON body and leave the
  // process alive. If the server died here, every subsequent check would fail.
  const r = await call("/api/v1/clients?limit=not-a-number");
  check("a bad query parameter is handled", r.status >= 400 && r.status < 600, String(r.status));

  const stillAlive = await call("/health/live");
  check("the process is still serving after an error", stillAlive.status === 200, String(stillAlive.status));
}

// ---------------------------------------------------------------------------
console.log("\n8. rate limiting does not turn into an outage");
// ---------------------------------------------------------------------------
{
  // The auth surface is rate limited. Firing a burst must yield 429s, not 500s, and
  // must not lock the process up.
  const calls = await Promise.all(
    Array.from({ length: 12 }, () =>
      fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: ANON, "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@demo.test", password: "wrong" }),
      }).then((res) => res.status),
    ),
  );
  const serverErrors = calls.filter((s) => s >= 500);
  check("a burst of bad logins produces no 5xx", serverErrors.length === 0, `${serverErrors.length} server error(s)`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.n} — ${f.d}`);
  process.exit(1);
}
