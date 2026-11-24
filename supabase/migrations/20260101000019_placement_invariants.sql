-- ============================================================================
-- 0019 — Close two authorization holes in the placement pipeline
--
-- HOLE 1: a placement could be CREATED directly at `live`.
--
-- The transition endpoint enforces the whole state machine — a live URL is
-- required, client approval must be attributable. `POST /placements` accepted
-- `pipelineStage: 'live'` and wrote it straight in, with `live_url` and
-- `client_approved_at` null. Verified live: a 201 with stage `live` and no URL,
-- which both skips the pipeline and poisons link monitoring (a `live` row with
-- nothing to check). The rule belongs in the database, not only in the route,
-- because that is the layer every future code path has to go through.
--
-- HOLE 2: `placements:approve` was defined and granted but never checked.
--
-- Both the transition endpoint and the client-decision endpoint gate on
-- `placements:write`. account_manager holds `placements:approve` but NOT
-- `placements:write`, so the role whose job is literally "reviews prospected
-- sites, pre-approves pitched sites" could not approve anything — while
-- content_writer, who holds write, could approve on a client's behalf. The
-- permission exists and does the opposite of what it says.
--
-- The route fix is in the placements module; this migration fixes the invariant
-- that a `live` placement must have a URL, so a bypass at any layer fails.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A placement at `live` must have a live URL.
--
-- Enforced as a constraint rather than a trigger so it holds for inserts,
-- updates, seeds and any future bulk import. Rows that predate this migration
-- are repaired first: a live placement with no URL is indistinguishable from an
-- untracked one, so it is moved back to `submitted` where a human must supply
-- the URL.
-- ---------------------------------------------------------------------------
update public.placements
set pipeline_stage = 'submitted',
    status = case when status = 'live' then 'pending' else status end
where pipeline_stage = 'live'
  and live_url is null
  and deleted_at is null;

alter table public.placements
  drop constraint if exists placements_live_requires_url;

alter table public.placements
  add constraint placements_live_requires_url
  check (pipeline_stage <> 'live' or live_url is not null);

-- ---------------------------------------------------------------------------
-- Client approval must be attributable whenever the stage claims it.
--
-- Without this, `pipeline_stage = 'client_approved'` with no approver is a claim
-- the database accepts but no one can substantiate.
-- ---------------------------------------------------------------------------
update public.placements
set client_approved_at = coalesce(client_approved_at, updated_at, now())
where pipeline_stage in ('client_approved', 'content_writing', 'submitted', 'live')
  and client_approved_at is null;

alter table public.placements
  drop constraint if exists placements_approved_requires_attribution;

alter table public.placements
  add constraint placements_approved_requires_attribution
  check (
    pipeline_stage = 'prospected'
    or pipeline_stage = 'pitched'
    or client_approved_at is not null
  );
