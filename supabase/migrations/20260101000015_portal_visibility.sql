-- ============================================================================
-- 0015 — What a client is allowed to see on a placement
--
-- "Ensure clients only see information approved for their portal" is a
-- statement about VISIBILITY, not just tenancy. Two separate controls:
--
--   1. WHICH placements: a client should not see a link that is still being
--      pitched. Showing it would leak our prospecting pipeline to them, and
--      showing a rejected one invites a conversation we have not had yet.
--
--   2. WHICH COLUMNS: internal_notes, negotiated_cost, assigned_to and the
--      approval trail are ours. RLS filters rows, not columns, so column-level
--      GRANTs are the only mechanism that actually enforces this.
--
-- The existing `placements_select` policy allows a client_user to read any
-- placement belonging to their client. That is correct for tenancy but too
-- broad for a portal, so it is tightened here.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Scope: which placements a client may observe.
--
-- The final policy is defined further down, after the reasoning about column
-- grants. The decision is: a client has NO policy on `placements` at all, and
-- reads exclusively through `v_portal_placements`. Everything before
-- `client_approved` is internal pipeline work and must not be visible either way.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- WHY A VIEW RATHER THAN COLUMN GRANTS
--
-- Supabase Auth gives every signed-in user the SAME Postgres role
-- (`authenticated`). Column GRANTs are per-role, so revoking `internal_notes`
-- from `authenticated` also blinds internal staff — the API then fails with
-- "permission denied for table placements". RLS filters rows, not columns, so
-- neither mechanism can say "staff may read this column, clients may not".
--
-- The workable pattern is to deny clients the TABLE entirely and give them a
-- VIEW that enumerates only safe columns. A `SECURITY DEFINER` view reads past
-- RLS, so the view's own WHERE clause is what scopes rows — and PostgREST
-- exposes the view as a read-only relation.
-- ---------------------------------------------------------------------------

drop policy if exists placements_select on public.placements;
create policy placements_select on public.placements
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and deleted_at is null
    and (
      -- Internal staff. Per-module queries narrow this further (assignments).
      app_private.is_internal()
      -- A supplier sees only its own work.
      or (app_private.current_app_role() = 'publisher_user'
          and supplier_id = app_private.current_supplier_id())
      -- NOTE: client_user is deliberately ABSENT. A client has no policy on this
      -- table at all, so a direct PostgREST read returns zero rows. Their only
      -- route is v_portal_placements below.
    )
  );

-- ---------------------------------------------------------------------------
-- The client-facing view. This is the ONLY way a client reads placements.
--
-- security_invoker = false (the default) makes the view run as its owner, so it
-- can read rows the caller cannot. The WHERE clause below is therefore the
-- security boundary and is written to match the portal rules exactly:
--   * only this organization's placements,
--   * only at or past client approval,
--   * never deleted.
-- ---------------------------------------------------------------------------
create or replace view public.v_portal_placements as
select
  p.id,
  p.organization_id,
  p.campaign_id,
  p.target_url,
  p.anchor_text,
  p.anchor_type,
  p.live_url,
  p.link_type,
  p.rel_attribute,
  p.status,
  p.pipeline_stage,
  p.live_date,
  p.index_status,
  p.client_approved_at,
  p.client_approval_note,
  p.notes
from public.placements p
join public.campaigns c on c.id = p.campaign_id
where p.deleted_at is null
  and p.pipeline_stage in ('client_approved', 'content_writing', 'submitted', 'live')
  -- The view runs as its OWNER, so it does not inherit RLS row filtering. Every
  -- restriction the caller needs must be written here explicitly:
  --   * the caller's organization,
  --   * and, for a client_user, only the clients they are actually granted.
  and p.organization_id = app_private.current_org_id()
  -- `can_see_client` already returns true for internal staff and, for a
  -- client_user, only for clients they are granted. Restating it here (rather
  -- than special-casing is_internal) means the view cannot widen beyond what
  -- the same helper allows on the table itself.
  and app_private.can_see_client(c.client_id);

comment on view public.v_portal_placements is
  'The only path by which a client_user reads placements. Excludes internal_notes, negotiated_cost, assignee and any pre-approval stage. Scoped by can_see_client because the view runs as its owner and does not inherit RLS.';

revoke all on public.v_portal_placements from anon;
grant select on public.v_portal_placements to authenticated;
grant select on public.v_portal_placements to service_role;

-- ---------------------------------------------------------------------------
-- A client may not approve its own placement, and may not write to placements at
-- all. `placements_update` already excludes client_user; restating it here keeps
-- the rule next to the read policy above.
-- ---------------------------------------------------------------------------
drop policy if exists placements_update on public.placements;
create policy placements_update on public.placements
  for update to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.is_internal()
      or (app_private.current_app_role() = 'publisher_user'
          and supplier_id = app_private.current_supplier_id())
    )
  )
  with check (organization_id = app_private.current_org_id());
