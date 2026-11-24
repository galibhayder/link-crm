-- ============================================================================
-- 0001 — Extensions, private schema, claim helpers
--
-- Everything security-related is defined ONCE here. RLS policies elsewhere
-- call these helpers and never read a table directly, so a policy cannot
-- recurse into itself and a claim cannot be forged.
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";
create extension if not exists "pg_cron";
create extension if not exists "pg_net";

-- A schema that is NOT exposed through PostgREST. Helper functions live here so
-- they cannot be called over the API.
create schema if not exists app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to postgres, service_role;

-- ---------------------------------------------------------------------------
-- Claim readers
--
-- Claims come from app_metadata, which ONLY the server can write. Never
-- user_metadata: a user can set that themselves, which would let them forge
-- their own organization_id or role.
-- ---------------------------------------------------------------------------

create or replace function app_private.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'org_id', '')::uuid;
$$;

create or replace function app_private.current_app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select auth.jwt() -> 'app_metadata' ->> 'role';
$$;

create or replace function app_private.has_any_role(roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.current_app_role() = any(roles);
$$;

create or replace function app_private.is_internal()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.current_app_role() in
    ('owner', 'account_manager', 'prospector', 'outreach_specialist', 'content_writer');
$$;

-- The supplier a publisher_user is bound to. Defined with the tables it reads
-- (migration 0002), because a function body referencing public.profiles cannot
-- be created before that table exists.

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function app_private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Per-organization document numbering.
--
-- A Postgres SEQUENCE is global, so it cannot produce per-org invoice numbers.
-- This counter row replaces it and is allocated under a row lock, which is what
-- makes concurrent invoice creation safe.
-- ---------------------------------------------------------------------------
create or replace function app_private.next_document_number(p_org uuid, p_type text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_taken integer;
begin
  insert into public.document_sequences (organization_id, doc_type, next_number)
  values (p_org, p_type, 2)
  on conflict (organization_id, doc_type)
  do update set next_number = public.document_sequences.next_number + 1
  returning next_number - 1 into v_taken;

  return v_taken;
end;
$$;

-- ---------------------------------------------------------------------------
-- The Custom Access Token Hook.
--
-- Stamps org_id and role into app_metadata on every token issue. Without this,
-- every policy would have to join profiles on each row.
-- ---------------------------------------------------------------------------
create or replace function app_private.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims jsonb;
  v_profile record;
begin
  select p.organization_id, p.role, p.is_active, p.supplier_id
    into v_profile
  from public.profiles p
  where p.id = (event ->> 'user_id')::uuid;

  v_claims := coalesce(event -> 'claims', '{}'::jsonb);

  if v_profile.organization_id is not null and v_profile.is_active then
    v_claims := jsonb_set(
      v_claims,
      '{app_metadata}',
      coalesce(v_claims -> 'app_metadata', '{}'::jsonb) || jsonb_build_object(
        'org_id', v_profile.organization_id,
        'role', v_profile.role,
        'supplier_id', v_profile.supplier_id
      ),
      true
    );
  else
    -- Inactive or unprovisioned: strip the tenancy claims so every policy
    -- fails closed rather than granting access.
    v_claims := jsonb_set(
      v_claims,
      '{app_metadata}',
      coalesce(v_claims -> 'app_metadata', '{}'::jsonb) - 'org_id' - 'role' - 'supplier_id',
      true
    );
  end if;

  return jsonb_set(event, '{claims}', v_claims, true);
end;
$$;

grant execute on function app_private.custom_access_token_hook(jsonb) to supabase_auth_admin;
-- Granting EXECUTE is not enough on its own: the function lives in a schema the
-- auth service has no USAGE on, and auth would fail with
-- "Database error querying schema" on every sign-in.
grant usage on schema app_private to supabase_auth_admin;
revoke execute on function app_private.custom_access_token_hook(jsonb) from authenticated, anon, public;
