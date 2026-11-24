/**
 * Proves the bundled migration file is a faithful concatenation.
 *
 * `supabase db reset` already proves each migration applies cleanly on a real
 * Supabase stack, in order, with the real `auth` schema present. So the only NEW
 * risk the bundle introduces is the concatenation itself:
 *
 *   - a section missing, duplicated or out of order,
 *   - a file truncated or altered,
 *   - statements merging because a file does not end with a terminator.
 *
 * Attempting to REPLAY the bundle against a bare Postgres database does not work
 * and is not attempted: migrations reference `auth.jwt()`, `auth.users.email_confirmed_at`
 * and other objects only Supabase creates. Standing those up would be simulating
 * Supabase, and every failure would be the simulation's fault rather than the
 * bundle's. The byte comparison below proves what replaying would have.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BUNDLE = "dist-migrations/apply-all.sql";
const bundle = readFileSync(BUNDLE, "utf8");

const tracked = execFileSync("git", ["ls-files", "--", "supabase/migrations"], { encoding: "utf8" })
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean)
  .sort();

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
console.log(`1. every tracked migration appears exactly once (${tracked.length} expected)`);
// ---------------------------------------------------------------------------
const missing = [];
const duplicated = [];
for (const path of tracked) {
  const name = path.split("/").pop();
  const count = bundle.split(`-- ${name}\n`).length - 1;
  if (count === 0) missing.push(name);
  else if (count > 1) duplicated.push(`${name} x${count}`);
}
check("none missing", missing.length === 0, missing.join(", "));
check("none duplicated", duplicated.length === 0, duplicated.join(", "));

// ---------------------------------------------------------------------------
console.log("\n2. sections ascend through the file in filename order");
// ---------------------------------------------------------------------------
const positions = tracked.map((path) => ({
  name: path.split("/").pop(),
  at: bundle.indexOf(`-- ${path.split("/").pop()}\n`),
}));
const outOfOrder = positions.filter((p, i) => i > 0 && positions[i - 1].at >= p.at);
check("order preserved", outOfOrder.length === 0, outOfOrder.map((p) => p.name).join(", "));

// ---------------------------------------------------------------------------
console.log("\n3. every section body matches its source byte-for-byte");
// ---------------------------------------------------------------------------
const HEADER_RE = /^-- ={75}\n-- (.+?)\n-- ={75}\n/gm;
const sections = [...bundle.matchAll(HEADER_RE)];
const mismatched = [];

for (let i = 0; i < sections.length; i += 1) {
  const name = sections[i][1];
  const from = sections[i].index + sections[i][0].length;
  const to = i + 1 < sections.length ? sections[i + 1].index : bundle.length;
  const body = bundle.slice(from, to).replace(/\n+$/, "");

  const source = tracked.find((p) => p.endsWith(name));
  if (!source) {
    mismatched.push(`${name}: not a tracked migration`);
    continue;
  }
  if (body !== readFileSync(source, "utf8").trimEnd()) mismatched.push(name);
}
check(`all ${sections.length} bodies identical to source`, mismatched.length === 0, mismatched.join(", "));

// ---------------------------------------------------------------------------
console.log("\n4. no statement can merge across a section boundary");
// ---------------------------------------------------------------------------
// A file ending mid-statement would absorb the next file's opening line, and the
// resulting error would point at a plausible but wrong place.
const unterminated = tracked.filter((path) => {
  const tail = readFileSync(path, "utf8").trimEnd();
  return !(tail.endsWith(";") || tail.endsWith("$$"));
});
check("every source file ends with ';' or '$$'", unterminated.length === 0, unterminated.join(", "));

// ---------------------------------------------------------------------------
console.log("\n5. the preamble before the first section contains no SQL");
// ---------------------------------------------------------------------------
const firstAt = positions[0].at;
const preamble = bundle.slice(0, firstAt);
// Strip block comments, then look for anything executable left over.
const executable = preamble.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
check("preamble is comments only", executable.length === 0, `${executable.length} chars of SQL`);

// ---------------------------------------------------------------------------
const lines = bundle.split("\n").length;
console.log(`\nbundle: ${(readFileSync(BUNDLE).length / 1024).toFixed(0)} KB, ${lines} lines, ${sections.length} sections`);
console.log(`${failures === 0 ? "PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
