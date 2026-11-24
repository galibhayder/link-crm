-- ============================================================================
-- 0005 — Fix profile privilege escalation
--
-- Two distinct vulnerabilities were confirmed by direct PostgREST calls against
-- schema 0004:
--
--   1. `profiles_update_self` had `using (id = auth.uid())` with no column
--      restriction. RLS is ROW-level, not COLUMN-level, so any authenticated
--      user could PATCH their own row and set `role = 'owner'`. The Custom
--      Access Token Hook then re-stamped that role into their JWT, giving them
--      full owner access including margins and payments.
--
--   2. `profiles_manage` was declared `FOR ALL ... using (organization_id = ...
--      and current_app_role() = 'owner')`. PostgreSQL ORs permissive policies,
--      but the USING clause alone did not constrain a non-owner's UPDATE because
--      the separate self-update policy already granted UPDATE on the row. In
--      practice a content_writer successfully PATCHed ANOTHER user's row to
--      `role = 'owner'`.
--
-- The fix is to remove all client-side write access to the privileged columns.
-- Role, activation and supplier binding are now writable ONLY by trusted server
-- code (the API, via service_role), which is the only place that can enforce
-- business rules such as "the last owner cannot be demoted".
-- ============================================================================

-- Drop the unsafe policies first: a policy cannot be edited in place.
drop policy if exists profiles_update_self on public.profiles;
drop policy if exists profiles_manage on public.profiles;

-- ---------------------------------------------------------------------------
-- Column-level privileges.
--
-- RLS decides WHICH ROWS a user may touch. Postgres column grants decide WHICH
-- COLUMNS. Both are needed for "users may edit their own name and phone but
-- never their own role".
-- ---------------------------------------------------------------------------
revoke update on public.profiles from authenticated;
grant update (full_name, phone, avatar_url) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Self-service profile edit: own row only, and only the granted columns.
--
-- The WITH CHECK repeats the id constraint so a row cannot be moved to another
-- user, and pins organization_id so a profile cannot be re-parented into a
-- different tenant.
-- ---------------------------------------------------------------------------
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and organization_id = app_private.current_org_id());

-- ---------------------------------------------------------------------------
-- Read access, restated (unchanged behaviour, kept explicit).
-- Internal staff read colleagues; everyone reads their own row.
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (app_private.is_internal() or id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- Owner INSERT only. Deliberately no UPDATE and no DELETE policy for any
-- end-user role: administration goes through the API with service_role, so the
-- last-owner guard and audit logging cannot be skipped.
-- ---------------------------------------------------------------------------
create policy profiles_insert_owner on public.profiles
  for insert to authenticated
  with check (
    organization_id = app_private.current_org_id()
    and app_private.current_app_role() = 'owner'
  );

-- ---------------------------------------------------------------------------
-- Defence in depth: a trigger that rejects privilege changes arriving without
-- server authority.
--
-- Column grants already stop this through PostgREST. This trigger also blocks it
-- for any future path that might bypass grants (a definer function, a direct
-- connection, a mistaken grant), and it produces a clear audit signal.
-- ---------------------------------------------------------------------------
create or replace function app_private.guard_privileged_profile_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_server boolean;
begin
  -- service_role is how the API administers users. It bypasses RLS and is the
  -- only role permitted to change privileged columns.
  v_is_server := current_setting('request.jwt.claims', true)::jsonb ->> 'role' = 'service_role'
                 or session_user = 'postgres';

  if v_is_server then
    return new;
  end if;

  if new.role is distinct from old.role then
    raise exception 'Only an administrator may change a user role'
      using errcode = '42501';
  end if;

  if new.is_active is distinct from old.is_active then
    raise exception 'Only an administrator may activate or suspend a user'
      using errcode = '42501';
  end if;

  if new.supplier_id is distinct from old.supplier_id then
    raise exception 'Only an administrator may rebind a supplier'
      using errcode = '42501';
  end if;

  if new.organization_id is distinct from old.organization_id then
    raise exception 'A profile cannot be moved between organizations'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard_privileged_columns on public.profiles;
create trigger profiles_guard_privileged_columns
  before update on public.profiles
  for each row execute function app_private.guard_privileged_profile_columns();

-- ---------------------------------------------------------------------------
-- Also lock down the portal scoping table.
--
-- user_client_access decides which clients a client_user may see. If a client
-- could insert their own grant they would read another client's campaigns. The
-- existing policy was already owner/account_manager-only, but restating it with
-- an explicit WITH CHECK keeps the intent obvious next to the profile fix.
-- ---------------------------------------------------------------------------
drop policy if exists uca_write on public.user_client_access;
create policy uca_write on public.user_client_access
  for all to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager'])
  )
  with check (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager'])
  );
