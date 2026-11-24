-- ============================================================================
-- 0017 — Allow placements to be archived and restored
--
-- Phase 3 solved this class of failure for the five CRM tables with
-- `archive_record_rpc` / `restore_record_rpc` (migration 0012), for the reason
-- documented there: `UPDATE ... SET deleted_at` fails under RLS with "new row
-- violates row-level security policy" even though the WITH CHECK only references
-- organization_id, because PostgREST re-reads the row on the way out and the
-- SELECT policy requires `deleted_at is null`.
--
-- The Phase 4 placements module wrote its own UPDATE and therefore hit the exact
-- same wall, returning 500 on every archive. The fix is not to weaken any policy
-- or to special-case placements in the API: it is to put `placements` in the
-- allow-list of the functions that already do this correctly.
--
-- Both functions re-derive organization and role from the caller's own claims, so
-- adding a table does not widen what a caller can reach.
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

  if p_table not in ('clients', 'publishers', 'prospects', 'campaigns', 'agency_partners', 'placements') then
    raise exception 'Archiving is not supported for %', p_table using errcode = '22023';
  end if;

  -- `placements` has no `domain`, so its label is the target URL. Choosing the
  -- label per table keeps one function serving every module without a caller
  -- passing a column name (which would be an injection surface).
  v_label := case
    when p_table in ('clients', 'publishers', 'prospects') then 'domain'
    when p_table in ('campaigns', 'agency_partners') then 'name'
    when p_table = 'placements' then 'target_url'
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

  if p_table not in ('clients', 'publishers', 'prospects', 'campaigns', 'agency_partners', 'placements') then
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

revoke all on function app_private.restore_record(text, uuid, text[]) from public, anon;
