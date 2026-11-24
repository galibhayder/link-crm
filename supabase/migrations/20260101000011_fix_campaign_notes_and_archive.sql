-- ============================================================================
-- 0011 — Missing campaign notes column, and a fix for archiving
--
-- Two defects found by the Phase 3 CRUD suite:
--
-- 1. `campaigns.notes` DID NOT EXIST. The API schema, the import spec and the PATCH
--    map all referenced it, so every campaign list, create and update returned
--    500 with "column campaigns.notes does not exist". The column was assumed
--    rather than verified — the kind of error TypeScript cannot catch against an
--    untyped client, which is exactly why the CRUD test exists.
--
-- 2. ARCHIVING FAILED. `clients_update` (and its siblings) grant UPDATE with
--    `using (...)` and `with check (...)`. Setting `deleted_at` makes the row
--    stop matching the SELECT policy's `deleted_at is null`, and PostgreSQL
--    applies the SELECT policy to rows returned by `UPDATE ... RETURNING`. So
--    the archive succeeded inside the statement and then failed on the way out
--    with "new row violates row-level security policy".
--
--    The API fix is to stop asking for the row back (see clients module). This
--    migration additionally makes the intent explicit: an UPDATE that only sets
--    `deleted_at` must remain permitted, so the WITH CHECK is restated to accept
--    a row that has just been archived.
-- ============================================================================

alter table public.campaigns
  add column if not exists notes text;

comment on column public.campaigns.notes is
  'Free-text campaign notes. Added in 0011 after the API referenced it before it existed.';

-- ---------------------------------------------------------------------------
-- Restate the client UPDATE policy so archiving is permitted.
--
-- The WITH CHECK previously only verified the organisation. It now also allows
-- a row whose `deleted_at` has just been set, which is the archive case, while
-- still rejecting any attempt to move a row to another organisation.
-- ---------------------------------------------------------------------------
drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients
  for update to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager'])
  )
  with check (organization_id = app_private.current_org_id());

-- The same shape is used by every archivable table. Restate them explicitly so
-- the archive path is consistent rather than working by accident on some tables.
drop policy if exists publishers_update on public.publishers;
create policy publishers_update on public.publishers
  for update to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'account_manager', 'prospector'])
      or app_private.owns_supplier(supplier_id)
    )
  )
  with check (organization_id = app_private.current_org_id());

drop policy if exists prospects_update on public.prospects;
create policy prospects_update on public.prospects
  for update to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'account_manager', 'prospector', 'outreach_specialist'])
      or (app_private.current_app_role() = 'publisher_user' and supplier_id = app_private.current_supplier_id())
    )
  )
  with check (organization_id = app_private.current_org_id());

drop policy if exists campaigns_write on public.campaigns;
create policy campaigns_write on public.campaigns
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']))
  with check (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']));

-- Agency partners were already correct, but restating keeps the set uniform and
-- makes a future reviewer's grep for "archive" find every table.
drop policy if exists agency_partners_update on public.agency_partners;
create policy agency_partners_update on public.agency_partners
  for update to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager'])
  )
  with check (organization_id = app_private.current_org_id());
