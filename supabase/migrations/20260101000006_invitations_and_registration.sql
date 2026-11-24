-- ============================================================================
-- 0006 — Invitations, self-service registration, and profile completeness
--
-- Registration policy: an agency CRM must NOT have open sign-up. Anyone who
-- could create an account could see a client's data by being granted nothing —
-- and worse, a self-registered user choosing their own role is the escalation
-- vector fixed in 0005.
--
-- So registration is invitation-only:
--   * An administrator creates an invitation carrying the role and org.
--   * The invited address may complete sign-up and the trigger below provisions
--     the profile from the INVITATION, never from client-supplied metadata.
--   * A sign-up without a matching pending invitation gets no profile, and
--     `authenticate` rejects any user with no profile.
-- ============================================================================

create table public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email           citext not null,
  full_name       text not null,
  -- The role is captured at invite time by an administrator. This is the ONLY
  -- place a role for a new user can come from.
  role            text not null check (role in (
                    'owner', 'account_manager', 'prospector', 'outreach_specialist',
                    'content_writer', 'client_user', 'publisher_user')),
  supplier_id     uuid references public.suppliers(id) on delete set null,
  invited_by      uuid references public.profiles(id) on delete set null,
  status          text not null default 'pending'
                  check (status in ('pending', 'accepted', 'revoked', 'expired')),
  accepted_at     timestamptz,
  accepted_by     uuid references public.profiles(id) on delete set null,
  expires_at      timestamptz not null default (now() + interval '14 days'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint invite_publisher_needs_supplier check (
    (role = 'publisher_user' and supplier_id is not null) or (role <> 'publisher_user')
  )
);

-- One live invitation per address per org. Partial so an accepted or revoked
-- invitation does not block a later re-invite.
create unique index invitations_pending_unique
  on public.invitations (organization_id, lower(email))
  where status = 'pending';

create index invitations_email_idx on public.invitations (lower(email));

alter table public.invitations enable row level security;
alter table public.invitations force row level security;

create trigger invitations_set_updated_at
  before update on public.invitations
  for each row execute function app_private.set_updated_at();

-- Only staff who can manage users may read or write invitations.
create policy invitations_select on public.invitations
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager'])
  );

create policy invitations_write on public.invitations
  for all to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.current_app_role() = 'owner'
  )
  with check (
    organization_id = app_private.current_org_id()
    and app_private.current_app_role() = 'owner'
  );

-- ---------------------------------------------------------------------------
-- Provision a profile when an auth user is created.
--
-- Runs as SECURITY DEFINER because it executes during GoTrue's sign-up, where
-- there is no authenticated database role.
--
-- The role is taken from the matching pending invitation. If there is no
-- invitation, NO profile is created: the user can authenticate but every
-- endpoint rejects them, because `authenticate` requires a profile.
-- ---------------------------------------------------------------------------
create or replace function app_private.provision_profile_from_invitation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite record;
begin
  select *
    into v_invite
  from public.invitations
  where lower(email) = lower(new.email)
    and status = 'pending'
    and expires_at > now()
  order by created_at asc
  limit 1;

  if v_invite is null then
    -- No invitation: do not create a profile. Fail closed.
    return new;
  end if;

  insert into public.profiles (
    id, organization_id, full_name, email, role, supplier_id, is_active
  ) values (
    new.id,
    v_invite.organization_id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), v_invite.full_name),
    new.email,
    v_invite.role,
    v_invite.supplier_id,
    true
  )
  on conflict (id) do nothing;

  update public.invitations
  set status = 'accepted',
      accepted_at = now(),
      accepted_by = new.id
  where id = v_invite.id;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_provision_profile on auth.users;
create trigger on_auth_user_created_provision_profile
  after insert on auth.users
  for each row execute function app_private.provision_profile_from_invitation();

-- ---------------------------------------------------------------------------
-- Profile lifecycle fields used by the admin dashboard.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists suspended_at      timestamptz,
  add column if not exists suspended_by      uuid references public.profiles(id) on delete set null,
  add column if not exists suspension_reason text,
  add column if not exists invited_by        uuid references public.profiles(id) on delete set null;

comment on column public.profiles.suspension_reason is
  'Why the account was suspended. Shown to administrators in the audit trail.';

-- ---------------------------------------------------------------------------
-- The audit log must be queryable by administrators, and never writable by an
-- end user. Rows are inserted exclusively by the API via service_role.
-- ---------------------------------------------------------------------------
drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.current_app_role() = 'owner'
  );
