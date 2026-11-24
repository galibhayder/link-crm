-- ============================================================================
-- 0026 — Client revision requests on content drafts
--
-- `client_approve_draft` (migration 0022) let a client sign off an article. There
-- was no equivalent for the other half of review: saying "this needs changes".
--
-- The internal `/content/drafts/:id/transition` route can request a revision, but a
-- `client_user` is on the portal surface and is rejected by `authenticate` before
-- any handler runs — so the client had no way to ask for a change at all.
--
-- This mirrors `client_approve_draft` exactly: SECURITY DEFINER, org and role
-- re-derived from the caller's claims (never a parameter), the placement scope
-- re-checked with the same helper. It reuses the existing `content_revisions` table
-- and the existing `revision_requested` workflow state, so nothing new is invented.
-- ============================================================================

create or replace function app_private.client_request_draft_revision(
  p_draft_id uuid,
  p_note     text
)
returns table (id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org        uuid;
  v_role       text;
  v_placement  uuid;
  v_status     text;
  v_brief      uuid;
begin
  v_org  := app_private.current_org_id();
  v_role := app_private.current_app_role();

  if v_org is null then
    raise exception 'No organization in the caller claims' using errcode = '42501';
  end if;

  if v_role <> 'client_user' then
    raise exception 'Only a client may request a revision through this function'
      using errcode = '42501';
  end if;

  -- A revision request with no explanation is not actionable: the writer would be
  -- told "change something" and have to guess. Checked here as well as in the route
  -- so the database cannot be left in a state the UI cannot explain.
  if p_note is null or length(btrim(p_note)) < 3 then
    raise exception 'Say what needs to change' using errcode = '22023';
  end if;

  select d.placement_id, d.status, d.brief_id
    into v_placement, v_status, v_brief
  from public.content_drafts d
  where d.id = p_draft_id
    and d.organization_id = v_org;

  if v_placement is null then
    raise exception 'Draft not found' using errcode = 'P0002';
  end if;

  -- Same scope check as approval: the draft must be on a placement this client is
  -- granted. A wrong-client draft reports not-found rather than forbidden, so the
  -- response does not reveal that the row exists.
  if not app_private.can_see_placement(v_placement) then
    raise exception 'Draft not found' using errcode = 'P0002';
  end if;

  -- Only a submitted draft can be sent back. Asking for changes to a draft the
  -- writer is still working on is meaningless — there is nothing to review yet.
  if v_status <> 'in_review' then
    raise exception 'Only a draft in review can be sent back (this one is %)', v_status
      using errcode = '22023';
  end if;

  -- The partial unique index allows one open request per draft, so a second one is
  -- genuine user error rather than something to silently merge.
  if exists (
    select 1 from public.content_revisions r
    where r.draft_id = p_draft_id and r.status = 'open'
  ) then
    raise exception 'There is already an open revision request on this draft'
      using errcode = '23505';
  end if;

  insert into public.content_revisions (
    organization_id, draft_id, requested_by, notes, status
  ) values (
    v_org, p_draft_id, auth.uid(), btrim(p_note), 'open'
  );

  update public.content_drafts d
     set status = 'revision_requested'
   where d.id = p_draft_id
     and d.organization_id = v_org;

  -- The brief tracks the draft so the two never disagree about where the work is.
  update public.content_briefs b
     set status = 'revision'
   where b.id = v_brief;

  return query
    select d.id, d.status from public.content_drafts d where d.id = p_draft_id;
end;
$$;

revoke all on function app_private.client_request_draft_revision(uuid, text) from public, anon;

/**
 * Public wrapper. MUST be SECURITY DEFINER: `authenticated` has no USAGE on
 * `app_private`, so an invoker wrapper fails with "permission denied for schema
 * app_private".
 */
create or replace function public.client_request_draft_revision_rpc(
  p_draft_id uuid,
  p_note     text
)
returns table (id uuid, status text)
language sql
security definer
set search_path = ''
as $$
  select * from app_private.client_request_draft_revision(p_draft_id, p_note);
$$;

revoke all on function public.client_request_draft_revision_rpc(uuid, text) from public, anon;
grant execute on function public.client_request_draft_revision_rpc(uuid, text) to authenticated;
