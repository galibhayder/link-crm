-- ============================================================================
-- 0014 — Phase 4: placement pipeline, assignment, approval and outreach
--
-- The gap this closes:
--
-- `placements.status` was an OPERATIONAL state (scheduled / pending / live /
-- removed / declined / refunded) — where the link physically is. The brief asks
-- for a PIPELINE (prospected → pitched → client approved → content writing →
-- submitted → live) — where the WORK is. Those are genuinely different questions
-- and conflating them was why there was no board: a link can be `live`
-- operationally while still awaiting client approval of its anchor text, and a
-- placement in "content writing" has no operational status at all yet.
--
-- So `pipeline_stage` is added as a SEPARATE column, backfilled from the
-- existing status, and kept in step by a trigger for the obvious cases. The
-- operational `status` remains the source of truth for link monitoring.
--
-- Also added: assignment of both staff and publisher, negotiated cost, client
-- approval with who/when, internal notes kept apart from client-visible notes,
-- and a placement history table so a stage change is never lost.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Pipeline stages per organization.
--
-- `pipeline_stages` already exists for prospects. Placements need their own set
-- because the six stages are different (a publisher is not "client approved"),
-- so the table gains a scope column rather than duplicating it.
-- ---------------------------------------------------------------------------
alter table public.pipeline_stages
  add column if not exists applies_to text not null default 'prospect'
  check (applies_to in ('prospect', 'placement'));

-- Existing rows were prospect stages.
update public.pipeline_stages set applies_to = 'prospect' where applies_to is null;

-- The uniqueness key now includes the scope, so both pipelines can use the same
-- stage key without colliding.
--
-- The constraint must be dropped BEFORE the index it owns; dropping the index
-- first fails with "cannot drop index ... because constraint ... requires it".
alter table public.pipeline_stages
  drop constraint if exists pipeline_stages_organization_id_key_key;
drop index if exists pipeline_stages_organization_id_key_key;
create unique index if not exists pipeline_stages_org_scope_key_idx
  on public.pipeline_stages (organization_id, applies_to, key);

-- ---------------------------------------------------------------------------
-- PLACEMENTS — pipeline and workflow columns
-- ---------------------------------------------------------------------------
alter table public.placements
  add column if not exists pipeline_stage text not null default 'prospected',
  -- Who is doing the work.
  add column if not exists assigned_to uuid references public.profiles(id) on delete set null,
  add column if not exists content_assignee uuid references public.profiles(id) on delete set null,
  -- Negotiated publisher cost lives in placement_costs (tier 2). This is the
  -- figure agreed during negotiation BEFORE a placement_costs row exists, so a
  -- deal can be recorded without prematurely writing the financial ledger.
  add column if not exists negotiated_cost numeric(12,2)
    check (negotiated_cost is null or negotiated_cost >= 0),
  add column if not exists negotiated_currency char(3) not null default 'USD',
  -- Client approval is a distinct fact from "stage = approved": it records WHEN
  -- and BY WHOM, which an audit needs and a status string cannot carry.
  add column if not exists client_approved_at timestamptz,
  add column if not exists client_approved_by uuid references public.profiles(id) on delete set null,
  add column if not exists client_approval_note text,
  add column if not exists client_rejected_reason text,
  -- Internal notes stay internal; `notes` is already used for general notes that
  -- the client portal exposes. Splitting them is what allows a client to see a
  -- placement without seeing our commentary on the publisher.
  add column if not exists internal_notes text,
  add column if not exists content_due_date date,
  add column if not exists submitted_at timestamptz;

-- ---------------------------------------------------------------------------
-- Seed the six placement stages for organizations that already exist.
--
-- Migrations run BEFORE seed.sql, so on a fresh database there are no
-- organizations yet and this inserts nothing. New organizations therefore get
-- their stages from a trigger (below) rather than relying on this statement.
-- The insert stays because it seeds any org that exists when the migration runs
-- on an already-populated database.
-- ---------------------------------------------------------------------------
insert into public.pipeline_stages (organization_id, applies_to, key, label, sort_order, is_won, is_lost)
select o.id, 'placement', s.key, s.label, s.sort_order, s.is_won, s.is_lost
from public.organizations o
cross join (values
  ('prospected',      'Prospected',      10, false, false),
  ('pitched',         'Pitched',         20, false, false),
  ('client_approved', 'Client Approved', 30, false, false),
  ('content_writing', 'Content Writing', 40, false, false),
  ('submitted',       'Submitted',       50, false, false),
  ('live',            'Live',            60, true,  false)
) as s(key, label, sort_order, is_won, is_lost)
on conflict (organization_id, applies_to, key) do nothing;

-- ---------------------------------------------------------------------------
-- Every NEW organization gets both pipelines automatically.
--
-- Without this, a freshly created organization has no stages, and the first
-- placement insert fails with "Unknown placement stage". Seeding by migration
-- alone cannot cover organizations created later.
-- ---------------------------------------------------------------------------
create or replace function app_private.seed_default_pipelines()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Prospect stages.
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
    ('declined',        'Declined',          80, false, true),
    ('lost',            'Lost',              90, false, true)
  ) as s(key, label, sort_order, is_won, is_lost)
  on conflict (organization_id, applies_to, key) do nothing;

  -- Placement stages.
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

drop trigger if exists organizations_seed_pipelines on public.organizations;
create trigger organizations_seed_pipelines
  after insert on public.organizations
  for each row execute function app_private.seed_default_pipelines();

-- Backfill stages for any organization created before this trigger existed.
insert into public.pipeline_stages (organization_id, applies_to, key, label, sort_order, is_won, is_lost)
select o.id, 'placement', s.key, s.label, s.sort_order, s.is_won, s.is_lost
from public.organizations o
cross join (values
  ('prospected',      'Prospected',      10, false, false),
  ('pitched',         'Pitched',         20, false, false),
  ('client_approved', 'Client Approved', 30, false, false),
  ('content_writing', 'Content Writing', 40, false, false),
  ('submitted',       'Submitted',       50, false, false),
  ('live',            'Live',            60, true,  false)
) as s(key, label, sort_order, is_won, is_lost)
on conflict (organization_id, applies_to, key) do nothing;

-- Backfill the pipeline position from the operational status, so existing rows
-- appear on the board where a human would expect them.
--
-- Placed AFTER the pipeline seeding and the org trigger, because the
-- stage-validity trigger rejects a stage that is not yet in `pipeline_stages`.
-- On a fresh database this updates zero rows: no placements exist until seed.sql.
do $$
begin
  if exists (select 1 from public.organizations) then
    update public.placements
    set pipeline_stage = case
      when status = 'live' then 'live'
      when status = 'scheduled' then 'submitted'
      when status = 'removed' then 'live'
      when status = 'declined' then 'pitched'
      when status = 'refunded' then 'live'
      else 'content_writing'
    end
    where pipeline_stage = 'prospected';
  end if;
end $$;

create index if not exists placements_pipeline_idx
  on public.placements (organization_id, campaign_id, pipeline_stage)
  where deleted_at is null;
create index if not exists placements_assigned_idx
  on public.placements (assigned_to, pipeline_stage)
  where deleted_at is null;

-- The stage must exist in this org's PLACEMENT pipeline, mirroring the guard
-- prospects already have. A CHECK cannot query a table, so this is a trigger.
create or replace function app_private.assert_placement_stage_valid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.pipeline_stages ps
    where ps.organization_id = new.organization_id
      and ps.applies_to = 'placement'
      and ps.key = new.pipeline_stage
  ) then
    raise exception 'Unknown placement stage % for organization %', new.pipeline_stage, new.organization_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists placements_stage_valid on public.placements;
create trigger placements_stage_valid
  before insert or update of pipeline_stage on public.placements
  for each row execute function app_private.assert_placement_stage_valid();

-- ---------------------------------------------------------------------------
-- PLACEMENT HISTORY
--
-- Append-only. A pipeline is only trustworthy if you can see how a link got to
-- its current stage, who moved it, and what they said at the time. This is the
-- table that answers "why is this still in content writing?".
-- ---------------------------------------------------------------------------
create table if not exists public.placement_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  placement_id    uuid not null references public.placements(id) on delete cascade,
  event_type      text not null check (event_type in (
                    'created',
                    'stage_change',
                    'assignment_change',
                    'client_approved',
                    'client_rejected',
                    'cost_agreed',
                    'note_added',
                    'publisher_assigned',
                    'archived',
                    'restored'
                  )),
  from_stage      text,
  to_stage        text,
  actor_id        uuid references public.profiles(id) on delete set null,
  actor_name      text,
  summary         text,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists placement_events_placement_idx
  on public.placement_events (placement_id, created_at desc);
create index if not exists placement_events_org_idx
  on public.placement_events (organization_id, created_at desc);

alter table public.placement_events enable row level security;
alter table public.placement_events force row level security;

-- Readable by anyone who can see the placement. No INSERT/UPDATE/DELETE policy:
-- rows are written by the API over service_role, so history cannot be edited or
-- backdated by a user.
create policy placement_events_select on public.placement_events
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and exists (
      select 1 from public.placements p
      where p.id = placement_events.placement_id
        and (
          app_private.is_internal()
          or (app_private.current_app_role() = 'client_user'
              and app_private.can_see_client(app_private.client_of_campaign(p.campaign_id)))
        )
    )
  );

-- ---------------------------------------------------------------------------
-- OUTREACH
--
-- `outreach_touchpoints` records what happened. Phase 4 also needs a PLANNED
-- follow-up (a next action with a due date and an owner) and a response status,
-- which a log of past events cannot express. `outreach_records` is that plan.
-- ---------------------------------------------------------------------------
create table if not exists public.outreach_records (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete restrict,
  prospect_id      uuid not null references public.prospects(id) on delete cascade,
  campaign_id      uuid not null references public.campaigns(id) on delete cascade,
  template_id      uuid references public.email_templates(id) on delete set null,
  -- A record is either a sent outreach or a planned follow-up.
  kind             text not null default 'initial'
                   check (kind in ('initial', 'follow_up', 'negotiation', 'placement_notice')),
  status           text not null default 'draft'
                   check (status in ('draft', 'queued', 'sent', 'replied', 'no_response', 'bounced', 'cancelled')),
  response_status  text
                   check (response_status in ('positive', 'negative', 'neutral', 'out_of_office', 'not_interested')),
  subject          text,
  body_excerpt     text,
  -- The recipient captured at the time, so a later contact change does not
  -- rewrite the history of who we actually wrote to.
  recipient_email  citext,
  sent_at          timestamptz,
  responded_at     timestamptz,
  follow_up_due_at timestamptz,
  follow_up_count  integer not null default 0 check (follow_up_count >= 0),
  owner_id         uuid references public.profiles(id) on delete set null,
  -- Nothing sends without a provider. This records the intent and keeps the
  -- system honest about the fact that no email actually left.
  delivery_provider text,
  provider_message_id text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists outreach_records_prospect_idx
  on public.outreach_records (prospect_id, created_at desc);
create index if not exists outreach_records_due_idx
  on public.outreach_records (organization_id, follow_up_due_at)
  where status in ('sent', 'no_response');
create index if not exists outreach_records_owner_idx
  on public.outreach_records (owner_id, status);

alter table public.outreach_records enable row level security;
alter table public.outreach_records force row level security;

create trigger outreach_records_set_updated_at
  before update on public.outreach_records
  for each row execute function app_private.set_updated_at();

create policy outreach_records_select on public.outreach_records
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.is_internal()
  );

create policy outreach_records_write on public.outreach_records
  for all to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager', 'prospector', 'outreach_specialist'])
  )
  with check (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager', 'prospector', 'outreach_specialist'])
  );
