# API Reference

**231 routes** across five surfaces. Generated from the router declarations by
`scripts/generate-api-docs.mjs` — if a route is not here, it does not exist.

---

## 1. Surfaces

The application exposes **five independent surfaces**, not one. A token valid on one
is rejected on every other, and that rejection happens in middleware **before any
handler runs** — so surface isolation is structural rather than a per-route check.

| Surface | Prefix | Who uses it |
|---|---|---|
| Internal | `/api/v1` | The five staff roles (owner, AM, prospector, outreach, writer) |
| Client portal | `/portal/v1` | `client_user` |
| Supplier portal | `/supplier/v1` | `publisher_user` |
| Public | `/public/v1` | Nobody — token-in-URL invoice links |
| Jobs | `/api/v1/internal/jobs` | `pg_cron` / the host scheduler |

A `client_user` calling `/api/v1/clients` gets **403** even though the route exists,
because `authenticate` resolves the role's surface first and refuses the mismatch.
This is verified for all seven roles in `audit-production-roles.mjs`.

---

## 2. Conventions

### Envelope

Every response is either a success envelope or an error envelope. There is no bare
array at the top level.

```json
{ "data": { … }, "meta": { "page": 1, "total": 42 } }
```

```json
{
  "error": {
    "code": "bad_request",
    "message": "Validation failed",
    "details": [{ "path": "name", "message": "Name is required" }],
    "requestId": "52e7c4da-…"
  }
}
```

`requestId` is echoed in the `x-request-id` response header and appears in the
server log. Quote it when reporting a problem — it is how a user-visible failure is
traced to a log line.

### Status codes

| Code | Meaning |
|---|---|
| 200 / 201 | Success |
| 204 | Success, no body |
| 400 | Validation failed — `details[]` names each field |
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

`Authorization: Bearer <supabase-access-token>`. Tokens are issued by Supabase
Auth. There is no session cookie and no CSRF token, because there is no ambient
credential to forge.

The `/public/v1` and `/health` surfaces take no token. Jobs take an HMAC signature
in `x-job-signature` (see §7) — **timestamps are in milliseconds**.

### Pagination

List endpoints accept `?page=` (1-based) and `?limit=` (default 25, max 100), and
return `meta.page`, `meta.total`, `meta.pageCount`.

Exports ignore pagination and stream up to a hard cap (5,000 rows) so a large tenant
cannot exhaust memory.

### Authoring permission

The **Permission** column is the `authorize()` requirement. "authenticated" means
the route is open to any caller already admitted to that surface — used for
per-user resources (notifications, own profile) where the database policy scopes
the rows.

---

## 3. Authorization model

Three independent layers. A request must pass all three.

1. **Surface** — is this role allowed on this prefix at all?
2. **Permission** — `authorize("invoices:write")` against the role matrix in `@crm/shared`.
3. **Row Level Security** — Postgres filters every row by `organization_id` and, for
   portal users, by `client_user_access` / `publisher_user` linkage.

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
neither. Enforced by `authorize` **and** by RLS, verified in
`audit-production-roles.mjs`.

---

## 4. Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health/live` | Process is up. Does **not** touch the database. |
| GET | `/health/ready` | Executes a real query. Returns 503 if the database is unreachable. |

Monitor `/health/ready`. `/health/live` returns 200 while the database is down,
which is exactly the outage you want to be paged for.

---

### Internal API

`/api/v1`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/v1/admin/fields` | `settings:manage` |
| POST | `/api/v1/admin/fields` | `settings:manage` |
| DELETE | `/api/v1/admin/fields/:id` | `settings:manage` |
| PATCH | `/api/v1/admin/fields/:id` | `settings:manage` |
| GET | `/api/v1/admin/ui/config` | `settings:manage` |
| PUT | `/api/v1/admin/ui/config` | `settings:manage` |
| POST | `/api/v1/admin/ui/config/reset` | `settings:manage` |
| GET | `/api/v1/admin/ui/effective` | authenticated |
| GET | `/api/v1/admin/ui/registries` | `settings:manage` |
| GET | `/api/v1/admin/views` | authenticated |
| POST | `/api/v1/admin/views` | authenticated |
| DELETE | `/api/v1/admin/views/:id` | authenticated |
| PATCH | `/api/v1/admin/views/:id` | authenticated |
| GET | `/api/v1/agency-partners` | `clients:read` |
| POST | `/api/v1/agency-partners` | `clients:write` |
| DELETE | `/api/v1/agency-partners/:id` | `clients:write` |
| GET | `/api/v1/agency-partners/:id` | `clients:read` |
| PATCH | `/api/v1/agency-partners/:id` | `clients:write` |
| POST | `/api/v1/agency-partners/:id/restore` | `clients:write` |
| GET | `/api/v1/agency-partners/export/csv` | `clients:read` |
| GET | `/api/v1/anchors/alerts` | `reports:read` |
| POST | `/api/v1/anchors/alerts` | `settings:manage` |
| DELETE | `/api/v1/anchors/alerts/:id` | `settings:manage` |
| PATCH | `/api/v1/anchors/alerts/:id` | `settings:manage` |
| GET | `/api/v1/anchors/alerts/evaluate` | `reports:read` |
| POST | `/api/v1/anchors/backfill` | `placements:write` |
| POST | `/api/v1/anchors/classify` | `placements:read` |
| GET | `/api/v1/anchors/distribution` | `reports:read` |
| GET | `/api/v1/audit` | `audit:read` |
| GET | `/api/v1/audit/entity/:entityType/:entityId` | `audit:read` |
| GET | `/api/v1/campaigns` | `campaigns:read` |
| POST | `/api/v1/campaigns` | `campaigns:write` |
| DELETE | `/api/v1/campaigns/:id` | `campaigns:write` |
| GET | `/api/v1/campaigns/:id` | `campaigns:read` |
| PATCH | `/api/v1/campaigns/:id` | `campaigns:write` |
| GET | `/api/v1/campaigns/:id/progress` | `campaigns:read` |
| GET | `/api/v1/campaigns/:id/related` | `campaigns:read` |
| POST | `/api/v1/campaigns/:id/restore` | `campaigns:write` |
| PUT | `/api/v1/campaigns/:id/targets` | `campaigns:write` |
| GET | `/api/v1/campaigns/archived/list` | `campaigns:read` |
| GET | `/api/v1/campaigns/export/csv` | `campaigns:read` |
| GET | `/api/v1/clients` | `clients:read` |
| POST | `/api/v1/clients` | `clients:write` |
| DELETE | `/api/v1/clients/:id` | `clients:write` |
| GET | `/api/v1/clients/:id` | `clients:read` |
| PATCH | `/api/v1/clients/:id` | `clients:write` |
| GET | `/api/v1/clients/:id/portal-access` | `portal_access:manage` |
| POST | `/api/v1/clients/:id/portal-access` | `portal_access:manage` |
| DELETE | `/api/v1/clients/:id/portal-access/:userId` | `portal_access:manage` |
| GET | `/api/v1/clients/:id/related` | `clients:read` |
| POST | `/api/v1/clients/:id/restore` | `clients:write` |
| GET | `/api/v1/clients/archived/list` | `clients:read` |
| GET | `/api/v1/clients/export/csv` | `clients:read` |
| GET | `/api/v1/clients/options/filters` | `clients:read` |
| GET | `/api/v1/content/briefs` | `briefs:read` |
| POST | `/api/v1/content/briefs` | `briefs:write` |
| GET | `/api/v1/content/briefs/:id` | `briefs:read` |
| PATCH | `/api/v1/content/briefs/:id` | `briefs:write` |
| GET | `/api/v1/content/drafts` | `briefs:read` |
| POST | `/api/v1/content/drafts` | `briefs:write` |
| GET | `/api/v1/content/drafts/:id` | `briefs:read` |
| POST | `/api/v1/content/drafts/:id/restore/:version` | `briefs:write` |
| GET | `/api/v1/content/drafts/:id/revisions` | `briefs:read` |
| POST | `/api/v1/content/drafts/:id/transition` | `briefs:read` |
| POST | `/api/v1/content/drafts/:id/versions` | `briefs:write` |
| GET | `/api/v1/content/drafts/:id/versions/:version` | `briefs:read` |
| GET | `/api/v1/content/my-queue` | `briefs:read` |
| DELETE | `/api/v1/content/revisions/:id` | `briefs:write` |
| GET | `/api/v1/content/summary` | `briefs:read` |
| GET | `/api/v1/costs/placements/:placementId` | `costs:read` |
| PUT | `/api/v1/costs/placements/:placementId` | `costs:write` |
| GET | `/api/v1/expenses` | `expenses:read` |
| POST | `/api/v1/expenses` | `expenses:write` |
| DELETE | `/api/v1/expenses/:id` | `expenses:write` |
| PATCH | `/api/v1/expenses/:id` | `expenses:write` |
| POST | `/api/v1/import/:entity/commit` | authenticated |
| DELETE | `/api/v1/import/:entity/jobs/:id` | authenticated |
| GET | `/api/v1/import/:entity/jobs/:id` | authenticated |
| POST | `/api/v1/import/:entity/preview` | authenticated |
| GET | `/api/v1/import/:entity/template` | authenticated |
| GET | `/api/v1/invoices` | `invoices:read` |
| POST | `/api/v1/invoices` | `invoices:write` |
| GET | `/api/v1/invoices/:id` | `invoices:read` |
| PATCH | `/api/v1/invoices/:id` | `invoices:write` |
| POST | `/api/v1/invoices/:id/cancel` | `invoices:write` |
| POST | `/api/v1/invoices/:id/duplicate` | `invoices:write` |
| POST | `/api/v1/invoices/:id/issue` | `invoices:write` |
| GET | `/api/v1/invoices/:id/pdf` | `invoices:read` |
| GET | `/api/v1/invoices/:id/preview` | `invoices:read` |
| POST | `/api/v1/invoices/:id/publish` | `invoices:share` |
| DELETE | `/api/v1/invoices/:id/share-link` | `invoices:share` |
| POST | `/api/v1/invoices/:id/share-link` | `invoices:share` |
| POST | `/api/v1/invoices/:id/unpublish` | `invoices:share` |
| GET | `/api/v1/me` | authenticated |
| GET | `/api/v1/me/permissions` | authenticated |
| GET | `/api/v1/notifications` | authenticated |
| PATCH | `/api/v1/notifications/:id/read` | authenticated |
| GET | `/api/v1/notifications/preferences` | authenticated |
| PUT | `/api/v1/notifications/preferences` | authenticated |
| POST | `/api/v1/notifications/read-all` | authenticated |
| GET | `/api/v1/notifications/unread-count` | authenticated |
| GET | `/api/v1/outreach` | `touchpoints:read` |
| POST | `/api/v1/outreach` | `touchpoints:write` |
| GET | `/api/v1/outreach/:id` | `touchpoints:read` |
| PATCH | `/api/v1/outreach/:id` | `touchpoints:write` |
| POST | `/api/v1/outreach/:id/log` | `touchpoints:write` |
| POST | `/api/v1/outreach/:id/send` | `touchpoints:write` |
| GET | `/api/v1/outreach/follow-ups` | `touchpoints:read` |
| GET | `/api/v1/outreach/prospect/:id` | `touchpoints:read` |
| GET | `/api/v1/outreach/templates` | `templates:read` |
| POST | `/api/v1/outreach/templates` | `templates:write` |
| DELETE | `/api/v1/outreach/templates/:id` | `templates:write` |
| PATCH | `/api/v1/outreach/templates/:id` | `templates:write` |
| POST | `/api/v1/outreach/templates/:id/render` | `templates:read` |
| GET | `/api/v1/payments` | `payments:read` |
| POST | `/api/v1/payments` | `payments:write` |
| DELETE | `/api/v1/payments/:id` | `payments:write` |
| GET | `/api/v1/payouts` | `payouts:read` |
| POST | `/api/v1/payouts` | `payouts:write` |
| DELETE | `/api/v1/payouts/:id` | `payouts:write` |
| GET | `/api/v1/payouts/:id` | `payouts:read` |
| PATCH | `/api/v1/payouts/:id` | `payouts:write` |
| GET | `/api/v1/placements` | `placements:read` |
| POST | `/api/v1/placements` | `placements:write` |
| DELETE | `/api/v1/placements/:id` | `placements:write` |
| GET | `/api/v1/placements/:id` | `placements:read` |
| PATCH | `/api/v1/placements/:id` | `placements:write` |
| POST | `/api/v1/placements/:id/check` | `placements:check` |
| GET | `/api/v1/placements/:id/checks` | `placements:read` |
| POST | `/api/v1/placements/:id/client-decision` | `placements:approve` |
| GET | `/api/v1/placements/:id/history` | `placements:read` |
| PATCH | `/api/v1/placements/:id/index-status` | `placements:write` |
| POST | `/api/v1/placements/:id/restore` | `placements:write` |
| POST | `/api/v1/placements/:id/transition` | `placements:write` |
| GET | `/api/v1/placements/board` | `placements:read` |
| GET | `/api/v1/placements/export/csv` | `placements:read` |
| GET | `/api/v1/placements/options/stages` | `placements:read` |
| GET | `/api/v1/pricing/placements/:placementId` | `pricing:read` |
| PUT | `/api/v1/pricing/placements/:placementId` | `pricing:write` |
| GET | `/api/v1/profile` | authenticated |
| PATCH | `/api/v1/profile` | authenticated |
| GET | `/api/v1/prospects` | `prospects:read` |
| POST | `/api/v1/prospects` | `prospects:write` |
| DELETE | `/api/v1/prospects/:id` | `prospects:write` |
| GET | `/api/v1/prospects/:id` | `prospects:read` |
| PATCH | `/api/v1/prospects/:id` | `prospects:write` |
| GET | `/api/v1/prospects/:id/related` | `prospects:read` |
| POST | `/api/v1/prospects/:id/restore` | `prospects:write` |
| PATCH | `/api/v1/prospects/:id/stage` | `prospects:write` |
| GET | `/api/v1/prospects/:id/touchpoints` | `touchpoints:read` |
| POST | `/api/v1/prospects/:id/touchpoints` | `touchpoints:write` |
| GET | `/api/v1/prospects/archived/list` | `prospects:read` |
| POST | `/api/v1/prospects/bulk-assign` | `prospects:assign` |
| GET | `/api/v1/prospects/export/csv` | `prospects:read` |
| GET | `/api/v1/prospects/pipeline` | `prospects:read` |
| GET | `/api/v1/publishers` | `publishers:read` |
| POST | `/api/v1/publishers` | `publishers:write` |
| DELETE | `/api/v1/publishers/:id` | `publishers:write` |
| GET | `/api/v1/publishers/:id` | `publishers:read` |
| PATCH | `/api/v1/publishers/:id` | `publishers:write` |
| GET | `/api/v1/publishers/:id/offers` | `offers:read` |
| POST | `/api/v1/publishers/:id/offers` | `offers:write` |
| GET | `/api/v1/publishers/:id/related` | `publishers:read` |
| POST | `/api/v1/publishers/:id/restore` | `publishers:write` |
| GET | `/api/v1/publishers/archived/list` | `publishers:read` |
| GET | `/api/v1/publishers/export/csv` | `publishers:read` |
| GET | `/api/v1/publishers/options/filters` | `publishers:read` |
| GET | `/api/v1/reports/anchors` | `reports:read` |
| GET | `/api/v1/reports/ar-aging` | `invoices:read` |
| GET | `/api/v1/reports/campaigns` | `reports:margins` |
| GET | `/api/v1/reports/campaigns/export` | `reports:margins` |
| GET | `/api/v1/reports/dashboard` | `campaigns:read` |
| GET | `/api/v1/reports/database` | `audit:read` |
| GET | `/api/v1/reports/financial` | `reports:margins` |
| GET | `/api/v1/reports/financial/export` | `reports:margins` |
| GET | `/api/v1/reports/ledger` | `reports:margins` |
| GET | `/api/v1/reports/outreach` | `reports:read` |
| GET | `/api/v1/reports/placements` | `placements:read` |
| GET | `/api/v1/reports/profitability` | `reports:margins` |
| GET | `/api/v1/reports/publishers` | `publishers:read` |
| GET | `/api/v1/settings/org` | authenticated |
| PATCH | `/api/v1/settings/org` | `settings:manage` |
| DELETE | `/api/v1/settings/org/logo` | `settings:manage` |
| PUT | `/api/v1/settings/org/logo` | `settings:manage` |
| GET | `/api/v1/settings/pipeline-stages` | authenticated |
| POST | `/api/v1/settings/pipeline-stages` | `pipeline:configure` |
| GET | `/api/v1/staff` | `staff:read` |
| GET | `/api/v1/staff/:id` | `staff:read` |
| PATCH | `/api/v1/staff/:id` | `staff:manage` |
| POST | `/api/v1/staff/:id/activate` | `staff:manage` |
| GET | `/api/v1/staff/:id/portal-clients` | `portal_access:manage` |
| POST | `/api/v1/staff/:id/portal-clients` | `portal_access:manage` |
| POST | `/api/v1/staff/:id/suspend` | `staff:manage` |
| GET | `/api/v1/staff/invitations` | `staff:read` |
| DELETE | `/api/v1/staff/invitations/:id` | `staff:manage` |
| POST | `/api/v1/staff/invitations/:id/resend` | `staff:manage` |
| POST | `/api/v1/staff/invite` | `staff:manage` |
| GET | `/api/v1/suppliers` | `suppliers:read` |
| POST | `/api/v1/suppliers` | `suppliers:write` |
| DELETE | `/api/v1/suppliers/:id` | `suppliers:write` |
| GET | `/api/v1/suppliers/:id` | `suppliers:read` |
| PATCH | `/api/v1/suppliers/:id` | `suppliers:write` |

---

### Client Portal API

`/portal/v1`

| Method | Path | Permission |
|---|---|---|
| GET | `/portal/v1/campaigns` | authenticated |
| GET | `/portal/v1/drafts` | authenticated |
| POST | `/portal/v1/drafts/:id/approve` | authenticated |
| POST | `/portal/v1/drafts/:id/revision` | authenticated |
| GET | `/portal/v1/invoices` | authenticated |
| GET | `/portal/v1/invoices/:id` | authenticated |
| GET | `/portal/v1/invoices/:id/pdf` | authenticated |
| GET | `/portal/v1/me` | authenticated |
| GET | `/portal/v1/me/permissions` | authenticated |
| GET | `/portal/v1/overview` | authenticated |
| GET | `/portal/v1/placements` | authenticated |
| GET | `/portal/v1/placements/approved` | authenticated |
| GET | `/portal/v1/reports` | authenticated |
| GET | `/portal/v1/reports/campaigns` | authenticated |
| GET | `/portal/v1/reports/campaigns/export` | authenticated |

---

### Supplier Portal API

`/supplier/v1`

| Method | Path | Permission |
|---|---|---|
| GET | `/supplier/v1/earnings` | authenticated |
| GET | `/supplier/v1/me` | authenticated |
| GET | `/supplier/v1/placements` | authenticated |
| GET | `/supplier/v1/prospects/:id` | authenticated |
| POST | `/supplier/v1/prospects/:id/touchpoints` | authenticated |
| GET | `/supplier/v1/publishers` | authenticated |
| PATCH | `/supplier/v1/publishers/:id` | authenticated |
| GET | `/supplier/v1/queue` | authenticated |

---

### Public Invoice API

`/public/v1`

| Method | Path | Permission |
|---|---|---|
| GET | `/public/v1/invoices/:token` | authenticated |
| GET | `/public/v1/invoices/:token/pdf` | authenticated |

Public links carry a 256-bit token; only its SHA-256 is stored. Unknown, revoked,
expired and cancelled tokens all return the **same** 404, so a probe learns nothing.
Responses carry `noindex` and `no-store`. Every access is written to the audit log.
The payload is projected from the invoice's frozen snapshot, so a public link can
never expose data added after the invoice was issued.

---

### Scheduled Jobs

`/api/v1/internal/jobs`

| Method | Path | Permission |
|---|---|---|
| POST | `/api/v1/internal/jobs/anchor-alerts` | `HMAC signature` |
| POST | `/api/v1/internal/jobs/check-links` | `HMAC signature` |
| POST | `/api/v1/internal/jobs/flag-overdue` | `HMAC signature` |
| POST | `/api/v1/internal/jobs/follow-ups-due` | `HMAC signature` |

### Job signing

```
x-job-signature: <hex hmac-sha256 of the request body, key = JOB_HMAC_SECRET>
```

`JOB_HMAC_SECRET` is required in production; without it every job is unreachable and
link verification stops silently. Because the guard covers the whole mount, an
unknown job path returns **401**, not 404 — that is correct, and it does not
disclose which job names exist.

Each job records its outcome in `job_runs.detail` and is safe to re-run.

---

## 5. Errors an integrator will actually hit

| Symptom | Cause |
|---|---|
| 401 on every call | Token expired, or `Authorization` header stripped by a proxy |
| 403 on a route that exists | Wrong surface for the role, or missing permission |
| 400 with `details` | Read `details[].path` — it names the exact field |
| 404 for a record you can see in the UI | Your role lacks the permission that the RLS policy uses |
| 413 | Body over 1 MB — uploads use a different path |
| 429 | Back off; the auth surface is rate limited |
| HTML instead of JSON | You are hitting the SPA fallback — check the path prefix |

---

## 6. Regenerating this document

```bash
node scripts/generate-api-docs.mjs
```

Run it after changing any router. The script reads the routers, so it cannot
describe a route that does not exist.
