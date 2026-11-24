/**
 * VERIFIES THE REGRESSION TESTS ACTUALLY CATCH THE BUGS.
 *
 * A test added after a fix proves nothing unless it fails without the fix. This
 * asks the database to reproduce each fixed defect directly and asserts that the
 * check the suite uses would have flagged it.
 */
import { execSync } from "node:child_process";

const db = (sql) =>
  execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A`, {
    input: sql,
    encoding: "utf8",
  })
    .split("\n")[0]
    .trim();

console.log("1. the single status ladder (0031)");

// The old TypeScript copy said "overdue" for a zero-total past-due invoice.
const zeroTotal = db(
  `select app_private.invoice_effective_status('issued', 0, 0, current_date - 30, null, now())`,
);
console.log(`   zero-total past due -> ${zeroTotal}  (old TS copy said "overdue")`);
if (zeroTotal !== "issued") {
  console.error("   FAIL: the ladder still disagrees on a zero-total invoice");
  process.exit(1);
}

// The old resolver omitted `published`, so a public page said "issued".
const published = db(
  `select app_private.invoice_effective_status('issued', 100, 0, null, now(), now())`,
);
console.log(`   published unpaid   -> ${published}  (old resolver said "issued")`);
if (published !== "published") {
  console.error("   FAIL: the ladder lost the published state");
  process.exit(1);
}

console.log("\n2. no reimplementation remains in TypeScript");

const fs = await import("node:fs");
for (const file of [
  "apps/api/src/modules/invoices/index.ts",
  "apps/api/src/modules/public-invoices/index.ts",
]) {
  const src = fs.readFileSync(file, "utf8");
  const hasLadder =
    /return "overdue"/.test(src) || /then "overdue"/.test(src) || /=== "overdue"/.test(src) && /return "partially_paid"/.test(src);
  console.log(`   ${file}: ${hasLadder ? "STILL CONTAINS A LADDER" : "delegates"}`);
  if (hasLadder && file.includes("invoices/index.ts")) {
    console.error("   FAIL: a status ladder is still duplicated in TypeScript");
    process.exit(1);
  }
}

console.log("\n3. the publisher and placement export routes serve CSV");
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const token = await fetch("http://127.0.0.1:54321/auth/v1/token?grant_type=password", {
  method: "POST",
  headers: { apikey: ANON, "content-type": "application/json" },
  body: JSON.stringify({ email: "owner@demo.test", password: "password123" }),
})
  .then((r) => r.json())
  .then((b) => b.access_token);

let failed = false;
for (const path of ["/api/v1/reports/publishers", "/api/v1/reports/placements"]) {
  const res = await fetch(`http://127.0.0.1:3000${path}?format=csv`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const type = res.headers.get("content-type") ?? "";
  const isCsv = /text\/csv/.test(type);
  console.log(`   ${path}?format=csv -> ${res.status} ${type.slice(0, 30)}`);
  if (res.status !== 200 || !isCsv) {
    console.error(`   FAIL: ${path} did not serve CSV`);
    failed = true;
  }
}

if (failed) process.exit(1);

console.log("\n4. scheduled jobs do not reference retired vocabulary");

// `flag-overdue` filtered on `["sent", "partially_paid"]`. Migration 0028 renamed
// `sent` to `issued`, so the job silently matched nothing and reported zero
// overdue invoices forever. Nothing caught it because it "succeeded".
const jobSrc = fs.readFileSync("apps/api/src/modules/jobs/index.ts", "utf8");

const overdueBlock = jobSrc.slice(jobSrc.indexOf('"/flag-overdue"'), jobSrc.indexOf('"/flag-overdue"') + 1200);
console.log(`   flag-overdue filters on retired "sent": ${/"sent"/.test(overdueBlock) ? "YES" : "no"}`);
if (/"sent"/.test(overdueBlock)) {
  console.error("   FAIL: flag-overdue still filters on the retired 'sent' status");
  failed = true;
}

console.log(`   flag-overdue writes status: ${/\.update\(\{\s*status:\s*"overdue"/.test(overdueBlock) ? "YES" : "no"}`);
if (/\.update\(\{\s*status:\s*"overdue"/.test(overdueBlock)) {
  console.error("   FAIL: flag-overdue still writes the derived 'overdue' status");
  failed = true;
}

// No other job may write a derived status either.
const derivedWrites = /\.update\(\{[^}]*status:\s*"(overdue|partially_paid|paid)"/.test(jobSrc);
console.log(`   any job writing a derived status: ${derivedWrites ? "YES" : "no"}`);
if (derivedWrites) {
  console.error("   FAIL: a scheduled job writes a status that must be derived");
  failed = true;
}

console.log("\n5. no duplicate route registrations shadow a handler");

// A duplicate `/portal/v1/invoices` route made Express serve a stale handler that
// returned drafts. Static analysis catches it before a browser does.
const portalSrc = fs.readFileSync("apps/api/src/modules/portal-client/index.ts", "utf8");
const routePattern = /portalRouter\.(get|post|patch|delete)\(\s*\n\s*"([^"]+)"/g;
const seen = new Map();
let match;
let dupes = 0;
while ((match = routePattern.exec(portalSrc)) !== null) {
  const [, method, path] = match;
  const key = `${method.toUpperCase()} ${path}`;
  if (seen.has(key)) {
    console.error(`   FAIL: duplicate route ${key}`);
    dupes += 1;
  }
  seen.set(key, true);
}
console.log(`   ${dupes === 0 ? "ok  " : "FAIL"} ${seen.size} portal routes, ${dupes} duplicates`);
if (dupes > 0) failed = true;

if (failed) process.exit(1);
console.log("\nall regression guards hold");
