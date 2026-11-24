/**
 * INTERACTIVE SETUP for verify-auth-claims.
 *
 * The manual route is error-prone: a key contains $, & and ( ), every one of
 * which PowerShell treats as syntax, and a single unbalanced quote leaves the
 * shell waiting with no prompt. Typing the values at a Read-Host prompt removes
 * the parsing step entirely — whatever is typed is taken literally.
 *
 * Writes nothing to disk. Sets the variables for this session only, then runs
 * the check in the same process.
 */
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";

const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log("Paste each value and press Enter. Nothing is saved to disk.\n");
console.log("All three are on Supabase -> Settings -> API, except the password");
console.log("which is the one you set when you added the user.\n");

const url = (await rl.question("Project URL        (https://xxxx.supabase.co) : ")).trim();
const anon = (await rl.question("Publishable key    (sb_publishable_... or eyJ...) : ")).trim();
const email = (await rl.question("Email              (galib@triveromarketing.com) : ")).trim();

// Hidden-ish: readline echoes, but there is no shell to parse it.
const password = (await rl.question("Password           (not shown in logs) : ")).trim();

rl.close();

// ---------------------------------------------------------------------------
// Validate BEFORE calling out, so a wrong paste names itself rather than
// surfacing as a confusing network error three steps later.
// ---------------------------------------------------------------------------
const problems = [];

if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(url)) {
  problems.push(
    `Project URL looks wrong: "${url}"\n` +
      "  Expected exactly https://<20 lowercase letters>.supabase.co",
  );
}
if (!/^(sb_publishable_|eyJ)/.test(anon)) {
  problems.push(
    `Publishable key looks wrong: starts "${anon.slice(0, 14)}"\n` +
      "  Expected sb_publishable_... or eyJ...\n" +
      "  If it starts sb_secret_ that is the SECRET key — do not use it here.",
  );
}
if (!email.includes("@")) problems.push(`Email looks wrong: "${email}"`);
if (password.length < 6) problems.push("Password looks too short — did it paste completely?");

if (problems.length > 0) {
  console.error("\n✗ Fix these and re-run:\n");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(2);
}

console.log(`\nChecking ${email} against ${url.replace(/\/$/, "")} ...\n`);

const result = spawnSync(process.execPath, ["scripts/verify-auth-claims.mjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    SUPABASE_URL: url,
    SUPABASE_ANON_KEY: anon,
    VERIFY_EMAIL: email,
    VERIFY_PASSWORD: password,
  },
});

process.exit(result.status ?? 1);
