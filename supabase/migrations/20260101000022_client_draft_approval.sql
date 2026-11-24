-- ============================================================================
-- 0022 — Client approval of content drafts
--
-- THE GAP THIS CLOSES
--
-- `briefs:approve` was granted to `client_user` with the comment "the client
-- reviews the draft written for them, so their sign-off is the approval that
-- matters most". Nothing implemented it: a client_user is on the PORTAL surface, so
-- `authenticate` rejects them at /api/v1 before any permission is consulted, and
-- the portal router was read-only. The permission and the README both described a
-- feature that did not exist.
--
-- Two mechanisms are needed, because both layers exclude clients today:
--
--   1. SELECT — the client must be able to READ the draft they are approving.
--      `content_drafts_select` allows only staff, so a client sees nothing.
--
--   2. UPDATE — approving writes the row, and `content_drafts_write` also excludes
--      clients. Rather than widen that policy (which would let a client edit the
--      text, or approve something never submitted), approval goes through a
--      SECURITY DEFINER function that checks every precondition itself.
--
-- WHY A FUNCTION RATHER THAN A POLICY
--
-- Approving is a state transition with conditions — the draft must be in review,
-- it must belong to a placement the client can see, and the approval must be
-- recorded. A WITH CHECK can express the first and second but not "set these
-- three columns and nothing else". The function returns the updated row, so the
-- API does not need a second read.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. A client may read a draft that is awaiting their sign-off.
--
-- Deliberately narrow. Not `draft` (the writer is still working), not
-- `revision_requested` (the agency's internal correction cycle is not the client's
-- business). `in_review` is what they are being asked to approve; `approved` and
-- `published` are what they approved.
-- ---------------------------------------------------------------------------
drop policy if exists content_drafts_client_select on public.content_drafts;

create policy content_drafts_client_select on public.content_drafts
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.current_app_role() = 'client_user'
    and status in ('in_review', 'approved', 'published')
    and app_private.can_see_placement(placement_id)
  );

-- Versions of a draft the client may see, so they can read what they are
-- approving. Same visibility as the draft itself.
drop policy if exists content_draft_versions_client_select on public.content_draft_versions;

create policy content_draft_versions_client_select on public.content_draft_versions
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.current_app_role() = 'client_user'
    and exists (
      select 1 from public.content_drafts d
      where d.id = content_draft_versions.draft_id
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Client approval, as an explicit operation.
--
-- SECURITY DEFINER because the client has no UPDATE policy, and must not get one:
-- a policy broad enough to approve is broad enough to rewrite the text. The
-- function re-derives the organization and role from the CALLER's claims (never a
-- parameter) and re-checks the placement scope, so it cannot approve across
-- tenants or for a client the caller is not granted.
-- ---------------------------------------------------------------------------
create or replace function app_private.client_approve_draft(
  p_draft_id uuid,
  p_note     text default null
)
returns table (id uuid, status text, approved_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org        uuid;
  v_role       text;
  v_placement  uuid;
  v_status     text;
begin
  v_org  := app_private.current_org_id();
  v_role := app_private.current_app_role();

  if v_org is null then
    raise exception 'No organization in the caller claims' using errcode = '42501';
  end if;

  if v_role <> 'client_user' then
    raise exception 'Only a client may approve content through this function'
      using errcode = '42501';
  end if;

  select d.placement_id, d.status
    into v_placement, v_status
  from public.content_drafts d
  where d.id = p_draft_id
    and d.organization_id = v_org;

  if v_placement is null then
    raise exception 'Draft not found' using errcode = 'P0002';
  end if;

  -- The draft must be on a placement this client is actually granted.
  if not app_private.can_see_placement(v_placement) then
    raise exception 'Draft not found' using errcode = 'P0002';
  end if;

  -- Only a submitted draft can be approved. Approving a draft the writer is still
  -- working on would sign off text that is going to change.
  if v_status <> 'in_review' then
    raise exception 'Only a draft in review can be approved (this one is %)', v_status
      using errcode = '22023';
  end if;

  return query
    update public.content_drafts d
       set status         = 'approved',
           approved_at    = now(),
           approved_by    = auth.uid(),
           client_approval_note = p_note
     where d.id = p_draft_id
       and d.organization_id = v_org
    returning d.id, d.status, d.approved_at;
end;
$$;

revoke all on function app_private.client_approve_draft(uuid, text) from public, anon;

/**
 * Public wrapper. MUST be SECURITY DEFINER, not SECURITY INVOKER: `authenticated`
 * has no USAGE on `app_private`, so an invoker wrapper fails with "permission
 * denied for schema app_private" — the same class of mistake as the archive and
 * token-hook wrappers.
 */
create or replace function public.client_approve_draft_rpc(
  p_draft_id uuid,
  p_note     text default null
)
returns table (id uuid, status text, approved_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select * from app_private.client_approve_draft(p_draft_id, p_note);
$$;

revoke all on function public.client_approve_draft_rpc(uuid, text) from public, anon;
grant execute on function public.client_approve_draft_rpc(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Record the client's note.
--
-- `client_approval_note` exists on placements for the anchor-approval flow; a
-- draft needs its own, because the two approvals are separate events and one must
-- not overwrite the other's justification.
-- ---------------------------------------------------------------------------
alter table public.content_drafts
  add column if not exists client_approval_note text;

comment on column public.content_drafts.client_approval_note is
  'Why the client approved the draft. Separate from placements.client_approval_note, which records anchor approval.';
