# Phase 3 progress

Honest status of the Core CRM Management phase.

## Done and compiling

**Schema (migrations 0009, 0010)**
- Publishers: `website_url`, `contact_name`, `spam_score`, `spam_source`, `price`,
  `currency`, `accepts_link_insertion`. A trigger appends every price change to
  `publisher_offers`, so the scalar is "now" and the table is "history".
- Prospects: full metric set (`dr`, `monthly_traffic`, `spam_score`, `niche`,
  `price`, `website_url`) inherited from a linked publisher when absent.
- **Agency partners**: a new table with its own RLS. Distinct from clients —
  pricing model, white-label reporting, payment terms.
- Trigram indexes for search on every searchable column.
- `import_jobs` for previewable, auditable CSV imports.

**API**
- `lib/crud.ts` — shared sort allowlists, escaped search, pagination meta,
  camel→snake patching, cross-org FK assertion.
- `lib/csv.ts` — RFC-4180 parser, formula-injection-safe writer, per-row verdicts.
- `lib/import-engine.ts` — duplicate detection against BOTH the database and
  earlier rows in the same file; preview persisted so commit applies exactly what
  was shown.
- `modules/clients`, `agency-partners`, `publishers`, `prospects`, `campaigns` —
  full CRUD, search, filters, sorting, pagination, archive/restore, related-record
  views, CSV export, and per-module filter option endpoints.
- `modules/import` — preview / commit / cancel / template, with per-entity specs
  whose column aliases accept "DR", "Domain Rating", "domain_rating" alike.

**Shared**
- `crm-schemas.ts` — one query shape for all five modules; per-module sort
  allowlists; import contract types.

## Not done

The Phase 3 brief also asks for **UI** for each module: tables, forms, import
wizard. That is not built yet. The API and schema are complete and typechecked;
the front end still shows Phase 0 placeholders for these routes.

## Deliberate decisions worth knowing

1. **The Supabase client stays untyped.** I generated 80KB of types into
   `packages/db/types/database.ts`, then tried parameterising the client. It
   produced a cascade of inference errors because several modules build their
   column lists by string concatenation. Rather than silence them with casts, I
   kept the client untyped and left the generated types in place for a deliberate
   migration. Consistency beats half-typing.
2. **`diffOf` accepts `unknown`** for the same reason: it is the one place that
   narrows an untyped row into an audit diff.
3. **Archive, never hard-delete**, for every module. A deleted client would
   orphan its campaigns, placements and invoices. Archiving goes through a
   SECURITY DEFINER function (migration `0012`) — see the bug list below.
4. **Import commits read the stored preview**, never the request body. A caller
   cannot supply their own "these rows are valid" verdicts.

## Bugs the CRUD suite found (all fixed)

These were caught by the first Phase 3 test run.

1. **`campaigns.notes` did not exist.** The API, the import spec and the PATCH map
   all referenced it, so every campaign list/create/update returned 500. The
   column was assumed rather than verified — exactly what an untyped Supabase
   client cannot catch, and the reason the CRUD test exists. Fixed in `0011`.
2. **Archiving failed under RLS.** A plain `UPDATE ... SET deleted_at` stops the
   row matching the SELECT policy, and PostgreSQL re-checks the row on the way
   out: `new row violates row-level security policy`. Fixed by moving archive and
   restore into `app_private.archive_record` / `restore_record`, called through
   public wrappers (migration `0012`). The functions re-derive organisation and
   role from the caller's own claims, so tenancy is still enforced.
3. **The wrappers were SECURITY INVOKER** and therefore could not reach
   `app_private` — `permission denied for schema app_private`. The same mistake
   as the custom access token hook in migration `0001`. Changed to SECURITY
   DEFINER, which is safe because the inner function re-checks the caller.

## Bugs the review found (all fixed)

These were missed by the first round of Phase 3 tests, because none of those
tests imported a campaign, exported and re-imported a publisher, or searched
with punctuation.

4. **Campaign import could not detect duplicates at all.** The spec built its
   dedupe key as `clientId::name` while the engine compared it against a bare
   `name` column, so the two never matched — a preview reported "ok" and the
   commit inserted a second campaign with an identical name. Fixed by giving the
   engine an explicit `keyColumns` list plus a `keyOfExisting` builder, so both
   sides use the same key. Migration `0013` adds a partial unique index on
   `(organization, client, lower(name))` so the database refuses it too.
5. **Prospect import ignored campaign scope.** The DB is unique on
   `(campaign_id, domain)`, but the importer keyed on `domain` alone, so the same
   site in a second campaign was wrongly rejected as a duplicate. The lookup is
   now scoped to the parent campaign.
6. **CSV round-trip was broken.** The exporter writes `""` for an empty cell, but
   the publisher schema required exactly 2 characters for `country` and an enum
   member for `linkType`/`status`. Every publisher without a country failed to
   re-import. Empty cells are now treated as "not supplied".
7. **Search with punctuation returned 500.** `?q=a,b(c)` backslash-escaped
   PostgREST's logic-tree characters, which the parser rejects outright
   ("failed to parse logic tree"). Structural characters are now stripped, and a
   term that strips to nothing yields no filter rather than matching every row.
8. **One user could commit another user's import preview.** Within the same
   organisation, an account manager could commit a file a colleague had reviewed
   and rejected. Now only the creator or the owner may commit.
9. **Test isolation:** the authorization suite wrote a supplier cost onto an
   unpriced placement and never removed it, silently distorting the profitability
   report for every other suite. It now picks a placement that already has both
   tiers and restores the exact original.

## Verification

| Suite | Result |
|---|---|
| `pnpm typecheck` (5 packages) | clean |
| Unit + RLS (`pnpm test`) | 70 passing |
| Authorization suite | 86 passing |
| API smoke | 45 passing |
| Phase 3 CRUD + import + permissions | 75 passing |
| Import duplicate detection | 7 passing |
| CSV round-trip + search safety | 20 passing |
| Import authorization | 5 passing |
| Privilege-escalation attacks | 7 safe, 0 vulnerabilities |
| Migrations from an empty database | 13 applied cleanly |

## Still outstanding

The front-end UI for these five modules is not built. The API, schema, import
pipeline and permissions are complete and verified; the routes still render
Phase 0 placeholders.
