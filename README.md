# Trivero Marketing — Link Building CRM

A production-oriented CRM for link building agencies: clients and campaigns,
outreach pipeline, placements and link monitoring, billing and margins — with
permissions enforced in Postgres rather than in the interface.

Architecture rationale lives in `~/.commandcode/plans/link-building-agency-crm-implementation.md`.
This file is the practical guide: what exists, how to run it, and what is honest
about not existing yet.

---

## Status

| Phase | Scope | State |
|---|---|---|
| Phase 1 | Monorepo, design system, auth shell, navigation, health checks | **Complete** |
| Phase 2 | Authentication, user management, RBAC, audit logging | **Complete** |
| Phase 3 | Clients, agency partners, publishers, prospects, campaigns — API and CSV | **Complete** (API only) |
| Phase 4 | Placement pipeline, outreach management | **Complete** |
| Phase 5 | Content workflow, anchor analytics, backlink verification | **Complete** |
| Phase 5.1 | Client portal UI, approval queue, scheduled verification, alert delivery | **Complete** |
| Phase 6 | Invoicing, PDF generation, secure sharing, payments, profitability, reports | **Complete** |
| Phase 7 | Admin customization: nav, modules, columns, theme, logo, roles, fields, views | **Complete** |
| Phase 8 | Production readiness: single-origin serving, deployment artifacts, audits, docs | **Complete** |

Two gaps worth stating plainly:

- **The five Phase 3 modules still have no UI.** Their schema, API, CSV import/export and
  permissions are built and tested, but `/clients`, `/agency-partners`, `/publishers`,
  `/prospects` and `/campaigns` render placeholders and are marked `SOON` in the
  navigation so they stay visible as outstanding work. Phase 5.1 built the portal and
  the approval queue instead; these five screens are the next obvious piece of work.
- **Hostinger is verified locally, not against the live host.** `pnpm build:hostinger`
  assembles the artifact, installs it with `npm install --omit=dev`, then **boots it** and
  checks it serves the SPA, answers the API and reaches the database. That proves the
  artifact is deployable; it does not prove Hostinger's panel, proxy or idle behaviour.
  See [Deployment](#deployment).

Everything delivered is verified by automated checks — see [Verification](#verification).

---

## Tech stack

**Frontend** — React 18 · Vite 6 · TypeScript · Tailwind CSS v4 · React Router 6 ·
TanStack Query 5 · Radix UI primitives · Lucide icons

**Backend** — Node 20+ · Express 4 · TypeScript · Zod validation ·
Pino logging · jose (JWT verification)

**Database** — Supabase Postgres 15 · Auth · Row Level Security

**Monorepo** — pnpm workspaces · Turborepo

---

## Requirements

- **Node 20+** (`node --version`)
- **pnpm** (`corepack enable pnpm`)
- **Docker Desktop** — required by the Supabase CLI for the local database
- **Supabase CLI** — installed as a dev dependency, no global install needed

---

## Setup

```bash
# 1. Install all workspace dependencies
pnpm install

# 2. Start the local database (pulls Docker images on first run)
pnpm db:start

# 3. Apply migrations and seed demo data
pnpm db:reset
```

`db:reset` creates the schema, all RLS policies, and a demo organisation with one
user per role so you can exercise permissions immediately.

### Environment files

Two separate `.env` files, both git-ignored. Example files are committed.

```bash
cp .env.example apps/api/.env          # server: holds the service-role key
cp apps/web/.env.example apps/web/.env  # browser: public keys only
```

**`apps/api/.env`** — server-only. The service-role key lives here and nowhere else.

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Public anon key (used for user-scoped clients) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server only.** Bypasses RLS; never expose |
| `JOB_HMAC_SECRET` | Signs scheduled-job requests (min 32 chars) |
| `CORS_ORIGINS` | Comma-separated allowlist, no wildcards |
| `PORT` | API port, default `3000` |
| `NODE_ENV` | `development` / `test` / `production` |

**`apps/web/.env`** — inlined into the browser bundle. **Everything here is public.**

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Empty in dev (Vite proxies `/api`). Set only for split deployments |
| `VITE_SUPABASE_URL` | Supabase URL |
| `VITE_SUPABASE_ANON_KEY` | Anon key — safe by design, RLS decides access |
| `VITE_APP_NAME` | Display name |

> **Never** prefix a server secret with `VITE_`. It would be published to every
> visitor. `pnpm verify:secrets` fails the build if one appears.

---

## Running locally

Two terminals, or one command for both:

```bash
pnpm dev            # starts API (:3000) and web (:5173) together

pnpm dev:api        # API only
pnpm dev:web        # web only
```

Open **http://localhost:5173**.

### Demo accounts

All use password `password123`.

| Email | Role | Sees |
|---|---|---|
| `owner@demo.test` | Super Admin | Everything, including margins and payments |
| `am@demo.test` | Account Manager | Clients, campaigns, invoicing — **not** wholesale cost |
| `prospector@demo.test` | Prospector | Publisher data, prospecting, supplier cost |
| `outreach@demo.test` | Outreach Specialist | Outreach pipeline, negotiation |
| `writer@demo.test` | Content Writer | Content briefs only |
| `client@demo.test` | Client | Portal only (not in Phase 0 UI) |
| `publisher@demo.test` | Publisher | Supplier portal only |

Sign in as `owner@demo.test` first, then as `writer@demo.test` — the sidebar
visibly loses most of its entries, because navigation is built from the same
permission matrix the API enforces.

---

## Project structure

```
link-building-crm/
├─ apps/
│  ├─ api/                     Express API
│  │  └─ src/
│  │     ├─ config/env.ts      Zod-validated environment, fails fast at boot
│  │     ├─ middleware/        authenticate · errorHandler
│  │     ├─ modules/           clients, campaigns, placements, invoices…
│  │     ├─ integrations/      supabase, linkChecker
│  │     └─ lib/               errors, http helpers
│  └─ web/                     React SPA
│     └─ src/
│        ├─ app/               router, guards, error boundary
│        ├─ components/
│        │  ├─ ui/             button, input, card, badge, avatar, states
│        │  └─ layout/         app-shell, sidebar, header
│        ├─ config/            navigation (permission-driven)
│        ├─ features/          auth, dashboard
│        ├─ lib/               api client, env, utils
│        ├─ providers/         theme, auth, query
│        └─ styles/            design tokens
├─ packages/
│  ├─ shared/                  roles, RBAC matrix, Zod schemas, money math
│  └─ db/                      RLS test suite
├─ supabase/
│  ├─ migrations/              4 migrations — schema and security
│  └─ seed.sql                 demo organisation, one user per role
└─ scripts/                    verification scripts
```

---

## How the important parts work

### Authentication and user management

| Flow | Route | Behaviour |
|---|---|---|
| Sign in | `/login` | Supabase Auth; the API then resolves the authoritative profile |
| Sign out | header menu | Revokes the session and clears local storage |
| Accept invitation | `/register` | Invitation-only; role comes from the invitation row |
| Forgot password | `/forgot-password` | Always reports success (no account enumeration) |
| Set new password | `/reset-password` | Exchanges the recovery token for a session first |

**Registration is invitation-only.** An invitation row carries the role and
organization. A trigger provisions the profile from that row — never from
sign-up metadata. A sign-up without an invitation creates an auth user with no
profile, and `authenticate` rejects every request from it.

The invitation stays **pending** until the invitee confirms their email; a second
trigger performs the acceptance. Consuming it at invite time (the original
behaviour) made `resend` and `revoke` unreachable and the admin panel permanently
empty. Revoking also deactivates the provisioned account, because the profile
already exists and would otherwise keep working.

**Roles are never trusted from the frontend.** Three layers enforce this:

1. `@crm/shared/src/rbac.ts` is the only permission definition.
2. Express `authorize()` checks it on every route.
3. Postgres RLS and column-level grants enforce it even if 1 and 2 are bypassed.

The `/api/v1/me` endpoint reloads the role from the database on every session
resolve, so a demotion takes effect within 60 seconds rather than at token expiry.

### Admin user management

`/staff` (owner only) supports:

- **Invite** — role chosen by the admin, validated server-side.
- **Change role** — revokes the target's sessions so the old token cannot outlive it.
- **Suspend / reactivate** — soft state change with a mandatory reason; history is preserved.
- **Portal client access** — which clients a `client_user` may see.

Guards that are enforced, not merely displayed:

- The last active owner cannot be demoted, deactivated or deleted.
- The owner account cannot be suspended or edited through user management.
- An admin cannot act on a user in another organization.
- `publisher_user` requires a supplier; nobody else may have one.
- `owner` cannot be invited — ownership is transferred.

### Audit logging

`activity_log` has **no INSERT policy for any end-user role**. Rows are written
exclusively by the API over `service_role`, so an entry cannot be forged,
edited or deleted through the application. A trigger additionally blocks UPDATE
and DELETE for every role.

Recorded: invitations, role changes, suspensions, activations, portal access
grants, and wholesale-cost edits. Each entry stores actor, role, entity, a
before/after diff of changed fields only, IP and user agent.

> Migration `0007` widened the `action` CHECK after the writer emitted values the
> constraint rejected — and because an audit failure must not fail the request,
> the API returned 200 with no trail. That gap is now logged loudly as
> `severity: audit_gap`.

### Permissions are enforced in the database

`packages/shared/src/rbac.ts` defines seven roles and every permission. The API's
`authorize()` and the UI's navigation both read it, so a hidden menu entry and a
rejected request cannot disagree.

Navigation is filtered by the caller's permissions:

```ts
visibleNavigation(permissions)  // drops items the role cannot use
```

### The placement pipeline

`placements.status` and `placements.pipeline_stage` are **different questions**, and
keeping them apart is what makes the board honest:

| Column | Answers | Example values |
|---|---|---|
| `status` | Where is the link physically? | `scheduled`, `pending`, `live`, `removed` |
| `pipeline_stage` | Where is the work? | `prospected`, `pitched`, `client_approved`, `content_writing`, `submitted`, `live` |

They were conflated in the original design, which is why there was no board: a link
can be `live` operationally while its anchor is still awaiting client approval, and a
placement in "content writing" has no operational status at all yet. A trigger
(`assert_placement_stage_valid`) keeps the two in step for the obvious case — reaching
`live` in the pipeline also sets `status = 'live'` — and leaves everything else alone,
because operational status belongs to link monitoring, not to workflow.

**Transitions are guarded.** `POST /api/v1/placements/:id/transition` accepts only the
moves in `apps/api/src/modules/placements/pipeline.ts`:

```
prospected      → pitched
pitched         → client_approved (approval note required) | prospected
client_approved → content_writing | pitched
content_writing → submitted | client_approved
submitted       → live (live URL required) | content_writing
live            → (terminal)
```

Backwards is deliberately permissive — a deal can collapse at any point. Forwards is
guarded, because skipping a step records work that never happened. Two stages carry a
required field: `client_approved` needs a record of *who said yes*, and `live` needs a
URL that monitoring can check. Both are enforced by **database constraints** as well
(`placements_live_requires_url`, `placements_approved_requires_attribution`), so a
bypass at any layer — a future bulk import, a seed file — fails rather than writing a
row the pipeline cannot justify.

**A placement cannot be created past `pitched`.** Creation used to accept any stage, so
`pipelineStage: 'live'` wrote a live row with no URL, skipping the state machine
entirely. It now refuses anything but the first two stages; the rest of the journey goes
through `/transition`, which is the only place the rules live.

**Approving on a client's behalf needs `placements:approve`, not `placements:write`.**
Those are different authorities. The account manager holds approve but not write — that
is their job — while the content writer holds write but not approve. Gating approval on
`write` had it exactly backwards: it locked the account manager out and let the writer
sign off on a client's behalf.

**Every stage change is written to `placement_events`**, which has no INSERT policy for
any end-user role. History is written over service_role, so it cannot be forged or
backdated — the point of a pipeline audit is that it reflects what actually happened.

**Drag and drop uses the native HTML5 API**, not a library. It reads the placement id
from `dataTransfer` rather than from React state, because the state set in `onDragStart`
has not necessarily committed by the time `drop` fires. Every card also carries a
keyboard-reachable move control, so the board is not mouse-only.

### Where the negotiated cost went

`placements` originally gained a `negotiated_cost` column. That was **the financial leak
this design exists to prevent**, wearing a new name: every internal role can read a
column on `placements`, so the account manager — and the content writer — could read the
wholesale figure from the list, the detail view and the board, while being correctly
refused by `/costs`. The writer could also *write* it.

A column on a shared table cannot be protected by policy, and column GRANTs cannot
distinguish roles because every signed-in user shares the `authenticated` Postgres role.
So the column is gone (migration 0018) and the figure lives only in `placement_costs`,
which is tier 2:

| Who | Reads the cost? |
|---|---|
| owner, prospector, outreach_specialist | yes — `costs:read` |
| publisher (its own placement) | yes — via the tier-2 policy |
| account_manager, content_writer | **no policy at all → zero rows** |
| client_user | no — never leaves the internal surface |

The API accepts `negotiatedCost` on the placement endpoints but writes it to tier 2
behind `costs:write`, and returns it as `agreed_cost` only to callers entitled to it.
For everyone else the field is **absent, not null**, so a UI that formats whatever it
receives cannot render a misleading `$0`.

### What a client may see

Two separate controls, because they fail differently:

1. **Which rows.** A client has **no policy at all** on `placements`, so a direct read
   returns zero. Their only route is the `v_portal_placements` view, which is restricted
   to placements at or past `client_approved` and to their own clients.
2. **Which columns.** The view enumerates columns, so `internal_notes`, the agreed cost,
   `assigned_to`, `content_assignee` and supplier identity are simply not in it.

Column-level GRANTs do **not** work for this here: Supabase gives every signed-in user
the same Postgres role (`authenticated`), so revoking a column from `authenticated` also
blinds internal staff. RLS filters rows, not columns. Hence the definer view.

### Outreach

`outreach_records` is the **plan** (what to send, when to follow up); the older
`outreach_touchpoints` is the **history** (what happened). A log of past events cannot
express "chase this on Tuesday", which is why both exist.

Logging an outreach advances the record, writes a touchpoint, increments
`follow_up_count` and moves the prospect's stage. A response also moves the stage —
after checking the target stage exists, because the stage-validity trigger silently
rejects an unknown one and returns no rows.

**Sending is disabled.** No email provider is configured, so `POST /outreach/:id/send`
returns **503** with a message naming `EMAIL_PROVIDER`. It does not mark the record
`sent`. A generic PATCH cannot set `status = 'sent'` either — that would claim an email
left the building when nothing did, and every downstream number (reply rate, follow-up
due dates) would become fiction. Use `POST /outreach/:id/log` to record a send that
happened elsewhere.

### Content workflow

The unit of work is a **brief** (the assignment) which owns one **draft** (the
document), which owns many **versions** (every saved state).

```
draft ──submit──▶ in_review ──approve──▶ approved ──publish──▶ published
                     │
                     └──request revision──▶ revision_requested ──resubmit──▶ in_review
```

Two properties are deliberate:

- **`approved` is only reachable from `in_review`.** A writer cannot move a draft
  straight to approved, and `briefs:approve` is a separate permission from
  `briefs:write`, so the person who drafts and the person who signs off are
  different authorities. Without both, the review step is decoration.
- **Saving creates a version rather than mutating the draft.** The client approves
  version N; if editing overwrote it, what they approved would no longer exist.
  Restoring an old version copies it forward as a new version — history is never
  rewritten. `content_draft_versions` has no INSERT policy for any end-user role.

A revision request requires notes (a request with no content is not actionable),
and only one may be open at a time — two open requests means the writer has two
contradictory briefs. Saving a version after a request resolves it and returns the
draft to review, not straight to approved.

Published drafts are frozen: editing one would mean the approved and published
versions differ. **Restoring an earlier version is also refused while a draft is
`in_review` or `approved`** — replacing the text would change what the reviewer is
looking at, or what the client already signed off, with no record of why. The writer
must request a revision first, which is an explicit act that appears in the history.

**Creating a brief advances the placement.** A placement at `client_approved` moves
to `content_writing` when its brief is created, because assigning the work *is* the
move. A placement earlier in the pipeline is left alone: advancing it there would
skip the client's anchor sign-off.

### Client sign-off on drafts

The client is on the portal surface, so `/api/v1` rejects them before any permission
is consulted. Approval therefore lives at `/portal/v1`:

| Endpoint | Purpose |
|---|---|
| `GET /portal/v1/drafts` | drafts awaiting this client, plus ones already approved |
| `POST /portal/v1/drafts/:id/approve` | approve, with an optional note |

They can read a draft only once it is `in_review` (or already approved/published) and
only on a placement their account is granted. They cannot edit the text, create a
draft, or approve something that was not submitted.

Approval goes through a `SECURITY DEFINER` function rather than an UPDATE policy: a
policy broad enough to approve would also let a client rewrite the article. The
function re-derives the organisation and role from the caller's claims and re-checks
the placement scope, so it cannot approve across tenants.

### Anchor analytics

Classification is a heuristic and **overridable**. `classifyAnchor` derives the
category from the anchor text against the target URL's slug, and a human-set
`anchor_type` is never overwritten by the backfill.

One ordering decision matters more than the rest: **a bare URL is checked before
the brand name.** `https://acme.test/pricing` contains "Acme", so a brand-first
implementation labels it branded — telling a client their anchors are on-brand
when a third of them are bare URLs. The report would be wrong in the direction
that looks healthy.

The four display groups are Branded, Exact Match, Partial Match and
Generic/Naked URL, with `naked_url` stored separately from `generic` and grouped
for display: a bare URL and "click here" are different signals, and collapsing
them at the storage layer would lose the ability to tell them apart.

**Shares are computed over classified links only.** Unclassified links are
reported separately, so the four groups sum to 1 and the donut's total equals its
slices. Alert evaluation applies its sample floor to the **total**, not to each
category — per category, over-optimisation (one category dominating a small
total) could never fire.

Charts are hand-written SVG in `components/ui/charts`, not a charting library: a
donut and a bar do not justify a few hundred kilobytes and a second theme system,
and inline SVG inherits the app's CSS variables so dark mode works for free.

### Backlink verification

Answers the five questions the brief asks, and records each one:

| Question | Column |
|---|---|
| Did the live URL respond? | `http_status`, `elapsed_ms` |
| Does the backlink exist? | `found`, `found_url` |
| Is the destination correct? | `url_matches`, `expected_url` |
| Does the anchor match? | `anchor_matches`, `anchor_expected`, `anchor_found` |
| Do the attributes match? | `rel_matches`, `rel_expected`, `rel_attribute` |

The previous implementation asked `html.includes(pageUrl)` — "does this page
contain its own address" — which is true of the canonical tag, the og:url and the
page's own navigation, so a removed link still reported as present. It now parses
the anchors and compares the actual destination, text and rel.

**`unreachable` is not `link_missing`.** A timeout, a 403 from Cloudflare or a
blocked address says nothing about whether the link is on the page. Conflating
them is how a monitoring system earns a reputation for false alarms and stops
being read. The `verdict` column is what reporting uses; `found` only means an
anchor to the target exists at all.

**A verification never changes the placement's status.** It records an
observation; deciding a link is removed is a human judgement.

### SSRF protection — the verification fetcher

The service fetches a URL a user supplied, so without a guard it is a request from
our server to anything we can reach — including `169.254.169.254`, the cloud
metadata service that hands out credentials. One HTTP request is a full credential
read.

Checking the string is not enough: `http://2130706433` (decimal), `http://0x7f.1`
(hex), `http://[::1]` (IPv6) and `http://localtest.me` all reach loopback. So
`integrations/url-safety.ts`:

1. Rejects non-HTTP(S) schemes — `file://` reads the local filesystem, `gopher://`
   speaks arbitrary protocols to internal services.
2. Rejects internal hostnames before any DNS lookup.
3. Resolves the hostname and checks **every** returned address — a mixed
   public/private record must not slip through on whichever the OS picked.
4. Checks IPv4-mapped IPv6 (`::ffff:127.0.0.1`), which a textual `127.0.0.1` check
   misses.
5. **Follows redirects manually and re-validates each hop** — `redirect: "follow"`
   would let a public URL bounce to metadata after the first check passed, which is
   the most common way a naive filter is bypassed.
6. **Pins the validated address for the connection.** Resolving, checking, and then
   calling `fetch(url)` would resolve a second time — and that second answer is what
   the socket uses. An attacker with a TTL-0 DNS record can answer "public" for the
   check and "127.0.0.1" for the connection. So the request is made with
   `node:http(s)` directly, `lookup` is overridden to return the address that was
   validated, and the original hostname is carried in `Host` and as the TLS
   `servername` so virtual hosting and certificate validation still work.

The guard runs at **write time as well**: an internal `live_url` is refused before
it is stored, because a loopback address in the database is a problem in itself —
it appears in reports and exports. The fetch-time check is the second line.

Bodies are read with a 2 MB cap (a hostile host can stream forever) and a
verification request sends no cookies, so a check does not depend on who triggered
it.

### Three financial tiers

The single most important design property. Money lives in **separate tables**,
because RLS filters rows, not columns — putting a client price and a supplier
cost on one row leaks the cost to everyone who can read the row.

| Tier | Tables | Who may read |
|---|---|---|
| 1 — client pricing | `placement_pricing`, `invoices`, `payments` | owner, account_manager, (client: own) |
| 2 — wholesale cost | `placement_costs`, `supplier_bills` | owner, prospector, outreach, (publisher: own) |
| 3 — margin | `v_placement_margin` and friends | owner only, via service_role |

A role absent from a tier holds **no policy at all** on its tables. The account
manager, for example, has no policy on `placement_costs` — so even a bug that
skipped a permission check would return zero rows rather than a cost.

### Authentication and the role check

Supabase handles identity. The frontend then calls `/api/v1/me`, which resolves
the profile **from the database**. The token is a hint; the database is the
truth. A demoted or deactivated user is rejected within 60 seconds even while
their token is still valid.

### Health endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health/live` | Liveness — process is up. Used by the uptime monitor |
| `GET /health/ready` | Readiness — actually queries the database |

The dashboard polls `/health/ready`, so a database outage is visible in the UI
rather than only in logs.

### Error handling

One shape for every failure:

```json
{ "error": { "code": "forbidden", "message": "…", "requestId": "…" } }
```

The API has a single error handler; unknown errors log with a request id and
return a generic message, so a stack trace or driver message never reaches the
client. The frontend turns responses into a typed `ApiError` carrying the code,
field-level validation details, and the request id. Render errors are caught by
a top-level boundary.

---

## Verification

```bash
pnpm typecheck        # all packages
pnpm test             # unit tests + RLS suite (needs pnpm db:start)
pnpm build            # production build
pnpm verify:secrets   # no server secrets in the browser bundle
pnpm verify:all       # all of the above in order
```

With the API and web running:

```bash
node scripts/smoke.mjs            # 45 API checks: surfaces, tiers, HMAC jobs, validation
node scripts/verify-ui.mjs        # 16 browser checks: login, shell, themes, mobile, 404
node scripts/verify-roles.mjs     # 18 permission checks across three roles
node scripts/verify-responsive.mjs # 23 checks: 8 breakpoints, rail, drawer
node scripts/verify-a11y.mjs      # 18 accessibility checks: labels, focus, landmarks
node scripts/test-authorization.mjs # 86 authorization checks, all seven roles
node scripts/attack-privilege-escalation.mjs # 7 privilege-escalation attacks
node scripts/test-invitation-lifecycle.mjs   # 20 invite → confirm → revoke checks
node scripts/test-audit-safety.mjs           # 9 audit redaction and integrity checks
node scripts/verify-phase2-ui.mjs # 42 auth, user-management and audit UI checks
node scripts/verify-admin-responsive.mjs # 33 admin-screen responsive/a11y checks
node scripts/test-phase3-crud.mjs      # 75 CRUD/CSV/permission checks across five modules
node scripts/test-import-dedup.mjs     # 7 duplicate-detection checks
node scripts/test-roundtrip.mjs        # 20 export → import fidelity checks
node scripts/test-import-authz.mjs     # 5 import authorization checks
node scripts/test-phase4-pipeline.mjs  # 88 pipeline, transition and portal-isolation checks
node scripts/test-phase4-outreach.mjs  # 50 outreach, template-safety and permission checks
node scripts/test-phase4-security.mjs  # 31 regression checks for the Phase 4 review fixes
node scripts/verify-phase4-migrations.mjs # 19 schema/constraint/RLS checks against Postgres
node scripts/verify-phase4-ui.mjs      # 48 browser checks: board, drag-and-drop, roles, responsive
node scripts/test-phase5.mjs           # 90 content, anchor analytics and verification checks
node scripts/shots-phase5.mjs          # screenshots of the content and anchor screens

# Phase 5.1
node scripts/test-phase5-1-portal.mjs        # 63 portal isolation and approval checks
node scripts/test-phase5-1-guards.mjs        # 28 role-separation checks (AM vs client)
node scripts/test-phase5-1-notifications.mjs # 33 delivery, dedupe and isolation checks
node scripts/test-phase5-1-jobs.mjs          # 48 scheduling, HMAC, run-record and overdue-job checks
node scripts/test-phase5-1-verification.mjs  # 35 verdict-constraint and history checks
node scripts/verify-phase5-1-ui.mjs          # 52 browser checks across both surfaces
pnpm verify:phase5-1                         # all five API suites in order

# Phase 6
node scripts/test-phase6-invoices.mjs        # 55 invoice, arithmetic and snapshot checks
node scripts/test-phase6-payments.mjs        # 36 payment, status-ladder agreement checks
node scripts/test-phase6-sharing.mjs         # 85 sharing, token, leak and portal-payload checks
node scripts/test-phase6-financials.mjs      # 57 privacy and profitability checks
node scripts/test-phase6-exports.mjs         # 88 PDF, CSV and Excel checks
node scripts/verify-phase6-migrations.mjs    # 77 schema, constraint and RLS checks
node scripts/verify-phase6-ui.mjs            # 70 browser checks
pnpm verify:phase6                           # all of the above in order

# Phase 6 audits — these find defects the pass/fail suites do not.
pnpm audit:phase6                            # migrations, authz sweep, regression guards, responsiveness

# Phase 7
node scripts/audit-phase7-config.mjs          # 44 SECURITY checks: customization cannot widen access
node scripts/audit-phase7-lockout.mjs         # 13 checks: a config cannot make the app unusable
node scripts/audit-phase7-wiring.mjs          # every stored setting is actually rendered
node scripts/test-phase7-branding.mjs         # 39 Trivero identity, logo and PDF branding checks
node scripts/test-phase7-fields.mjs           # 46 custom fields, saved views, notification prefs
node scripts/verify-phase7-ui.mjs             # 33 browser checks incl. reload, re-login, live effect
pnpm verify:phase7                            # all of the above in order
pnpm seed:logo                                # upload Logo/Trivero Logo.png through the real API

# Phase 8 — production readiness
pnpm audit:rls                                # 13 checks: 51 tables leak nothing to anon, no RLS gaps
pnpm audit:production-roles                   # 57 checks: all seven roles, surface isolation, financial tiers
pnpm audit:production-errors                  # 38 checks: no stack/driver/secret leak in any error path
pnpm audit:production-workflows               # 40 checks: import, placement, verification, anchors, PDF, exports
pnpm audit:production-serve                   # 41 checks against the COMPILED server (run it first)
pnpm audit:production                         # the first four, in order
pnpm build:hostinger                          # build the deploy artifact AND boot it (15 checks)
pnpm docs:api                                 # regenerate docs/API.md from the routers
```

`audit:production-serve` targets a compiled server, not the dev one:

```bash
pnpm build
PORT=3001 NODE_ENV=development node apps/api/dist/server.js &
node scripts/audit-production-serve.mjs
```

## What the Phase 8 review found

The deployment work exposed two classes of defect that every previous phase's tests
were structurally unable to catch, because each only appears in a **built** artifact.

1. **The production server could not start at all.** `node dist/server.js` failed with
   `ERR_MODULE_NOT_FOUND` for `@crm/shared`, which exports raw TypeScript that `tsx`
   transpiles on the fly and plain Node cannot load. A second failure followed once that
   was fixed: `pdfmake/standard-fonts/Helvetica` has no extension mapping and Node's ESM
   loader will not guess one. Development worked perfectly throughout. `tsc` passed.
   The unit tests passed. The artifact only failed when it was actually executed.

   Fixed with conditional exports (dev loads source, production loads compiled JS), an
   explicit `.js` in the pdfmake import, and — the real fix — `build:hostinger`
   **booting the artifact** as its final step, so this cannot ship silently again.

2. **The SPA fallback reproduced the Phase 5.1 routing bug in new code.** The static
   handler excluded `/portal/`, but `/portal` is *also* a client-side route, so
   `/portal/drafts` returned 404 on a hard refresh. Only the versioned prefixes
   (`/portal/v1`) may be excluded. The same distinction the Vite proxy has to make, and
   getting it wrong in a second place is exactly what a review is for.

Three findings from this phase were **wrong expectations rather than bugs**, and are
worth recording so they are not "fixed" later:

- Anonymous requests to an unknown `/api/v1/*` path return **401, not 404**. `authenticate`
  guards the whole mount before routing, which correctly avoids disclosing the route table.
- `v_placement_margin` reports a **null** `client_rate` for an unpriced placement. Null is
  the honest value — `margin = null - cost = null` — and "no revenue recorded" must not be
  displayed as "zero margin".
- `pdfmake`'s standard-14 Helvetica is Latin-1, so a Unicode minus renders as a blank.
  Negative money is printed in parentheses for that reason.

## What the Phase 7 review found

Three defects that the green test suite could not see, because each of them was a
case of **the tests checking the wrong thing**.

1. **Two settings saved and then did nothing.** The dashboard layout and the table
   column preferences were written to `ui_settings`, returned by the API, and never
   read by a single component. The switches worked, the data round-tripped, the
   tests passed — and the screen never changed.

   The tests asserted `saved === returned`, which a no-op satisfies perfectly. They
   now assert the *rendered result*: hide the metrics widget and the dashboard text
   disappears; select two columns and the table header contains exactly those two.
   `audit:phase7-wiring` greps the app for each key so a future setting cannot ship
   in the same half-connected state.

2. **The widget registry described blocks that did not exist.** It offered
   `placementStages` and `recentActivity`; the dashboard had no such blocks, and the
   two real ones — "Getting started" and "System" — could not be configured at all.
   A registry of imaginary things looks like control while giving none. It is now
   derived from the shared constant the dashboard itself reads, with a unit test
   pinning the list.

3. **The Admin panel could lock the owner out.** The guard checked `modules["/admin"]`
   and `roleVisibility.owner`, but not `navigation.items[].hidden`. Hiding every nav
   item was accepted by the API and left a blank sidebar with no UI route back to
   the page that could undo it — recoverable only by an API call nobody would
   discover. All three shapes are now refused, plus a floor of three reachable
   modules, which stops "technically usable, practically bricked".

The pattern: a test that asserts the API round-trip proves storage, not behaviour.
The checks that catch this class of bug assert what the user sees.

## What the Phase 6 review found

The suites were green and the feature still had bugs. A review pass that only
re-ran them would have missed all four of these, so they are recorded here and each
has a permanent guard.

1. **Two export buttons produced corrupt files.** The reports page offered CSV and
   Excel for Publishers and Placements, but those routes only served JSON and
   ignored `?format=`. The browser saved a file named `Publishers.csv` containing
   `{"data":[...]}`. Every test passed because the export suite only covered the two
   routes that had been written — it iterated the *implementation*, not the *UI*.
   The suite now iterates the same list the page renders.

2. **The invoice status ladder existed in three places** — `v_invoices`,
   `resolve_invoice_share`, and a `deriveStatus()` in the invoices module. Two had
   already diverged on reachable cases: a zero-total invoice past due read `overdue`
   in the API and `issued` in the view; a legacy row stored as `paid` read `issued`
   in the API. Migration `0031` made `app_private.invoice_effective_status` the only
   ladder; the API now reads the derived value instead of computing it.

3. **The invoice list summed across currencies.** One total, formatted with the
   first row's currency code — so USD 500 + EUR 400 displayed as "USD 900". Now one
   figure per currency, since there are no FX rates.

4. **The invoice detail page scrolled horizontally on a phone** (108px). The
   line-items table has a minimum width, and a CSS grid column defaults to
   `min-width: auto`, so the table pushed the whole page wider instead of scrolling
   inside its own container. The responsive check now covers every Phase 6 screen,
   not just the list.

A fifth, smaller finding: the payout form allowed a payout with no campaign, which
`v_campaign_profitability` groups by — so the money would be spent and never counted.
The campaign is now required in that form.

## What the Phase 5.1 review found

Reviewing Phase 5.1 *after* Phase 6 exposed two defects that Phase 6 introduced or
exposed, both invisible to the existing suites.

1. **A duplicate route shadowed a handler and leaked drafts.** `/portal/v1/invoices`
   was registered twice — an older handler reading the base `invoices` table near the
   top of the portal router, and the Phase 6 handler reading `v_invoices` further
   down. Express matches the first registration, so clients received the OLD payload:
   **including draft invoices**, and without `balance`/`effective_status` — which is
   why the portal invoice screen rendered blank amounts.

   The test asserted only `status === 200`, which the stale handler satisfied. A
   status code is not evidence that the right handler answered. The suite now checks
   the payload shape and asserts that no draft is returned; a static guard rejects
   duplicate route registrations.

2. **`flag-overdue` had been silently doing nothing.** It filtered invoices on
   `["sent", "partially_paid"]`, but migration `0028` renamed `sent` to `issued`. From
   that point the job matched zero rows and reported "0 overdue" forever, while
   returning `200`. It also wrote `status = 'overdue'`, which is now derived and
   would have re-introduced the write-fight `0028` removed.

   It now counts what `v_invoices` considers overdue and records that in
   `job_runs.detail`, without mutating anything. A cron that quietly does nothing is
   exactly what a job report should make visible.

Both are cases where the *claim* in a comment outlived the code. The Phase 6 notes
said the overdue job "only reports"; it did not. That is the failure mode worth
watching for: documentation that describes an intention rather than the implementation.

## Invoicing and financials

**The document model.** An invoice is a document with a lifecycle, not a mutable
row. It is edited freely while `draft`; issuing **freezes a JSON snapshot** of the
content; after that only money can change, and only through payments.

The snapshot is what makes "the PDF matches what was issued" structural rather than
hopeful. Payment state is deliberately *not* frozen — it is joined live, so a PDF
downloaded after a part payment shows the correct balance. Content is immutable;
money is current.

**Effective status is derived, never stored.** One precedence ladder lives in
`v_invoices`:

```
cancelled  ->  paid  ->  partially_paid  ->  overdue  ->  published  ->  issued  ->  draft
```

`invoices.status` records only the lifecycle (`draft`/`issued`/`published`/`cancelled`)
so publication survives a later payment. This replaced a real bug: an overdue cron
wrote `status='overdue'` while a payment trigger wrote it back to `sent`, so the two
fought over one field. The cron now only reports.

**Tax applies after the discount**, in one place (`recompute_invoice_totals`):
`total = subtotal - discount + tax`, with the discount clamped to the subtotal so a
total can never go negative.

**PDFs stream on demand.** PDFMake renders in memory from the frozen snapshot and the
PDF is sent with `Content-Disposition`. There is no storage bucket and no stored
artefact, so nothing can go stale and no file permissions need managing. Fonts are
PDFMake's bundled standard-14 Helvetica — no TTF assets.

**Public sharing.** A 256-bit token, stored only as its SHA-256. A database dump
yields no working link. The public page:

- serves the frozen snapshot through a server-side allow-list projector, so internal
  costs never enter the payload to begin with;
- sends `X-Robots-Tag: noindex` and `Cache-Control: no-store`;
- returns an identical 404 for unknown, revoked, expired and cancelled — never
  confirming that a token was once valid;
- is revoked automatically by unpublishing or cancelling the invoice.

Publishing is always an explicit action with a confirmation dialog. Issuing an
invoice never publishes it.

**Financial privacy.** Three tiers, enforced by permission *and* RLS on every table:

| Data | Who | Where |
|---|---|---|
| Client rate, invoice totals | owner, account_manager, client (own) | `placement_pricing`, `invoices` |
| Publisher wholesale cost | owner, prospector, outreach | `placement_costs` |
| Writer payouts, other expenses, margin | **owner only** | `writer_payouts`, `campaign_expenses`, `v_campaign_profitability` |

The profitability views are granted to `service_role` only, so the reports router is
the single door. A client-facing report is built by *selecting* client-safe columns
rather than by deleting internal ones from a richer response.

**Multi-currency.** Every figure is `numeric`, never float, and aggregates group by
currency. There are no FX rates in this system, so a cross-currency total would be a
fabricated number — a row with `multi_currency` set says so explicitly.

## The two API surfaces

The client portal is not a restricted view of the internal API — it is a separate
surface with its own prefix, its own identity endpoint and its own permission set.

| | Internal CRM | Client portal |
|---|---|---|
| Prefix | `/api/v1` | `/portal/v1` |
| Roles | owner, account_manager, content_writer, outreach_specialist, prospector, publisher_user | client_user |
| Web tree | `/` → `AppShell` | `/portal` → `PortalShell` |

`authenticate` rejects a token whose role belongs to the other surface before any
handler runs, so a `client_user` cannot reach `/api/v1` even with a valid token. The
route guards and the separate shells exist so a person who lands on the wrong tree is
sent to their own workspace rather than shown a broken page — they are convenience,
not the security boundary.

In development the Vite proxy forwards **`/portal/v1`** and not `/portal`. `/portal`
is also an SPA route, and proxying the bare prefix forwards page loads to the API.

## Scheduled automation

All recurring work lives in Postgres (`pg_cron` + `pg_net`), not in the Node process.
A sleeping or restarted API cannot stop a schedule, and the HMAC is computed in the
database from a `supabase_vault` secret so no signing key leaves Postgres.

| Job | Default schedule | Purpose |
|---|---|---|
| `linkforge-check-links` | every 6 hours | Verifies live backlinks in bounded batches |
| `linkforge-anchor-alerts` | daily | Evaluates anchor rules and delivers in-app alerts |
| `linkforge-flag-overdue` | daily | Flags overdue placements |

Each invocation writes a `job_runs` row (`running` → `ok`/`error`), so a hung or failed
run is visible rather than silent. Batch size is configurable in `app_settings`
(`jobs.check_links_batch`, default 10); anything checked within 24 hours is skipped, so
a bounded batch converges across ticks instead of re-checking the same first rows.
Concurrent invocations are refused by an advisory lock.

Browser scripts drive real Chromium via Puppeteer and write screenshots to
`SHOT_DIR` (default `./shots`).

### What has actually been verified

| Check | Result |
|---|---|
| Shared contract unit tests | 28 passing |
| API unit tests (audit redaction, diffs) | 12 passing |
| RLS suite against real Postgres | 30 passing |
| API surface smoke test | 45 passing |
| Authorization suite (all 7 roles) | 86 passing |
| Privilege-escalation attacks | 7 safe, 0 vulnerabilities |
| Invitation lifecycle | 20 passing |
| Audit safety & redaction | 9 passing |
| Browser UI verification | 16 passing |
| Per-role permission verification | 18 passing |
| Responsive verification (8 widths) | 23 passing |
| Accessibility verification | 18 passing |
| Authentication & user-management UI | 42 passing |
| Admin-screen responsive & a11y | 33 passing |
| Phase 3 CRUD, CSV and permissions | 75 passing |
| Phase 3 import dedup / round-trip / authz | 32 passing |
| Phase 4 pipeline, transitions, portal isolation | 88 passing |
| Phase 4 outreach, templates, permissions | 50 passing |
| Phase 4 security regressions (review fixes) | 31 passing |
| Phase 4 migration, constraint and RLS checks | 19 passing |
| Phase 4 board UI (drag, keys, roles, responsive) | 48 passing |
| Unit tests — SSRF guard and address pinning | 17 passing |
| Unit tests — link extraction and anchor comparison | 31 passing |
| Unit tests — verification judgement (all 5 questions) | 21 passing |
| Unit tests — anchor category cross-check | 6 passing |
| Unit tests — anchor classification | 21 passing |
| Unit tests — content workflow rules | 18 passing |
| Unit tests — query booleans and alert evaluation | 14 passing |
| Unit tests — RLS suite against real Postgres | 33 passing |
| Unit tests — audit redaction | 12 passing |
| Phase 5 integration (content, anchors, verification) | 108 passing |
| Phase 5.1 portal isolation and draft approval | 63 passing |
| Phase 5.1 role separation (AM vs client) | 28 passing |
| Phase 5.1 notification delivery, dedupe, isolation | 33 passing |
| Phase 5.1 scheduling, HMAC and run records | 48 passing |
| Phase 5.1 verdict constraint and history | 35 passing |
| Phase 5.1 browser checks across both surfaces | 52 passing |
| Phase 6 invoice, arithmetic and snapshot | 55 passing |
| Phase 6 payments and status ladder | 36 passing |
| Phase 6 sharing, tokens and leak checks | 85 passing |
| Phase 6 privacy and profitability | 57 passing |
| Phase 6 PDF, CSV and Excel exports | 88 passing |
| Phase 6 schema, constraint and RLS | 77 passing |
| Phase 6 browser checks | 70 passing |
| Phase 7 security audit (customization cannot widen access) | 44 passing |
| Phase 7 config lockout audit | 13 passing |
| Phase 7 fields, views, notification preferences | 46 passing |
| Phase 7 branding, logo and PDF | 39 passing |
| Phase 7 browser checks | 33 passing |
| Production bundle secret scan | clean — only the anon key present |
| Typecheck across all packages | clean |
| Migrations from empty database | 32 applied cleanly |
| Tables without RLS enabled+forced | 0 |

---

## Known limitations

Deliberate boundaries and unresolved issues, stated so they are not mistaken for
finished work:

1. **The job HMAC secret is equivalent to service-role access.** A signed job may
   name any organization, because the scheduler has no user identity. Shape
   validation is the only guard beyond the signature. Treat `JOB_HMAC_SECRET`
   with the same care as `SUPABASE_SERVICE_ROLE_KEY`, and rotate it if it ever
   appears in a log.
2. **The role cache is per-process.** `clearProfileCache()` only clears the worker
   that handled the role change. Under pm2 cluster a stale entry can persist on
   other workers for up to the 60-second TTL. Acceptable at that window; it would
   need Redis for strict immediacy.
3. **Portal routers rely on RLS alone.** `/portal/v1` and `/supplier/v1` do not
   re-assert a client or supplier predicate in application code. This is safe
   because the policies are tested, but it means a missing policy is the only
   failure mode — there is no second check.
4. **CSV import, PDF invoices, Excel export and email sending are not
   implemented.** *(Superseded by Phase 6: PDF invoices, CSV and Excel exports all
   ship. Import and email remain unimplemented.)* `email_outbox` exists as a table
   only; nothing sends. `POST /api/v1/outreach/:id/send` returns **503** and names
   `EMAIL_PROVIDER`, rather than recording a send that never happened.
5. **Indexation checking and publisher metrics need paid APIs** and are not
   wired up. `index_status` defaults to `unknown`.
6. **Deployment is unexercised** — see the Deployment section.
7. **Phase 3's five modules have no UI.** Clients, agency partners, publishers,
   prospects and campaigns are complete at the schema, API and permission layer and
   have CSV import/export, but their routes still render placeholders marked `SOON`
   in the navigation. The approval queue reads prospects and publishers through the
   API rather than through a screen that does not exist yet.
8. **JavaScript-rendered links are detected, not verified.** A client-rendered page
   returns an empty shell with no anchor, which previously reported `link_missing` and
   sent someone to chase a link that was never absent. It now reports
   `needs_manual_review` with a reason. Actually rendering the page would require a
   headless browser, which is a new dependency and a new SSRF surface; the detection
   names the limitation instead of guessing at the content.
9. **Anchor alerts are in-app only.** Delivery is the notification bell and the
   notifications table. No email or messaging provider is configured, and none was
   introduced.
10. **Notifications poll rather than push.** The unread count refreshes every 60
    seconds while the tab is visible. Realtime would need a websocket subscription and
    a connection budget this app does not yet have.
11. **`placement_events` cannot distinguish a genuine no-op from a lost write.** If
   the history insert fails, the stage change still succeeds and the failure is
   logged as `severity: history_gap`. Refusing the stage change instead would be the
   safer default in a stricter system; here a missing audit row is treated as less
   bad than blocking real work, and the gap is observable in the logs.
12. **The account manager still cannot drag cards on the board.** They hold
    `placements:approve` but not `placements:write`, so the board deliberately offers
    them no drag. Approval now has a dedicated screen at `/approvals`, which records
    the decision through `client-decision` — the endpoint that role is actually
    permitted to call.
13. **`placements:check` is enforced but unused by the UI.** The manual verification
    endpoint works; no screen calls it from the board yet. Scheduled verification now
    covers the routine case.
14. **Anchor classification is a heuristic, not an authority.** It compares the
    anchor text to the target URL's slug, which is the best available signal but
    cannot know which terms a client actually wants to rank for. The category is
    editable and the backfill never overwrites a human's choice.
15. **The content editor is plain text.** No rich text, no preview of the published
    page. Deliberate: the destination is a publisher's CMS, which will re-format
    whatever we send, and a rich-text editor would add a large dependency and a
    class of paste-handling bugs for no gain.
16. **A shell with a server-rendered link is judged, not deferred.** If the anchor is
    present in the HTML of a client-rendered page the verdict is still `ok`; the
    shell check only applies when no link could be observed at all.
17. **Scheduled verification runs against a single default cadence.** The interval is
    configurable in `cron.job`, but there is no per-campaign or per-placement
    frequency. Everything due is checked every six hours.
18. **`needs_manual_review` has no resolution UI.** A placement in that state is
    flagged in the data and counted in the job result, but nobody is assigned to
    clear it. It is visible, which is the point — it replaced a false `link_missing`.

Phase 6 additions:

19. **No currency conversion.** Multi-currency invoices are supported individually,
    and every aggregate groups by currency. There are no FX rates, so a cross-currency
    total would be invented rather than computed.
20. **No payment provider.** Payments are recorded manually. No gateway is integrated,
    per the brief.
21. **PDFs are generated per request**, so a burst of downloads is CPU-bound on the API
    process. Fine at invoice volume; a queue is the fix if it ever matters.
22. **`invoices.pdf_path` remains as an unused column.** Phase 6 streams PDFs and stores
    no files, so the column is dead. It is documented rather than dropped, because
    dropping a column is riskier than leaving one.
23. **Public link access is logged per hit.** Acceptable for invoice links; a
    high-traffic marketing page would need sampling.
24. **Invoice numbering is per organisation and sequential**, allocated under a row
    lock. It is gap-free for created invoices, but a failed insert after allocation
    consumes a number — so invoice numbers may skip. That is normal accounting
    behaviour, not a defect.

---

## Deployment

Express serves the compiled React app from the same process as the API, so production is **one origin**. There is no CORS to configure, no second service to pay for, and no absolute API URL in the bundle.

| Document | Covers |
|---|---|
| [`docs/PRODUCTION-ENV.md`](./docs/PRODUCTION-ENV.md) | Every variable, and why the server refuses to boot in production with a dev default |
| [`docs/DATABASE-MIGRATIONS.md`](./docs/DATABASE-MIGRATIONS.md) | 32 migrations, ordering hazards, `db push`, rollback |
| [`docs/DATABASE-BACKUP.md`](./docs/DATABASE-BACKUP.md) | Dumps, Storage buckets, and how to prove a backup restores |
| [`docs/DEPLOY-HOSTINGER.md`](./docs/DEPLOY-HOSTINGER.md) | Hostinger Business Node.js hosting, step by step |
| [`docs/DEPLOY-GITHUB.md`](./docs/DEPLOY-GITHUB.md) | Repository setup, CI, CD, secret hygiene |
| [`docs/API.md`](./docs/API.md) | 231 routes across five surfaces, generated from the routers |

### What is actually verified

`pnpm build:hostinger` does not just assemble a bundle. It builds the workspaces, copies the compiled API and SPA, writes a production `package.json`, runs a real `npm install --omit=dev` **inside the artifact**, then boots it and checks it serves the SPA, answers the API, resolves deep links and reaches the database. If any of that fails, the build fails:

```
[hostinger] verifying the artifact starts and serves the SPA
15 passed, 0 failed
```

That step exists because the first artifact built and installed cleanly and then **died on boot** — twice. `@crm/shared` exports raw TypeScript, which `tsx` and Vite transpile but plain Node cannot load; and `pdfmake/standard-fonts/Helvetica` needs an explicit `.js` extension under Node's ESM loader. Neither problem is visible to `tsc` or to any unit test. Only executing the built server finds them.

### Production guards

With `NODE_ENV=production`, the API refuses to start rather than run misconfigured:

```
Refusing to start in production:
  - CORS_ORIGINS still points at localhost. Set it to the real origin.
  - SUPABASE_URL points at localhost. Set it to the hosted project URL.
```

Every listed value is one whose *default* is correct in development and silently wrong in production. Booting anyway means the damage surfaces later, in a way that looks like something else.

### Honest limits

The artifact is verified locally. It has **not** been exercised against a live Hostinger account, so its panel, proxy behaviour and idle-stop policy remain unproven — no amount of local testing can establish those. The deployment guide documents the verification commands to run first thing after uploading.

---

## Roadmap

- **Next** — UI for the five Phase 3 modules (clients, agency partners, publishers,
  prospects, campaigns). Their APIs are complete; the screens are the gap.
- **Then** — a resolution workflow for `needs_manual_review` link verdicts. The verdict is
  recorded and counted, but nothing lets a human clear it.
- **Then** — config history and rollback for Phase 7 settings; today a change is audited
  but not restorable.

Beyond that: real indexation checks (currently `needs_manual_review` by design rather
than adding a headless browser as an SSRF surface), and email sending
(`integrations/email.ts` is the seam; nothing sends, and the endpoint refuses to
pretend otherwise).

---

## Manually testing Phase 4

With `pnpm db:start && pnpm db:reset && pnpm dev` running, sign in at
http://localhost:5173 as `owner@demo.test` / `password123`.

**The board**

1. Go to **Placements**. Six columns should be visible without horizontal scrolling
   on a desktop: Prospected → Pitched → Client Approved → Content Writing → Submitted
   → Live. There is seeded work in four of them.
2. Click a card. A drawer opens with the target URL, anchor, history and any notes.
3. Drag a card from **Prospected** onto **Pitched**. It should move and the count in
   both column headers should update.
4. Drag a card from **Prospected** straight onto **Live**. It should *refuse* — the
   column highlights red and nothing moves, because that skips four stages.
5. Drag onto the column it is already in. Nothing should happen, and no error toast.
6. Reopen the card you moved. The history should show the stage change with your name
   and a timestamp.

**Approval and going live**

7. Click the small arrow on a card, or use the move control, and choose **Client
   Approved**. A "How did the client approve?" field appears and **Move** stays
   disabled until you type something. That is deliberate: the stage is a claim that
   the client said yes.
8. Move a card all the way to **Submitted**, then to **Live**. Live requires a URL.
   Without one it refuses.
9. Archive a placement (`DELETE /api/v1/placements/:id` or the API client of your
   choice), then reload the board — it should be gone. Restore it via
   `POST /api/v1/placements/:id/restore` and it returns.

**Permissions**

10. Sign in as `writer@demo.test`. You see the board and can create placements, but
    **Outreach** is absent from the sidebar; navigating to `/outreach` directly shows
    a permission explanation rather than a broken page. Open **New placement**: there
    is no "Negotiated publisher cost" field, and no currency figure appears on any
    card — the content writer has no access to wholesale cost.
11. Sign in as `am@demo.test`. You can read the board, but cards are not draggable and
    there is no **New placement** button — the account manager holds `placements:approve`
    rather than `placements:write`. Recording a client decision is done through
    `POST /api/v1/placements/:id/client-decision`, which *does* accept this role.
12. Sign in as `client@demo.test`. Sign-in is refused with "This sign-in type cannot
    access that area of the application" — the portal UI does not exist yet. The
    portal *API* is isolated: `GET /portal/v1/placements` with that account's token
    returns only approved-or-later placements, with no `internal_notes`, no agreed
    cost and no assignee fields.

**Outreach**

13. Go to **Outreach**. The page states plainly that sending is disabled. There is a
    record list and, if any are overdue, a follow-up queue.
14. Press **Send** on a record. It fails with a 503 explaining that no provider is
    configured and naming `EMAIL_PROVIDER`. Nothing is marked sent.
15. Press **Log**, pick a channel and outcome, and save. The record becomes `Sent`, the
    follow-up counter increments, and a touchpoint appears in the prospect's history.
16. Open a record and record a response — the prospect's stage advances accordingly.

**Responsive**

17. Narrow the window to phone width. The page itself must not scroll horizontally;
    the board scrolls within its own container, one column at a time. Open the
    navigation drawer and confirm it closes when you navigate.

**Invariants worth trying to break**

18. Create a placement through the API with `"pipelineStage": "live"` — it is refused.
    A new placement must start at `prospected` or `pitched`.
19. Try to reach `live` without a URL. Refused at the API, and the database constraint
    rejects it too, so a direct SQL insert fails rather than storing a live link that
    monitoring cannot check.

---

## Manually testing Phase 5

Sign in at http://localhost:5173 as `owner@demo.test` / `password123`.

**Content workflow**

1. Go to **Content**. Briefs are listed with their status and word count. (If the list
   is empty, the database has no briefs — create one against a placement.)
2. Click a brief. The editor opens with the draft text, its version and word count.
3. Edit the text and press **Save version**. The version number increments; the old
   text is still there under **History**.
4. Press **Submit for review**. The status becomes *In review* and the Approve /
   Request changes buttons appear for a reviewer.
5. Sign in as `writer@demo.test` and open the same draft: the writer sees
   **Submit for review** but no **Approve**. That is the point of the permission split.
6. As the owner, press **Request changes** with no notes — the button stays disabled.
   Type a note and send it; the draft becomes *Revision requested* and the note shows
   above the editor.
7. As the writer, edit and save. The draft returns to *In review* and the revision
   request is resolved — not straight to approved.
8. Approve, then **Mark published**. The editor becomes read-only and further saves
   are refused.
9. Open **History** and restore an earlier version. A *new* version is created with
   the old text; the intermediate ones remain. Note that restore is refused while the
   draft is in review or approved — request a revision first.
10. **Client sign-off.** Submit a draft for review, then use
    `GET /portal/v1/drafts` with `client@demo.test`'s token: the draft appears only
    if its campaign belongs to Acme SaaS. `POST /portal/v1/drafts/:id/approve`
    approves it; a second call is refused. A draft on Beta Commerce's campaign stays
    invisible, which is the isolation guarantee.

**Anchor analytics**

10. Go to **Anchors**. The donut shows the distribution across live links, and each
    bar shows its share over the healthy range.
11. Switch between **By Campaign** and **By Client** — both scopes work.
12. Check that the alert panel agrees with the bars: a category shown red should
    appear in the firing list with its threshold.
13. Press **Classify** to categorise any unclassified anchors. The note below the
    donut says how many are excluded from the shares.
14. Press **New alert**, set a category and a maximum share, and save. It appears in
    the alert list, can be toggled off, and can be deleted.
15. Try a max share of 150% — refused. Try a min share above the max — refused.

**Backlink verification**

16. Pick a placement with a live URL. `POST /api/v1/placements/:id/check` returns a
    verdict: `ok`, `link_missing`, `url_mismatch`, `anchor_mismatch`, `attr_mismatch`
    or `unreachable`.
17. Try to set a live URL of `http://127.0.0.1:9/metadata` — refused at write time
    with a 400. Try `http://169.254.169.254/` and `file:///etc/passwd` — both refused.
18. A legitimate public URL is accepted, and a verification against an unreachable
    host records `unreachable` — not `link_missing`, which would falsely claim the
    link was removed from a page we never read.
19. Check `GET /api/v1/placements/:id/checks` — the row records the verdict, the
    expected and found URL, the anchor comparison and the failure reason.

**Permissions**

20. `publisher@demo.test` is refused on `/content` and `/anchors` (403).
21. A content writer cannot approve, and cannot configure alerts.

**Responsive**

22. Narrow to phone width. Neither page should scroll horizontally; the content list
    stacks above the editor.

---

## Manually testing Phase 5.1

Two surfaces, two accounts. The point of most of this is that they stay separate.

| Role | Email | Password | Lands on |
|---|---|---|---|
| Account Manager | `am@demo.test` | `password123` | `/` |
| Client | `client@demo.test` | `password123` | `/portal` |

Start both (`pnpm dev:api`, `pnpm dev:web`) and open <http://localhost:5173>.

### A. The client portal

1. Sign in as `client@demo.test`. You land on **/portal**, not the CRM.
2. The header says "Client portal" and the nav has exactly three items: Overview,
   Campaigns, Content. There is no Placements, Outreach, Anchors, Approvals or Staff.
3. Overview shows **Awaiting your review** first, above the stat tiles. That ordering
   is deliberate — the queue is the only thing on the page that needs action.
4. Open a campaign. Placements show target page, anchor, stage, index status and a
   live link. No cost, no assignee and no internal note appears anywhere.
5. Open **Content**. Filter by status; the counts on each filter are correct.
6. Open a draft in review. The body is readable and there is **no way to edit it** —
   no textarea on the body, no save. The only text field is the approval note.
7. Click **Request changes** and type fewer than three characters: the send button
   stays disabled. Write a real note and send it. The status becomes
   revision_requested and an inline banner confirms it.
8. As `am@demo.test`, the revision is visible on `/content` with the note.
9. Back as the client, approve the draft. The status becomes Approved and your note
   appears in the Status panel.
10. Try approving it again — the API refuses and the UI offers no button.

### B. Typing internal URLs as a client

11. While signed in as the client, enter `/placements`, `/approvals`, `/staff` in the
    address bar. Each sends you back to `/portal`; none renders an internal screen.
12. In devtools, copy the client's access token and call `GET /api/v1/content/drafts`
    with it. It returns **403** — the surface boundary is enforced by the API, not by
    the route guard.

### C. The Account Manager approval queue

13. Sign in as `am@demo.test`. You land on the CRM dashboard; `/portal` sends you back.
14. **Approvals** is in the sidebar, between Dashboard and Reports. Only roles holding
    `placements:approve` see it, so the writer does not.
15. The page has four tabs with live counts: Placements, Content, Prospects, Publishers.
16. On a placement, click **Decide**. Choose "Client rejected" and confirm the button
    stays disabled until you write a reason. Submit; the row leaves the queue.
17. On a draft, click **Review** and request changes with a note. It leaves the queue
    and appears on `/content` as revision_requested.
18. Confirm the AM **cannot** drag cards on `/placements` and has no "New placement"
    button — they hold `placements:approve`, not `placements:write`.

### D. Notifications and anchor alerts

19. The bell sits in the header beside the theme switch. As owner or AM it shows an
    unread count.
20. Trigger an alert: set a campaign's rule below its current share (Anchors →
    Alerts), or `POST /api/v1/anchors/alerts` with `max_share: 0.01`.
21. Run the job — either wait for the `pg_cron` schedule or run
    `node scripts/test-phase5-1-jobs.mjs`, which signs a real invocation.
22. The bell badge increments. Open it: the alert names the campaign, category and the
    numbers, and clicking it goes to `/anchors`. No cost or margin appears.
23. Run the job again immediately. The count does **not** double — the unresolved
    alert is deduplicated.
24. Mark it read, then run the job again. A new notification appears, because
    resolving an alert lets it fire again if it recurs.
25. Sign in as the client: clients receive no internal notifications and cannot call
    `/api/v1/notifications` at all.

### E. Scheduling survives a restart

26. Stop the API process entirely.
27. Inspect the schedule with `select jobname, schedule, active from cron.job;`. All
    three jobs remain listed and active — the schedule lives in Postgres, so it does
    not depend on the Node process.
28. Restart the API. The next tick succeeds. Check
    `select job_name, status, detail, started_at, finished_at from job_runs order by started_at desc limit 10;`
    — each run shows `ok` or `error` with a message, plus a duration.

### F. JavaScript-rendered pages and SSRF

29. A page whose link only exists after JavaScript now reports `needs_manual_review`
    with a reason, instead of `link_missing`. Trigger a check from a placement, then
    inspect `link_checks.verdict`.
30. Confirm SSRF is untouched: point a placement's `live_url` at
    `http://127.0.0.1:3000` and run the check. The verdict is `unreachable` and the
    refusal is logged. `node scripts/test-phase5-1-verification.mjs` covers this and
    the verdict constraint.

---

## Admin customization (Phase 7)

The Super Admin can rename tabs, hide modules, choose table columns, restyle the
app, upload a logo, and manage custom fields and saved views — all stored in
PostgreSQL as **metadata**, never as schema changes. The Admin panel has no SQL
execution path of any kind.

### The one rule that governs everything

**Customization may only NARROW what RBAC already allows.**

A config can hide a module from a role. It can never reveal one. That is enforced
in three places, and the design is built so a mistake in any one is not enough:

1. **The schema is closed.** `UIConfigSchema` uses `.strict()` with enums drawn from
   a registry. A config cannot name a module, column or widget that does not exist,
   and an unknown key is a `400` rather than a silently stored value.
2. **The combination is a filter, never a union.** `effectiveModules()` applies RBAC
   *first* and then subtracts what config hides. There is no code path where config
   adds a module — `modules[x] = true` means "not disabled", not "grant".
3. **The outcome is verified, not the input.** `findPermissionWidening()` computes
   the effective module list for *every* role with the config applied and compares
   it to the same list with no config. A config that produced a module RBAC would
   not is rejected. Testing the outcome means the check stays correct even if the
   implementation changes later.

`pnpm audit:phase7-config` attacks this directly: it marks every module enabled for
a writer and asserts the writer *still* cannot see finance, staff or settings.

### What is stored where

| Concern | Storage |
|---|---|
| Nav labels, module toggles, columns, dashboard, theme, app name | `ui_settings.config` (one validated JSONB document per org) |
| Accent colour, logo | `organizations.brand_color`, `organizations.logo_url` — **the same columns the invoice PDF reads**, so the app and the bills clients receive cannot drift |
| Custom fields | `custom_field_definitions` + `custom_field_values` (existing tables) |
| Saved views | `saved_views` (existing table, plus `is_default` / `is_system`) |
| Notification muting | `notification_preferences` (own-row only) |

### Logo upload safety

A logo is rendered by the sidebar, the login screen and **every invoice PDF**, so
the upload path is treated as hostile input:

- **256 KB cap**, checked on the encoded length before decoding.
- **Magic bytes**, not the declared MIME type — a file claiming `image/png` that
  actually contains HTML is rejected.
- **SVG is sanitised**: `<script>`, `<foreignObject>`, every `on*` handler and
  `javascript:` URLs are stripped.
- **Read validation too.** If a stored config fails the schema (a manual edit, an
  older shape), the API serves defaults and reports `valid: false` instead of
  handing an invalid document to the client.

### Branding: Trivero Marketing

The business name and mark live in `organizations`, seeded from
`Logo/Trivero Logo.png` (a 71.8 KB PNG) through `scripts/seed-logo.mjs`. That script
calls the **real upload endpoint** rather than writing the column directly — a
direct write would pass even if the upload were broken, so a `db:reset` now proves
the feature end to end.

`VITE_APP_NAME` remains the build-time default for the pre-auth login screen; the
database value takes over from the first authenticated paint.

## Manually testing Phase 7

Sign in as `owner@demo.test` / `password123`.

### A. The Trivero identity

1. The sidebar shows the **Trivero logo** (blue/cyan mark) and "Trivero Marketing".
2. The browser tab reads "Trivero Marketing — Link Building CRM".
3. Open any invoice and click **Download PDF** — the PDF header carries the same
   logo and the indigo brand rule.

### B. Navigation customization

4. Go to **Admin** (Administration section — you may need to scroll the sidebar).
5. On **Navigation**, change "Placements" to "Campaign Links" and press **Save changes**.
6. The sidebar updates immediately.
7. **Reload the page.** The label persists.
8. **Sign out and sign back in.** The label still persists — this is the requirement
   that customization survives a new session.
9. Press **Reset all** to restore the original names.

### C. Modules

10. On **Modules**, disable `/outreach`.
11. The Outreach item disappears from the sidebar.
12. Type `/outreach` in the address bar: you get the "no access" screen.
13. Note the deliberate distinction: the API still permits the *data* — hiding a
    module is a menu decision, not a permission revocation.

### D. Columns, dashboard, theme

14. On **Columns**, select columns for `/invoices`. The order you click is the order
    they appear (numbered badges show it).
15. On **Dashboard**, reorder widgets with the arrows and hide one with the eye icon.
16. On **Theme**, pick a preset or enter a hex. The whole app recolours immediately,
    including hover shades — not just one button.
17. Reset all when finished.

### E. Branding

18. On **Branding**, the current logo is shown. Upload a different PNG under 256 KB
    and it appears in the sidebar at once.
19. Try a file over 256 KB: it is refused with the size named.
20. **Remove** restores the fallback tile.

### F. Roles — the security boundary

21. On **Roles**, the matrix greys out modules each role cannot reach. `/finance` is
    greyed for the account manager; `/content` is only enabled for the writer.
22. Tick a box to hide a module from a role that *can* reach it. This only ever
    removes.
23. There is no control anywhere that grants a module to a role lacking its
    permission — check the API directly if you want proof:
    `GET /api/v1/admin/ui/effective` as `writer@demo.test` never lists `/finance`.

### G. Custom fields and views

24. `GET /api/v1/admin/fields` as owner lists definitions; as `am@demo.test` it
    returns 403.
25. A field with recorded values cannot have its key or type changed, and cannot be
    deleted — deactivate it instead, and the values survive.

### H. Responsive

26. Narrow the Admin page to phone width. It does not scroll horizontally; the
    tables scroll inside their own containers.

---

## Manually testing Phase 6

| Role | Email | Password | Sees |
|---|---|---|---|
| Owner | `owner@demo.test` | `password123` | Everything, including margin and payouts |
| Account Manager | `am@demo.test` | `password123` | Invoices, no margin, can share but not edit |
| Client | `client@demo.test` | `password123` | Their own invoices, in the portal |

Start both (`pnpm dev:api`, `pnpm dev:web`) and open <http://localhost:5173>.

### A. Creating an invoice

1. As owner, go to **Invoices → New invoice**.
2. Pick a client. Enter a period and a tax rate of 20.
3. Add two lines: `1000 × 1` and `125.50 × 2`. The Totals panel shows
   **$1,251.00** subtotal and **$1,501.20** total — tax applied to the full subtotal.
4. Set a discount of **250**. Tax becomes **$200.20** and the total **$1,201.20** —
   the discount is applied *before* tax. This ordering is the single most important
   detail on the screen.
5. Save. You land on the detail page, in `Draft`.

### B. Issue, then edit is blocked

6. Click **Issue invoice**. The status becomes `Issued` and a **Version v1** appears
   in the Details panel — that is the frozen snapshot.
7. Try to edit it: the API refuses with "Only draft invoices can be edited." The UI
   no longer offers an edit form.
8. Click **Preview**. The dialog shows the document. Note it says this is what the
   PDF contains.
9. Click **Download PDF**. The PDF should match the preview exactly, with the
   discount printed as `($250.00)` in parentheses — a deduction, never an
   unmarked positive.

### C. Payments and the derived status

10. Click **Record** under Payments. Leave the amount blank to pay the full balance,
    choose *Bank transfer*, and save.
11. The badge becomes **Paid**, the balance **$0.00**, and the payment appears in the
    history with a timestamp.
12. Click the reverse (undo) icon on that payment. The invoice returns to `Issued`
    and the balance is restored — status is derived from the payments, not stored.
13. Record a **partial** payment of, say, $400. The badge becomes **Part paid** and
    the balance shows the remainder.

### D. Publishing and the public link

14. Click **Publish invoice**. A dialog appears — publishing is never automatic. It
    states that anyone with the link can view the invoice and that internal costs are
    never included. Confirm.
15. The share panel now reads **Public link active** and shows the URL. Copy it.
16. Open the link in a **private window** — no sign-in is required. The page shows the
    invoice number, lines, totals and payment instructions, with no CRM navigation.
17. Check the page source for `<meta name="robots" content="noindex">`. The API also
    sends `X-Robots-Tag`.
18. Search the page for `cost`, `margin`, `payout`, `profit` — none appear.
19. Click **Download PDF** there; it works without a session.
20. Back in the app, click **Revoke public link**. Reload the private window: the page
    now says the link is not available. It does **not** say it was revoked.
21. Re-publish and click **Rotate public link**. The old URL stops working immediately
    and the new one works — the raw token is shown once and only its hash is stored.

### E. Overdue and cancellation

22. Create an invoice with a due date in the past, issue it, and reload. The badge
    reads **Overdue** with a day count. This is derived from the date; no job wrote it.
23. Pay it in full. The badge becomes **Paid** — money beats lateness in the ladder.
24. Create another invoice, record a payment, then try **Cancel**. It is refused,
    because a payment would be stranded. Reverse the payment first, then cancel.

### F. Financial privacy

25. As **owner**, open **Financials**. You see billed, outstanding AR, publisher costs
    owed, revenue, publisher cost, gross profit and margin, plus campaign
    profitability with a CSV export.
26. As **am@demo.test**, note **Financials is absent from the sidebar**. Type
    `/finance` directly: you get "You don't have access to this section".
27. As the AM, open an invoice and observe you can **share** it but there is no
    **Duplicate** and no edit — `invoices:share` is separate from `invoices:write`.
28. Try the API directly with the AM's token:
    `GET /api/v1/reports/campaigns` → 403. `GET /api/v1/payouts` → 403.
29. As **client@demo.test**, the portal shows **Invoices**. Only their own appear, and
    there is no cost, margin or payout anywhere.

### G. Reports and exports (owner)

30. Go to **Reports**. Each card names its audience — the client report is marked
    *Client-safe*, the internal ones *Owner only*.
31. Download the **Financial report** as CSV. It opens in Excel with accents intact
    (the UTF-8 BOM) and one row per currency.
32. Download it as **Excel**. The money cells are numeric with a currency format, so
    they can be summed. The header row is frozen.
33. Confirm an export never shows a column the screen hides — they share one column
    definition.

### H. Responsive

34. Narrow the invoice list to phone width. The table scrolls inside its own
    container; the page itself does not scroll sideways.
35. On the public invoice page at mobile width, the totals remain right-aligned and
    readable.
