-- ============================================================================
-- 0013 — Enforce campaign uniqueness at the database level
--
-- Found in review: campaign CSV import could not detect duplicates at all. The
-- importer built its dedupe key as `clientId::name` while the engine compared it
-- against a bare `name` column, so the two never matched. A preview reported
-- "ok" and the commit inserted a second campaign with an identical name.
--
-- The application-level key is now fixed (both sides use the same builder), but
-- an app-only guard is not enough: two concurrent commits, or any future code
-- path, could still create a duplicate. A UNIQUE index makes it impossible.
--
-- Scope is (organization, client, lower(name)) since a campaign name only needs
-- to be unique within its client — two different clients may legitimately both
-- run a campaign called "Q1 Guest Posts".
-- ============================================================================

-- Collapse any duplicates that already exist before adding the constraint, so
-- this migration applies cleanly to a database that ran the broken importer.
-- Keeps the OLDEST row (the original) and archives the rest rather than deleting
-- them: a campaign row is referenced by prospects and placements.
with ranked as (
  select
    id,
    row_number() over (
      partition by organization_id, client_id, lower(name)
      order by created_at asc, id asc
    ) as rn
  from public.campaigns
  where deleted_at is null
)
update public.campaigns c
set deleted_at = now(),
    notes = coalesce(c.notes || E'\n', '') || 'Archived by migration 0013: duplicate campaign name'
from ranked r
where c.id = r.id
  and r.rn > 1;

create unique index if not exists campaigns_org_client_name_idx
  on public.campaigns (organization_id, client_id, lower(name))
  where deleted_at is null;

comment on index public.campaigns_org_client_name_idx is
  'A campaign name is unique per client. Added in 0013 after the CSV importer was found creating duplicates.';
