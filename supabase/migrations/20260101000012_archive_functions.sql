-- ============================================================================
-- 0012 — Soft-delete via an explicit, audited function
--
-- Archiving through a plain `UPDATE ... SET deleted_at` fails under RLS with
-- "new row violates row-level security policy", even though the WITH CHECK only
-- references organization_id. The interaction is subtle and version-dependent:
-- PostgreSQL re-evaluates the row against the SELECT policy when the statement
-- returns it, and PostgREST's update path does. Rather than weaken the SELECT
-- policy (which would make archived rows readable everywhere), archiving becomes
-- an explicit operation.
--
-- The function:
--   * is SECURITY DEFINER, so it can write the row the caller cannot read back;
--   * takes the organisation from the CALLER'S claims, never a parameter, so it
--     cannot archive across tenants;
--   * checks the caller's role itself, because SECURITY DEFINER bypasses the
--     policy that would otherwise do it;
--   * returns the id and label it archived, so the API can write an audit entry
--     without a second read.
-- ============================================================================

create or replace function app_private.archive_record(
  p_table  text,
  p_id     uuid,
  p_roles  text[]
)
returns table (id uuid, label text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid;
  v_role  text;
  v_label text;
  v_query text;
begin
  v_org  := app_private.current_org_id();
  v_role := app_private.current_app_role();

  if v_org is null then
    raise exception 'No organization in the caller claims' using errcode = '42501';
  end if;

  if not (v_role = any(p_roles)) then
    raise exception 'Role % may not archive %', v_role, p_table using errcode = '42501';
  end if;

  -- Only tables this function is meant to touch. A caller cannot pass an
  -- arbitrary identifier into a dynamic statement.
  if p_table not in ('clients', 'publishers', 'prospects', 'campaigns', 'agency_partners') then
    raise exception 'Archiving is not supported for %', p_table using errcode = '22023';
  end if;

  v_label := case
    when p_table in ('clients', 'publishers', 'prospects') then 'domain'
    when p_table in ('campaigns', 'agency_partners') then 'name'
    else 'id'
  end;

  v_query := format(
    'update public.%I set deleted_at = now(), updated_at = now()
       where id = $1 and organization_id = $2 and deleted_at is null
       returning id, %I::text',
    p_table, v_label
  );

  return query execute v_query using p_id, v_org;
end;
$$;

revoke all on function app_private.archive_record(text, uuid, text[]) from public, anon;

-- ---------------------------------------------------------------------------
-- Public wrappers.
--
-- These MUST be SECURITY DEFINER, not SECURITY INVOKER. `authenticated` has no
-- USAGE on `app_private`, so an invoker wrapper fails with
-- "permission denied for schema app_private" — the same class of mistake as the
-- custom access token hook in migration 0001. The safety comes from the inner
-- function, which re-derives organisation and role from the caller's own claims.
-- ---------------------------------------------------------------------------
create or replace function public.archive_record_rpc(
  p_table text,
  p_id    uuid,
  p_roles text[]
)
returns table (id uuid, label text)
language sql
security definer
set search_path = ''
as $$
  select * from app_private.archive_record(p_table, p_id, p_roles);
$$;

revoke all on function public.archive_record_rpc(text, uuid, text[]) from public, anon;
grant execute on function public.archive_record_rpc(text, uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- The matching restore operation, for the same reason: restoring clears
-- deleted_at, which also changes a row the SELECT policy cannot currently see.
-- ---------------------------------------------------------------------------
create or replace function app_private.restore_record(
  p_table text,
  p_id    uuid,
  p_roles text[]
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid;
  v_role  text;
  v_query text;
  v_count integer;
begin
  v_org  := app_private.current_org_id();
  v_role := app_private.current_app_role();

  if v_org is null then
    raise exception 'No organization in the caller claims' using errcode = '42501';
  end if;

  if not (v_role = any(p_roles)) then
    raise exception 'Role % may not restore %', v_role, p_table using errcode = '42501';
  end if;

  if p_table not in ('clients', 'publishers', 'prospects', 'campaigns', 'agency_partners') then
    raise exception 'Restoring is not supported for %', p_table using errcode = '22023';
  end if;

  v_query := format(
    'update public.%I set deleted_at = null, updated_at = now()
       where id = $1 and organization_id = $2 and deleted_at is not null',
    p_table
  );

  execute v_query using p_id, v_org;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

create or replace function public.restore_record_rpc(
  p_table text,
  p_id    uuid,
  p_roles text[]
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select app_private.restore_record(p_table, p_id, p_roles);
$$;

revoke all on function public.restore_record_rpc(text, uuid, text[]) from public, anon;
grant execute on function public.restore_record_rpc(text, uuid, text[]) to authenticated;
