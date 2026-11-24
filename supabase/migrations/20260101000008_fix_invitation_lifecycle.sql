-- ============================================================================
-- 0008 — Fix the invitation lifecycle
--
-- Found in review: `provision_profile_from_invitation` (0006) runs on
-- `after insert on auth.users`. But `inviteUserByEmail` creates the auth user
-- IMMEDIATELY, at invite time — not when the invitee clicks the link. So the
-- trigger consumed every invitation the moment it was created:
--
--   * every invitation was instantly 'accepted',
--   * the "Pending invitations" panel was permanently empty,
--   * resend and revoke were unreachable (they require status = 'pending'),
--   * and the invitation no longer described reality: the profile existed while
--     the person had never confirmed their email or set a password.
--
-- The role assignment itself was correct, which is why the authorization suite
-- passed. The lifecycle was simply mislabelled.
--
-- Fix: distinguish "invited" from "accepted".
--   * The profile is provisioned at invite time (needed so the account exists
--     and the admin can see it in the team list).
--   * The invitation stays 'pending' until the invitee actually confirms their
--     email address.
--   * A second trigger on `UPDATE OF email_confirmed_at` performs the acceptance.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Provision the profile but DO NOT consume the invitation.
--
-- The role still comes only from the invitation row, never from sign-up
-- metadata. Provisioning at invite time is what lets an administrator see the
-- pending account in the team list before the person has accepted.
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
    id, organization_id, full_name, email, role, supplier_id, is_active, invited_by
  ) values (
    new.id,
    v_invite.organization_id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), v_invite.full_name),
    new.email,
    v_invite.role,
    v_invite.supplier_id,
    true,
    v_invite.invited_by
  )
  on conflict (id) do nothing;

  -- Acceptance is recorded by the confirmation trigger, not here.
  -- If GoTrue created the user already-confirmed (admin-created accounts), mark
  -- it accepted immediately so the row is never left falsely pending.
  if new.email_confirmed_at is not null then
    update public.invitations
    set status = 'accepted',
        accepted_at = coalesce(new.email_confirmed_at, now()),
        accepted_by = new.id
    where id = v_invite.id;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Accept the invitation when the invitee confirms their email.
--
-- This is the moment the invitation is genuinely accepted: the person has proved
-- control of the address.
-- ---------------------------------------------------------------------------
create or replace function app_private.accept_invitation_on_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.invitations
  set status = 'accepted',
      accepted_at = coalesce(new.email_confirmed_at, now()),
      accepted_by = new.id
  where lower(email) = lower(new.email)
    and status = 'pending';

  return new;
end;
$$;

drop trigger if exists on_auth_user_confirmed_accept_invitation on auth.users;
create trigger on_auth_user_confirmed_accept_invitation
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function app_private.accept_invitation_on_confirmation();

-- ---------------------------------------------------------------------------
-- The invitation list must be readable by whoever can manage users, and must
-- include rows an administrator actually needs to act on.
-- ---------------------------------------------------------------------------
create index if not exists invitations_status_idx
  on public.invitations (organization_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Backfill: existing invitations were all marked accepted by the old trigger at
-- invite time. Re-derive the truth from the auth record so the list is accurate
-- after this migration rather than permanently misleading.
-- ---------------------------------------------------------------------------
update public.invitations i
set status = 'pending',
    accepted_at = null,
    accepted_by = null
where i.status = 'accepted'
  and exists (
    select 1 from auth.users u
    where lower(u.email) = lower(i.email)
      and u.email_confirmed_at is null
  );

update public.invitations i
set accepted_at = u.email_confirmed_at
from auth.users u
where lower(u.email) = lower(i.email)
  and i.status = 'accepted'
  and i.accepted_at is null
  and u.email_confirmed_at is not null;
