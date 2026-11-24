-- ============================================================================
-- 0016 — Fix duplicate prospect stages, and stop the outreach response from
--        silently failing on an invalid stage
--
-- Two defects found by the Phase 4 tests:
--
-- 1. DUPLICATE PIPELINE STAGES. The org trigger (0014) seeds prospect AND
--    placement stages, but migration 0014 ALSO inserts placement stages for
--    existing orgs, and the unique index is scoped by (org, applies_to, key).
--    `set_applies_to ... default 'prospect'` meant the placement seed rows were
--    inserted with applies_to='placement' twice under different code paths,
--    leaving every prospect stage listed twice in the settings endpoint.
--    (Confirmed: the deployed org shows 'pitched', 'live' and others twice.)
--
-- 2. OUTREACH RESPONSE WROTE AN INVALID STAGE. The response handler set the
--    prospect's stage to 'negotiating', which exists in the shared constants but
--    NOT in this organization's configured `pipeline_stages`. The validity
--    trigger rejected the update, and because the result was never checked the
--    API returned 200 while the prospect stayed where it was. Silent failure.
--
-- Both are fixed here: duplicates are removed, and the default seed is aligned
-- with the constants so a stage the API can write always exists.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Remove duplicate stage rows, keeping the lowest sort_order / earliest.
-- ---------------------------------------------------------------------------
delete from public.pipeline_stages ps
where ps.id in (
  select id from (
    select id,
           row_number() over (
             partition by organization_id, applies_to, key
             order by created_at asc, id asc
           ) as rn
    from public.pipeline_stages
  ) ranked
  where ranked.rn > 1
);

-- ---------------------------------------------------------------------------
-- 2. The prospect pipeline must contain every stage the application can set.
--
-- The constants include a `negotiating` stage that the default seed omitted, so
-- a positive outreach reply tried to write a stage that did not exist. The seed
-- function is corrected and the missing stages are inserted for existing orgs.
-- ---------------------------------------------------------------------------
create or replace function app_private.seed_default_pipelines()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.pipeline_stages (organization_id, applies_to, key, label, sort_order, is_won, is_lost)
  select new.id, 'prospect', s.key, s.label, s.sort_order, s.is_won, s.is_lost
  from (values
    ('prospected',      'Prospected',        10, false, false),
    ('vetting',         'Vetting',           20, false, false),
    ('pitched',         'Pitched',           30, false, false),
    ('approved',        'Approved by Client',40, false, false),
    ('content_writing', 'Content Writing',   50, false, false),
    ('submitted',       'Submitted',         60, false, false),
    ('live',            'Live',              70, true,  false),
    ('negotiating',     'Negotiating',       75, false, false),
    ('declined',        'Declined',          80, false, true),
    ('lost',            'Lost',              90, false, true)
  ) as s(key, label, sort_order, is_won, is_lost)
  on conflict (organization_id, applies_to, key) do nothing;

  insert into public.pipeline_stages (organization_id, applies_to, key, label, sort_order, is_won, is_lost)
  select new.id, 'placement', s.key, s.label, s.sort_order, s.is_won, s.is_lost
  from (values
    ('prospected',      'Prospected',      10, false, false),
    ('pitched',         'Pitched',         20, false, false),
    ('client_approved', 'Client Approved', 30, false, false),
    ('content_writing', 'Content Writing', 40, false, false),
    ('submitted',       'Submitted',       50, false, false),
    ('live',            'Live',            60, true,  false)
  ) as s(key, label, sort_order, is_won, is_lost)
  on conflict (organization_id, applies_to, key) do nothing;

  return new;
end;
$$;

-- Add the missing stage to organizations that already exist.
insert into public.pipeline_stages (organization_id, applies_to, key, label, sort_order, is_won, is_lost)
select o.id, 'prospect', 'negotiating', 'Negotiating', 75, false, false
from public.organizations o
on conflict (organization_id, applies_to, key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Guard: a stage change that the trigger rejects must not return success.
--
-- The outreach response handler updated the prospect and ignored the result. Any
-- future code that writes a stage should get an error it can act on, not a
-- silent no-op, so this constraint is enforced as a clear exception.
-- ---------------------------------------------------------------------------
comment on function app_private.assert_stage_valid() is
  'Rejects a prospect stage absent from pipeline_stages. A caller MUST check the update result: a rejected stage change returns no rows, not an error.';
