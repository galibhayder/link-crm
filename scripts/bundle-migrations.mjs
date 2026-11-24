/**
 * BUNDLES THE MIGRATIONS INTO ONE PASTABLE FILE.
 *
 * Two problems this solves for a hosted project that has never been migrated:
 *
 * 1. THIRTY-TWO FILES IS NOT A STEP A PERSON SHOULD PERFORM BY HAND. Missing one
 *    leaves a schema that looks fine until a specific screen 500s.
 *
 * 2. `supabase db push` CANNOT BE USED HERE. It consults
 *    `supabase_migrations.schema_migrations` and skips anything listed. A project
 *    cloned from another one (a restore, a template, this very dev database) can
 *    already list versions it does not actually have — push then applies NOTHING
 *    and reports success. Verified locally: 32 tracked migrations all present in
 *    the history table, so push would apply zero of them.
 *
 * Only TRACKED migrations are included. An uncommitted one would put the hosted
 * schema ahead of what the deployed code expects — the failure would be a missing
 * column at runtime, not a migration error.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const OUT = "dist-migrations";
const FILE = `${OUT}/apply-all.sql`;

const tracked = execFileSync("git", ["ls-files", "--", "supabase/migrations"], { encoding: "utf8" })
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean)
  .sort();

if (tracked.length === 0) {
  console.error("No tracked migrations found. Run from the repo root.");
  process.exit(1);
}

const parts = [];
const included = [];

for (const path of tracked) {
  const name = path.split("/").pop();
  const sql = readFileSync(path, "utf8");

  // Section header carrying the filename, so an error in the SQL editor still
  // tells the operator which migration it came from.
  parts.push(
    `-- ===========================================================================\n` +
      `-- ${name}\n` +
      `-- ===========================================================================\n`,
  );
  parts.push(sql.trimEnd());
  parts.push("\n\n");
  included.push(name);
}

const header = `-- ===========================================================================
-- TRIVERO MARKETING CRM — ${included.length} MIGRATIONS, IN ORDER
--
-- Paste this ENTIRE file into the Supabase SQL editor and run it once.
--
-- ORDER IS LOAD-BEARING. Several migrations deliberately FIX earlier ones
-- (0005, 0008, 0011, 0016, 0025, 0027, 0031). This file is concatenated in
-- filename order for that reason; do not run the sections out of sequence.
--
-- BEFORE RUNNING, in Database -> Extensions, enable:
--   pg_cron    pg_net    pgcrypto    citext    pg_trgm
--
-- pg_cron and pg_net cannot self-enable on a hosted project. Migration 0001 runs
-- \`create extension if not exists\`, which FAILS for those two unless they are
-- already on — and that aborts 0001, so nothing after it applies.
--
-- Expected result: "Success. No rows returned". The migrations end with a
-- self-test block that raises an exception if the schema is wrong, so a silent
-- pass is a real pass.
--
-- Migrations included (${included.length}):
${included.map((n, i) => `--   ${String(i + 1).padStart(2, "0")}. ${n}`).join("\n")}
-- ===========================================================================

`;

mkdirSync(OUT, { recursive: true });
writeFileSync(FILE, header + parts.join(""));

const bytes = readFileSync(FILE).length;
console.log(`wrote ${FILE}`);
console.log(`  ${included.length} migrations, ${(bytes / 1024).toFixed(0)} KB`);
console.log(`  first: ${included[0]}`);
console.log(`  last:  ${included.at(-1)}`);
