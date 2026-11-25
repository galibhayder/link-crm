-- ===========================================================================
-- 0033 — LINK REVIEW RESOLUTION
--
-- A JavaScript-rendered page cannot be judged from its server HTML. Rather than
-- report `link_missing` for a link that is probably fine, verification returns
-- `needs_manual_review` and asks a human to look.
--
-- Until now nobody could answer. The verdict existed, the job counted it, and the
-- queue grew silently. This migration adds the place to record the answer.
--
-- ---------------------------------------------------------------------------
-- THE DESIGN CONSTRAINT, which is the whole difficulty of this feature
--
-- A live placement is re-checked every six hours and every check writes a NEW
-- `link_checks` row. Two naive designs fail:
--
--   * Resolving a check ROW does not stop tomorrow's check asking again, so the
--     queue refills with the same placement forever and people stop looking.
--
--   * A permanent flag (like `placements.index_status_manual`) suppresses the
--     question for good, so a link that GENUINELY disappears next month is never
--     flagged again. That trades a noisy alert for a silent one.
--
-- The rule implemented here:
--
--   A human's verdict stands only while the automatic verdict remains
--   `needs_manual_review`. As soon as a check returns something judgeable (`ok`,
--   `link_missing`, ...) the page can be read again, the human's suppression is
--   cleared, and a later shell verdict starts a fresh review.
--
-- So the state lives on `placements` (one row per placement, not per check), and
-- the `check-links` job clears it whenever the verdict becomes judgeable.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. THE ADJUDICATION
--
-- NULL `link_review_state` means "not currently adjudicated" — which covers both
-- "never reviewed" and "review cleared because the page became readable". The
-- two are deliberately indistinguishable: both mean the queue should ask.
-- ---------------------------------------------------------------------------
alter table public.placements
  add column if not exists link_review_state text,

  add column if not exists link_reviewed_at     timestamptz,
  add column if not exists link_reviewed_by     uuid references public.profiles(id) on delete set null,
  add column if not exists link_review_note     text,

  -- WHICH observation was adjudicated.
  --
  -- Without this, "reviewed last Tuesday" cannot be tied to the page state that
  -- was actually looked at. It also lets the API reject a stale tab: if the check
  -- has since been superseded, the adjudication is refused rather than silently
  -- applied to a different observation.
  add column if not exists link_reviewed_check_id uuid references public.link_checks(id) on delete set null;

alter table public.placements
  drop constraint if exists placements_link_review_state_check;

alter table public.placements
  add constraint placements_link_review_state_check
  check (link_review_state in ('confirmed_present', 'confirmed_missing'));

comment on column public.placements.link_review_state is
  'A human decision on a needs_manual_review verdict. Cleared by the check-links job whenever the automatic verdict becomes judgeable, so the question is asked again if the page changes.';

comment on column public.placements.removal_detected_at is
  'When a reviewer (or a check) first observed the link absent. An OBSERVATION, not a status change: the placement is moved to removed by a human on the board.';

-- No new index on `placements`: the queue view drives from `link_checks` (see
-- below), and `link_checks_placement_idx (placement_id, checked_at desc)` from
-- migration 0002 is exactly the index its DISTINCT ON needs.

-- ---------------------------------------------------------------------------
-- 2. THE QUEUE VIEW
--
-- Only the LATEST check per placement matters. Deriving that here rather than in
-- the API keeps the deduplication in SQL, where it is a single DISTINCT ON rather
-- than a hand-rolled reduce over a paginated result.
--
-- service_role only: this is internal triage data and must not be reachable from
-- PostgREST by any logged-in user.
-- ---------------------------------------------------------------------------
--
-- The verdict filter is applied to the OUTER query, not inside the DISTINCT ON.
-- `WHERE` runs before `DISTINCT ON`, so filtering to review rows first made the
-- "latest check wins" rule false: a placement that was a shell on Monday and served
-- real HTML on Tuesday would still surface Monday's review row, because Tuesday's
-- `ok` row was removed before the latest row was chosen. Selecting the latest check
-- first, then keeping only those whose latest verdict is a review, is the rule the
-- job actually implements ("a judgeable verdict supersedes the question").
create or replace view public.v_link_review_queue as
select *
from (
  select distinct on (lc.placement_id)
    lc.id                as check_id,
    lc.organization_id,
    lc.placement_id,
    lc.checked_at,
    lc.verdict,
    lc.failure_reason,
    lc.http_status,
    lc.http_final_url,
    lc.elapsed_ms,
    p.live_url,
    p.target_url,
    p.anchor_text,
    p.anchor_type,
    p.campaign_id,
    p.status             as placement_status,
    p.last_checked_at,
    p.pipeline_stage,
    c.name               as campaign_name,
    cl.id                as client_id,
    cl.name              as client_name
  from public.link_checks lc
  join public.placements p on p.id = lc.placement_id
  join public.campaigns  c on c.id = p.campaign_id
  join public.clients   cl on cl.id = c.client_id
  where p.deleted_at is null
    and p.link_review_state is null
  order by lc.placement_id, lc.checked_at desc
) latest
where latest.verdict = 'needs_manual_review';

revoke all on public.v_link_review_queue from anon, authenticated;
grant select on public.v_link_review_queue to service_role;

-- ---------------------------------------------------------------------------
-- 3. CLOSE A PORTAL LEAK
--
-- `link_checks_select` allowed `app_private.can_see_placement(placement_id)`,
-- which is TRUE for a client_user on their own placements. A client holding a
-- Supabase token could therefore query PostgREST directly and read `verdict`,
-- `failure_reason`, `anchor_found` and the raw diagnostic detail.
--
-- Nothing in the portal API or UI ever did this — `v_portal_placements`
-- deliberately excludes all of it — but the table was never tightened to match.
--
-- "We could not tell whether your link exists" is an admission about our tooling,
-- not a service fact, and it reads as a broken promise to a paying client. It is
-- internal-only, exactly like `internal_notes`.
-- ---------------------------------------------------------------------------
drop policy if exists link_checks_select on public.link_checks;

create policy link_checks_select on public.link_checks
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.is_internal()
  );

-- ---------------------------------------------------------------------------
-- 4. NOTIFICATION TYPE
--
-- Recreated rather than amended: Postgres has no ALTER CONSTRAINT for a CHECK
-- expression. The 0024 pattern is `drop if exists` then `add`, so re-running this
-- migration is safe.
--
-- `link_needs_review` is emitted once per placement (deduped), not once per check,
-- so a six-hourly re-check cannot turn into six-hourly notifications.
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'placement_stage_changed',
    'follow_up_due',
    'anchor_alert',
    -- A page could not be judged from server HTML; a human should open it.
    'link_needs_review'
  ));

-- ---------------------------------------------------------------------------
-- 5. SELF-TEST
--
-- Runs inside the migration so a mistake fails the apply rather than surfacing as
-- a broken screen later. Mirrors the self-tests in 0027 and 0031.
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  -- The columns the API and the view depend on.
  select string_agg(c, ', ') into v_missing
  from unnest(array[
    'link_review_state', 'link_reviewed_at', 'link_reviewed_by',
    'link_review_note', 'link_reviewed_check_id'
  ]) c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'placements' and column_name = c
  );

  if v_missing is not null then
    raise exception '0033: placements is missing column(s): %', v_missing;
  end if;

  -- The constraint must reject anything outside the two known decisions.
  begin
    perform 1 from public.placements where link_review_state not in
      ('confirmed_present', 'confirmed_missing') limit 1;
    if found then
      raise exception '0033: placements holds an invalid link_review_state';
    end if;
  end;

  -- The view must exist and be readable by service_role only.
  if not exists (
    select 1 from pg_views where schemaname = 'public' and viewname = 'v_link_review_queue'
  ) then
    raise exception '0033: v_link_review_queue was not created';
  end if;

  if has_table_privilege('authenticated', 'public.v_link_review_queue', 'SELECT') then
    raise exception '0033: authenticated can read the review queue; it is internal-only';
  end if;

  -- The leak must actually be closed.
  if has_table_privilege('anon', 'public.link_checks', 'SELECT') then
    -- anon may hold a grant (Supabase default), but the POLICY must exclude it.
    -- With no policy for anon, RLS returns zero rows, which is the intent.
    null;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'link_checks'
      and policyname = 'link_checks_select'
      and qual like '%can_see_placement%'
  ) then
    raise exception '0033: link_checks is still readable by portal users via can_see_placement';
  end if;

  raise notice '0033: link review resolution installed';
end $$;
