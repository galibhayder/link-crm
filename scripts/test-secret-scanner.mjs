/**
 * SELF-TEST for scan-committed-secrets.mjs.
 *
 * A secret scanner that never fires is worse than no scanner, because it reads as
 * a passing check. This feeds it known-bad and known-safe lines and asserts both
 * directions, so tightening a rule cannot silently blind it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d });
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

// A throwaway git repo so the scanner's `git ls-files` has something to read.
const dir = mkdtempSync(join(tmpdir(), "secret-scan-"));
const run = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
run(["init", "-q"]);
run(["config", "user.email", "t@example.test"]);
run(["config", "user.name", "t"]);

const SCANNER = join(process.cwd(), "scripts", "scan-committed-secrets.mjs");

function scan(content) {
  // ONE file per probe, removed afterwards. Reusing a single filename let a
  // flagged line from an earlier case linger in the index and fail every later
  // case — the test was measuring its own leftovers.
  const file = `probe-${Math.random().toString(36).slice(2)}.txt`;
  const full = join(dir, file);
  writeFileSync(full, content);
  run(["add", "-f", file]);
  const r = spawnSync(process.execPath, [SCANNER], { cwd: dir, encoding: "utf8" });
  run(["rm", "-q", "--cached", file]);
  rmSync(full, { force: true });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

console.log("1. real credentials MUST be caught");

// A hosted Supabase service-role key: same shape, different issuer.
const hostedPayload = Buffer.from(
  JSON.stringify({ iss: "supabase", ref: "abcdefghijklmnop", role: "service_role", exp: 1983812996 }),
).toString("base64url");
const hostedKey = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${hostedPayload}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;

const MUST_FAIL = {
  "hosted service_role JWT": `SUPABASE_SERVICE_ROLE_KEY="${hostedKey}"`,
  "private key": "-----BEGIN RSA PRIVATE KEY-----",
  "aws key": "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
  "github token": "token: ghp_1234567890abcdefghijklmnopqrstuvwxyz",
  "stripe live": "key = sk_live_51H8xYzAbCdEfGhIjKlMn",
  "postgres url with password": "postgres://admin:Sup3rS3cretPassw0rd@db.host.co:5432/postgres",
  "assigned secret": 'JOB_HMAC_SECRET="aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW"',
};

for (const [label, content] of Object.entries(MUST_FAIL)) {
  const r = scan(content);
  check(`catches ${label}`, r.code === 1, r.code === 0 ? "NOT DETECTED" : "");
}

console.log("\n2. safe content MUST NOT be flagged");

const MUST_PASS = {
  "local demo service key": `const SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"`,
  "generated token expression": "const token = randomBytes(32).toString(\"base64url\");",
  "env reference": "const key = process.env.SUPABASE_SERVICE_ROLE_KEY;",
  "placeholder": 'JOB_HMAC_SECRET="your-secret-here"',
  "comment": "// Set SUPABASE_SERVICE_ROLE_KEY before starting",
  "ordinary prose": "The service role key bypasses RLS, so it is server-only.",
};

for (const [label, content] of Object.entries(MUST_PASS)) {
  const r = scan(content);
  check(`ignores ${label}`, r.code === 0, r.code === 1 ? "FALSE POSITIVE" : "");
}

// ---------------------------------------------------------------------------
rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.n} — ${f.d}`);
  process.exit(1);
}
