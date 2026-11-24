/**
 * PRE-COMMIT SECRET SCAN.
 *
 * Checks the CONTENT of what git is about to commit, not just file names. A real
 * key pasted into a test script, a doc, or a compose file is just as leaked as one
 * in `.env` — and path-based ignores would never catch it.
 *
 * No network, no dependencies. Exits non-zero listing what it found.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|xlsx)$/i;

// Patterns that indicate a REAL credential rather than a placeholder.
const RULES = [
  {
    name: "Supabase service-role JWT (role=service_role in the payload)",
    // A JWT whose base64 payload decodes to include service_role. The anon key is
    // public by design and ships in the bundle, so it is deliberately NOT flagged.
    //
    // EXCEPTION: the canonical LOCAL demo key. Supabase CLI issues the same
    // `iss: supabase-demo` key pair to every developer machine, signed with a
    // publicly-documented JWT secret. It can only reach 127.0.0.1:54321, so it is
    // not a credential — flagging it would train people to ignore this scanner.
    // The test is on the ISSUER, not on a file path, so a real hosted key pasted
    // anywhere is still caught.
    test: (line) => {
      const m = line.match(/eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/);
      if (!m) return false;
      try {
        const payload = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
        if (!String(payload.role ?? "").includes("service_role")) return false;
        if (payload.iss === "supabase-demo") return false;
        return true;
      } catch {
        return false;
      }
    },
  },
  { name: "Private key block", test: (l) => /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/.test(l) },
  { name: "AWS access key id", test: (l) => /\bAKIA[0-9A-Z]{16}\b/.test(l) },
  { name: "GitHub token", test: (l) => /\bgh[pousr]_[A-Za-z0-9]{36,}\b/.test(l) },
  { name: "Stripe live key", test: (l) => /\bsk_live_[A-Za-z0-9]{20,}\b/.test(l) },
  { name: "SendGrid key", test: (l) => /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/.test(l) },
  { name: "Resend key", test: (l) => /\bre_[A-Za-z0-9]{20,}\b/.test(l) },
  {
    name: "Postgres connection string with credentials",
    // `postgres://user:pass@host` where pass is non-trivial.
    test: (l) => /postgres(ql)?:\/\/[^:\s]+:(?!pass(word)?|secret|your)[^@\s]{8,}@/i.test(l),
  },
  {
    name: "Assigned high-entropy secret",
    // KEY=value where the NAME looks secret and the VALUE is long and random.
    // Placeholders (your-, xxx, <...>, changeme) are excluded so docs stay clean.
    test: (l) => {
      const m = l.match(/([A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"'#]+)/i);
      if (!m) return false;
      const value = m[2];
      if (/^(your|xxx+|\.\.\.|<|changeme|replace|example|placeholder|\$\{)/i.test(value)) return false;
      // A code expression is not a literal secret. `const token = randomBytes(32)
      // .toString("base64url")` was flagged before this guard existed — a value
      // containing calls, member access or parentheses is an expression.
      if (/[(){}[\]]/.test(value) || /\.\w+\(/.test(l) || /\b(randomBytes|createHash|uuid|nanoid)\b/.test(l)) {
        return false;
      }
      if (value.length < 20) return false;
      // Mix of upper, lower and digits — a real random secret rather than a word.
      return /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value);
    },
  },
];

/**
 * Lines that legitimately contain the shape but are not secrets.
 *
 * These must stay NARROW. The first version allowed any line whose first
 * non-space character was an asterisk (meant for JSDoc continuation lines), and
 * allowed the word "example" anywhere — which between them suppressed a PEM
 * header and the AWS documentation key, because EXAMPLE is a substring of it.
 * test-secret-scanner.mjs exists to keep this honest: it feeds known-bad lines
 * and fails if any slip through.
 *
 * (Note: a regex literal must not be quoted verbatim in this block comment. The
 * first attempt included one ending in star-slash, which closed the comment
 * early and made the whole file a syntax error.)
 */
const ALLOW = [
  /process\.env\./,
  // Line comments only. Matching an asterisk anywhere swallowed PEM headers.
  /^\s*\/\//,
  // SQL/Lua comments: `-- ` followed by prose. Must require the space and a word,
  // or it matches the dashes of `-----BEGIN RSA PRIVATE KEY-----`.
  /^\s*--\s+[A-Za-z]/,
  // A bare documentation reference, not an assignment:
  //   * Set SUPABASE_SERVICE_ROLE_KEY before starting
  // An asterisk at line start AND no assignment on the line.
  /^\s*\*\s+[^=:]*$/,
  // An explicit TODO marker pointing at the variable rather than setting it.
  /\b(changeme|change-me)\b/i,
  /\bredact(ed)?\b/i,
  // Placeholder MARKERS, not the word "example" anywhere in the line: the AWS
  // documentation key AKIAIOSFODNN7EXAMPLE is a valid shape and must be caught.
  /\b(placeholder|dummy|fake|sample)\b/i,
  /\byour[-_ ]?(secret|token|key|password)\b/i,
];

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    // The scanner's own self-test is BY DEFINITION a file full of things that look
    // like credentials. Excluding it by exact path (not by pattern) means a real
    // secret in any other test file is still caught.
    .filter((f) => f !== "scripts/test-secret-scanner.mjs");
}

const findings = [];
let scanned = 0;

for (const file of trackedFiles()) {
  if (SKIP_EXT.test(file)) continue;
  let stat;
  try {
    stat = statSync(file);
  } catch {
    continue; // deleted but still in the index
  }
  if (stat.size > 2 * 1024 * 1024) continue;

  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (content.includes("\u0000")) continue; // binary

  scanned += 1;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length > 4000) continue;
    if (ALLOW.some((re) => re.test(line))) continue;

    for (const rule of RULES) {
      if (!rule.test(line)) continue;
      findings.push({ file, line: i + 1, rule: rule.name, preview: line.trim().slice(0, 90) });
      break;
    }
  }
}

console.log(`Scanned ${scanned} text file(s) staged or untracked.\n`);

if (findings.length === 0) {
  console.log("✓ No credentials found.");
  process.exit(0);
}

console.error(`✗ ${findings.length} possible credential(s):\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`    ${f.rule}`);
  console.error(`    ${f.preview}\n`);
}
console.error("Remove the value, rotate it if it was real, and re-run.");
process.exit(1);
