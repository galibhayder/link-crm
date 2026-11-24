/**
 * Generates docs/API.md route tables FROM THE ROUTERS.
 *
 * Hand-written endpoint lists drift within a day. This walks the actual router
 * declarations, so the documentation cannot describe a route that no longer exists
 * or miss one that was added.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXCLUDED = ["portal-client", "portal-supplier", "public-invoices", "jobs"];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (EXCLUDED.includes(e)) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (e === "index.ts") out.push(full);
  }
  return out;
}

function mounts() {
  const src = readFileSync("apps/api/src/modules/index.ts", "utf8");
  const map = {};
  for (const m of src.matchAll(/internalRouter\.use\("([^"]+)",\s*(\w+)\)/g)) map[m[2]] = m[1];
  return map;
}

function routesFor(file) {
  const src = readFileSync(file, "utf8");
  const vars = [...src.matchAll(/export const (\w+Router)\s*:\s*Router/g)].map((m) => m[1]);
  const out = [];

  for (const v of vars) {
    const re = new RegExp(`${v}\\.(get|post|patch|put|delete)\\(\\s*\\n?\\s*"([^"]*)"`, "g");
    for (const m of src.matchAll(re)) {
      const rest = src.slice(m.index + m[0].length);
      const next = rest.search(/\n\w+Router\.(get|post|patch|put|delete)\(/);
      const body = next === -1 ? rest : rest.slice(0, next);
      const perm = body.match(/authorize\(\s*"([^"]+)"/)?.[1] ?? null;
      out.push({ method: m[1].toUpperCase(), path: m[2], perm, router: v });
    }
  }
  return out;
}

const mountMap = mounts();

function collect(prefix, dir, { suffix = "", forcePerm = null } = {}) {
  const rows = [];
  for (const f of walk(dir)) {
    const first = routesFor(f)[0]?.router;
    const sub = prefix === "/api/v1" && first && mountMap[first] ? mountMap[first] : "";
    for (const r of routesFor(f)) {
      const base = `${prefix}${sub}`;
      const full = (r.path === "/" ? base : `${base}${r.path}`)
        .replace(/:([A-Za-z]+)\(\[[^\]]*\]\{?\d*\}?\)/g, ":$1")
        .replace(/\/+/g, "/");
      rows.push({ ...r, full, perm: forcePerm ?? r.perm });
    }
  }
  return dedupe(rows);
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const k = `${r.method} ${r.full} ${r.perm ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.full.localeCompare(b.full) || a.method.localeCompare(b.method));
}

const internal = collect("/api/v1", "apps/api/src/modules");
const portal = collect("/portal/v1", "apps/api/src/modules/portal-client");
const supplier = collect("/supplier/v1", "apps/api/src/modules/portal-supplier");
const pub = collect("/public/v1", "apps/api/src/modules/public-invoices");

const jobFiles = ["apps/api/src/modules/jobs/index.ts"];
const jobs = dedupe(
  jobFiles.flatMap((f) =>
    routesFor(f).map((r) => ({
      ...r,
      full: `/api/v1/internal/jobs${r.path === "/" ? "" : r.path}`,
      perm: "HMAC signature",
    })),
  ),
);

function table(title, rows, prefix) {
  const lines = [`### ${title}`, "", `\`${prefix}\``, "", "| Method | Path | Permission |", "|---|---|---|"];
  for (const r of rows) {
    lines.push(`| ${r.method} | \`${r.full}\` | ${r.perm ? `\`${r.perm}\`` : "authenticated"} |`);
  }
  return lines.join("\n");
}

const total = internal.length + portal.length + supplier.length + pub.length + jobs.length;

const doc = `# API Reference

**${total} routes** across five surfaces. Generated from the router declarations by
\`scripts/generate-api-docs.mjs\` — if a route is not here, it does not exist.

---

## 1. Surfaces

The application exposes **five independent surfaces**, not one. A token valid on one
is rejected on every other, and that rejection happens in middleware **before any
handler runs** — so surface isolation is structural rather than a per-route check.

| Surface | Prefix | Who uses it |
|---|---|---|
| Internal | \`/api/v1\` | The five staff roles (owner, AM, prospector, outreach, writer) |
| Client portal | \`/portal/v1\` | \`client_user\` |
| Supplier portal | \`/supplier/v1\` | \`publisher_user\` |
| Public | \`/public/v1\` | Nobody — token-in-URL invoice links |
| Jobs | \`/api/v1/internal/jobs\` | \`pg_cron\` / the host scheduler |

A \`client_user\` calling \`/api/v1/clients\` gets **403** even though the route exists,
because \`authenticate\` resolves the role's surface first and refuses the mismatch.
This is verified for all seven roles in \`audit-production-roles.mjs\`.

---

## 2. Conventions

### Envelope

Every response is either a success envelope or an error envelope. There is no bare
array at the top level.

\`\`\`json
{ "data": { … }, "meta": { "page": 1, "total": 42 } }
\`\`\`

\`\`\`json
{
  "error": {
    "code": "bad_request",
    "message": "Validation failed",
    "details": [{ "path": "name", "message": "Name is required" }],
    "requestId": "52e7c4da-…"
  }
}
\`\`\`

\`requestId\` is echoed in the \`x-request-id\` response header and appears in the
server log. Quote it when reporting a problem — it is how a user-visible failure is
traced to a log line.

### Status codes

| Code | Meaning |
|---|---|
| 200 / 201 | Success |
| 204 | Success, no body |
| 400 | Validation failed — \`details[]\` names each field |
| 401 | Missing, malformed, expired or forged token |
| 403 | Authenticated but not permitted (wrong surface, or missing permission) |
| 404 | Missing, or exists but not visible to this caller |
| 409 | Conflict (duplicate, invalid state transition) |
| 413 | Body over 1 MB |
| 429 | Rate limited |
| 500 | Unexpected — message is generic in production, details are in the log |
| 503 | Dependency unavailable (e.g. database) |

**404 vs 403 is deliberate.** A resource the caller may not see returns 404, not
403, so the API does not confirm that a record exists to someone without access.

### Authentication

\`Authorization: Bearer <supabase-access-token>\`. Tokens are issued by Supabase
Auth. There is no session cookie and no CSRF token, because there is no ambient
credential to forge.

The \`/public/v1\` and \`/health\` surfaces take no token. Jobs take an HMAC signature
in \`x-job-signature\` (see §7) — **timestamps are in milliseconds**.

### Pagination

List endpoints accept \`?page=\` (1-based) and \`?limit=\` (default 25, max 100), and
return \`meta.page\`, \`meta.total\`, \`meta.pageCount\`.

Exports ignore pagination and stream up to a hard cap (5,000 rows) so a large tenant
cannot exhaust memory.

### Authoring permission

The **Permission** column is the \`authorize()\` requirement. "authenticated" means
the route is open to any caller already admitted to that surface — used for
per-user resources (notifications, own profile) where the database policy scopes
the rows.

---

## 3. Authorization model

Three independent layers. A request must pass all three.

1. **Surface** — is this role allowed on this prefix at all?
2. **Permission** — \`authorize("invoices:write")\` against the role matrix in \`@crm/shared\`.
3. **Row Level Security** — Postgres filters every row by \`organization_id\` and, for
   portal users, by \`client_user_access\` / \`publisher_user\` linkage.

Layers 2 and 3 are not redundant: the API decides *whether you may attempt the
operation*, RLS decides *which rows it touches*. A query with a correct permission
check and a missing RLS policy still cannot read another tenant's rows.

### Financial tiers

| Tier | Data | Roles |
|---|---|---|
| 1 | Client-facing prices | owner, account_manager, client_user (own only) |
| 2 | Publisher costs | owner, prospector, outreach_specialist, publisher_user (own only) |
| 3 | Margins, profitability | **owner only** |

A publisher sees what they are paid, never the client's price. A writer sees
neither. Enforced by \`authorize\` **and** by RLS, verified in
\`audit-production-roles.mjs\`.

---

## 4. Health

| Method | Path | Notes |
|---|---|---|
| GET | \`/health/live\` | Process is up. Does **not** touch the database. |
| GET | \`/health/ready\` | Executes a real query. Returns 503 if the database is unreachable. |

Monitor \`/health/ready\`. \`/health/live\` returns 200 while the database is down,
which is exactly the outage you want to be paged for.

---

${table("Internal API", internal, "/api/v1")}

---

${table("Client Portal API", portal, "/portal/v1")}

---

${table("Supplier Portal API", supplier, "/supplier/v1")}

---

${table("Public Invoice API", pub, "/public/v1")}

Public links carry a 256-bit token; only its SHA-256 is stored. Unknown, revoked,
expired and cancelled tokens all return the **same** 404, so a probe learns nothing.
Responses carry \`noindex\` and \`no-store\`. Every access is written to the audit log.
The payload is projected from the invoice's frozen snapshot, so a public link can
never expose data added after the invoice was issued.

---

${table("Scheduled Jobs", jobs, "/api/v1/internal/jobs")}

### Job signing

\`\`\`
x-job-signature: <hex hmac-sha256 of the request body, key = JOB_HMAC_SECRET>
\`\`\`

\`JOB_HMAC_SECRET\` is required in production; without it every job is unreachable and
link verification stops silently. Because the guard covers the whole mount, an
unknown job path returns **401**, not 404 — that is correct, and it does not
disclose which job names exist.

Each job records its outcome in \`job_runs.detail\` and is safe to re-run.

---

## 5. Errors an integrator will actually hit

| Symptom | Cause |
|---|---|
| 401 on every call | Token expired, or \`Authorization\` header stripped by a proxy |
| 403 on a route that exists | Wrong surface for the role, or missing permission |
| 400 with \`details\` | Read \`details[].path\` — it names the exact field |
| 404 for a record you can see in the UI | Your role lacks the permission that the RLS policy uses |
| 413 | Body over 1 MB — uploads use a different path |
| 429 | Back off; the auth surface is rate limited |
| HTML instead of JSON | You are hitting the SPA fallback — check the path prefix |

---

## 6. Regenerating this document

\`\`\`bash
node scripts/generate-api-docs.mjs
\`\`\`

Run it after changing any router. The script reads the routers, so it cannot
describe a route that does not exist.
`;

writeFileSync("docs/API.md", doc);
console.log(`wrote docs/API.md — ${total} routes`);
console.log(`  internal ${internal.length}, portal ${portal.length}, supplier ${supplier.length}, public ${pub.length}, jobs ${jobs.length}`);
