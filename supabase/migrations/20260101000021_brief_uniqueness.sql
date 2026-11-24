-- ============================================================================
-- 0021 — One content brief per placement
--
-- The content module returns 409 "This placement already has a content brief"
-- when a second brief is created, but nothing enforced it: `content_briefs` had
-- no unique constraint on `placement_id`. The branch was unreachable, and the
-- duplicate was created — which then makes "the draft for this placement"
-- ambiguous, because a draft hangs off a brief.
--
-- A partial unique index rather than a plain one: a brief can be archived and
-- recreated, so only live rows are constrained.
-- ============================================================================

-- Remove any duplicates that already exist, keeping the oldest. A duplicate brief
-- is a data error from before this constraint, and deleting the newer one is the
-- least destructive repair — the drafts attached to it are the ones an operator
-- will want to look at.
delete from public.content_briefs b
where b.id in (
  select id from (
    select id,
           row_number() over (partition by placement_id order by created_at asc, id asc) as rn
    from public.content_briefs
  ) ranked
  where ranked.rn > 1
);

create unique index if not exists content_briefs_one_per_placement_idx
  on public.content_briefs (placement_id);

comment on index public.content_briefs_one_per_placement_idx is
  'A placement has at most one content brief. A draft hangs off a brief, so two briefs would make "the draft" ambiguous.';
