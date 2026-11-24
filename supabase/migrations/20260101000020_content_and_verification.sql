-- ============================================================================
-- 0020 — Phase 5: content workflow, richer verification, anchor alerts
--
-- Three areas, each extending something that already existed rather than
-- inventing a parallel structure:
--
--   1. CONTENT. `content_briefs` was a stub: one row per placement, a text brief
--      and a status. The brief asks for drafts, VERSIONS, revision requests and an
--      approval workflow. `content_drafts` + `content_draft_versions` +
--      `content_revisions` provide that, leaving `content_briefs` as the
--      assignment record it already is.
--
--   2. VERIFICATION. `link_checks` recorded http_status, found and rel. The brief
--      asks five specific questions, three of which it could not answer: is the
--      DESTINATION right, does the ANCHOR match, do the ATTRIBUTES match. Those
--      become columns, so a check is a complete record of what was observed.
--
--   3. ANCHOR ALERTS. The distribution view existed; configurable monitoring did
--      not. `anchor_alerts` stores thresholds per campaign and client.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. CONTENT DRAFTS
--
-- A draft is the document; versions are every saved state of it. Keeping them
-- apart means "restore version 3" is a copy, not a destructive edit, and the
-- client can be shown exactly what they approved even after revision.
-- ---------------------------------------------------------------------------
create table if not exists public.content_drafts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  brief_id        uuid not null references public.content_briefs(id) on delete cascade,
  placement_id    uuid not null references public.placements(id) on delete cascade,
  title           text,
  body_md         text not null default '',
  word_count      integer not null default 0 check (word_count >= 0),

  status          text not null default 'draft'
                  check (status in ('draft', 'in_review', 'revision_requested', 'approved', 'published')),

  -- Which version is current. nullable so a draft can exist before its first
  -- version is written; the API always creates version 1 with the draft.
  current_version integer,

  submitted_at    timestamptz,
  approved_at     timestamptz,
  approved_by     uuid references public.profiles(id) on delete set null,
  published_at    timestamptz,

  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists content_drafts_brief_idx on public.content_drafts (brief_id);
create index if not exists content_drafts_placement_idx on public.content_drafts (placement_id);
create index if not exists content_drafts_status_idx on public.content_drafts (organization_id, status);

-- ---------------------------------------------------------------------------
-- DRAFT VERSIONS — append-only.
--
-- History that can be edited is not history. Write access is revoked from every
-- end-user role below; the API writes these over service_role after checking that
-- the caller may work on the draft at all.
-- ---------------------------------------------------------------------------
create table if not exists public.content_draft_versions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  draft_id        uuid not null references public.content_drafts(id) on delete cascade,
  version         integer not null check (version > 0),
  title           text,
  body_md         text not null,
  word_count      integer not null default 0 check (word_count >= 0),
  /** Why this version exists: 'initial', 'revision', 'restore'. */
  reason          text not null default 'initial'
                  check (reason in ('initial', 'revision', 'restore')),
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (draft_id, version)
);

create index if not exists content_draft_versions_idx on public.content_draft_versions (draft_id, version desc);

-- ---------------------------------------------------------------------------
-- REVISION REQUESTS.
--
-- A request is addressed to the writer and resolves when a new version is saved.
-- Separate from the draft so the history of "what was asked for" survives even
-- after the text changes.
-- ---------------------------------------------------------------------------
create table if not exists public.content_revisions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  draft_id        uuid not null references public.content_drafts(id) on delete cascade,
  requested_by    uuid references public.profiles(id) on delete set null,
  notes           text not null,
  status          text not null default 'open' check (status in ('open', 'resolved', 'withdrawn')),
  resolved_at     timestamptz,
  resolved_by_version integer,
  created_at      timestamptz not null default now()
);

create index if not exists content_revisions_draft_idx on public.content_revisions (draft_id, created_at desc);
create index if not exists content_revisions_open_idx on public.content_revisions (organization_id)
  where status = 'open';

-- At most ONE open revision request per draft. Two open requests means the writer
-- has two contradictory briefs and no way to know which one wins.
create unique index if not exists content_revisions_one_open_idx
  on public.content_revisions (draft_id)
  where status = 'open';

-- ---------------------------------------------------------------------------
-- RLS — drafts follow their brief's visibility.
-- ---------------------------------------------------------------------------
alter table public.content_drafts         enable row level security;
alter table public.content_drafts         force row level security;
alter table public.content_draft_versions enable row level security;
alter table public.content_draft_versions force row level security;
alter table public.content_revisions      enable row level security;
alter table public.content_revisions      force row level security;

-- A draft is visible to whoever can see its brief. Reusing the brief policy
-- rather than restating the role rules keeps the two from drifting.
create policy content_drafts_select on public.content_drafts
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and exists (select 1 from public.content_briefs b where b.id = content_drafts.brief_id)
  );

create policy content_drafts_write on public.content_drafts
  for all to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager', 'content_writer'])
    and exists (select 1 from public.content_briefs b where b.id = content_drafts.brief_id)
  )
  with check (
    organization_id = app_private.current_org_id()
    and exists (select 1 from public.content_briefs b where b.id = content_drafts.brief_id)
  );

create policy content_draft_versions_select on public.content_draft_versions
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and exists (select 1 from public.content_drafts d where d.id = content_draft_versions.draft_id)
  );

-- Versions are written by the API over service_role, never directly: a version
-- that a client could edit would let them rewrite what was approved.
revoke insert, update, delete on public.content_draft_versions from authenticated;

create policy content_revisions_select on public.content_revisions
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and exists (select 1 from public.content_drafts d where d.id = content_revisions.draft_id)
  );

create policy content_revisions_write on public.content_revisions
  for all to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager', 'content_writer', 'client_user'])
    and exists (select 1 from public.content_drafts d where d.id = content_revisions.draft_id)
  )
  with check (organization_id = app_private.current_org_id());

-- ---------------------------------------------------------------------------
-- 2. VERIFICATION — the five questions, recorded.
--
-- The existing columns answered "did the page load" and "was something found".
-- The brief asks about the DESTINATION, the ANCHOR and the ATTRIBUTES too, so a
-- check is now a complete observation rather than a hint.
-- ---------------------------------------------------------------------------
alter table public.link_checks
  add column if not exists expected_url       text,
  add column if not exists found_url          text,
  add column if not exists anchor_expected    text,
  add column if not exists anchor_found       text,
  add column if not exists anchor_matches     boolean,
  add column if not exists rel_expected       text,
  add column if not exists rel_matches        boolean,
  add column if not exists url_matches        boolean,
  -- What the row concludes, distinct from `found` (which means "an anchor to the
  -- target exists at all"). A link can exist but be wrong, which is the case
  -- worth alerting on.
  add column if not exists verdict            text
    check (verdict in ('ok', 'link_missing', 'url_mismatch', 'anchor_mismatch', 'attr_mismatch', 'unreachable')),
  add column if not exists failure_reason     text,
  add column if not exists http_final_url     text,
  add column if not exists elapsed_ms         integer;

create index if not exists link_checks_verdict_idx on public.link_checks (organization_id, verdict, checked_at desc);

comment on column public.link_checks.verdict is
  'The outcome a human acts on. `found` only means an anchor to the target exists somewhere on the page.';

-- ---------------------------------------------------------------------------
-- A verification that never reached the page must not look like a removal.
--
-- `found` defaults to false, so a timeout previously read as "link removed". The
-- verdict column is what reporting uses; this comment records why.
-- ---------------------------------------------------------------------------
comment on column public.link_checks.found is
  'An anchor pointing at the target URL was present. A fetch failure also yields false — read `verdict` instead.';

-- ---------------------------------------------------------------------------
-- 3. ANCHOR ALERTS — configurable per campaign or client.
--
-- Thresholds are stored, not hardcoded, because "too much exact match" depends on
-- the niche and the client's risk appetite.
-- ---------------------------------------------------------------------------
create table if not exists public.anchor_alerts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  -- Exactly one scope: a whole client, or a single campaign.
  campaign_id     uuid references public.campaigns(id) on delete cascade,
  client_id       uuid references public.clients(id) on delete cascade,

  anchor_category text not null
                  check (anchor_category in ('branded', 'exact_match', 'partial_match', 'generic', 'naked_url', 'image_alt')),
  /** Alert when the share for this category EXCEEDS this fraction (0..1). */
  max_share       numeric(4,3) not null check (max_share > 0 and max_share <= 1),
  /** Alert when the share falls BELOW this. Null means no floor. */
  min_share       numeric(4,3) check (min_share is null or (min_share >= 0 and min_share <= 1)),
  /** Only fire once there are enough links for a ratio to mean anything. */
  min_links       integer not null default 10 check (min_links >= 0),
  enabled         boolean not null default true,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint anchor_alerts_one_scope check (
    (campaign_id is not null and client_id is null)
    or (campaign_id is null and client_id is not null)
  ),
  constraint anchor_alerts_range check (min_share is null or min_share <= max_share)
);

create index if not exists anchor_alerts_campaign_idx on public.anchor_alerts (campaign_id) where enabled;
create index if not exists anchor_alerts_client_idx on public.anchor_alerts (client_id) where enabled;

alter table public.anchor_alerts enable row level security;
alter table public.anchor_alerts force row level security;

create policy anchor_alerts_select on public.anchor_alerts
  for select to authenticated
  using (organization_id = app_private.current_org_id() and app_private.is_internal());

create policy anchor_alerts_write on public.anchor_alerts
  for all to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager'])
  )
  with check (organization_id = app_private.current_org_id());

create trigger anchor_alerts_set_updated_at
  before update on public.anchor_alerts
  for each row execute function app_private.set_updated_at();

create trigger content_drafts_set_updated_at
  before update on public.content_drafts
  for each row execute function app_private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Anchor distribution by CLIENT, which the view did not provide.
--
-- v_anchor_distribution groups by campaign; the brief asks for both campaign and
-- client. Client-level aggregation cannot be derived from campaign rows without
-- re-summing, and the same anchor appearing in two campaigns must count once per
-- client total — so it gets its own view.
--
-- Deliberately NO `anchor_type is not null` filter: the campaign view reports an
-- `unclassified` bucket, and the API subtracts it from the denominator. Filtering
-- it out here would make a client's totals disagree with the sum of its campaigns.
-- ---------------------------------------------------------------------------
create or replace view public.v_anchor_distribution_client as
select
  p.organization_id,
  c.client_id,
  coalesce(p.anchor_type, 'unclassified')                        as anchor_type,
  count(*)                                                       as link_count,
  round(
    count(*)::numeric / nullif(sum(count(*)) over (partition by c.client_id), 0),
    4
  )                                                              as share
from public.placements p
join public.campaigns c on c.id = p.campaign_id
where p.deleted_at is null
  and p.status = 'live'
group by p.organization_id, c.client_id, p.anchor_type;

revoke all on public.v_anchor_distribution_client from authenticated, anon;
grant select on public.v_anchor_distribution_client to service_role;
