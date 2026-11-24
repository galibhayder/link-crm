-- ===========================================================================
-- 0027 — EXPOSE emit_notification TO THE API
--
-- DEFECT FOUND IN PHASE 5.1 TESTING
--
-- `app_private.emit_notification` is the only writer for notifications, but
-- PostgREST exposes the `public` schema only. `admin().rpc("emit_notification", ...)`
-- therefore resolved against nothing: every call failed, the API destructured
-- `data` without reading `error`, and the job counted the failure as a suppressed
-- duplicate. The result was a notifications table that stayed empty while the job
-- reported `{"suppressed": 2}` — a silent failure that looked like working dedupe.
--
-- The fix is the same shape as every other internal RPC in this schema: a thin
-- `public` wrapper that delegates to the `app_private` implementation, granted to
-- `service_role` ONLY. Authenticated users must not be able to mint notifications
-- for themselves or anyone else; the API decides who is notified.
-- ===========================================================================

create or replace function public.emit_notification_rpc(
  p_org        uuid,
  p_user       uuid,
  p_type       text,
  p_payload    jsonb,
  p_dedupe_key text default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select app_private.emit_notification(p_org, p_user, p_type, p_payload, p_dedupe_key);
$$;

revoke all on function public.emit_notification_rpc(uuid, uuid, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.emit_notification_rpc(uuid, uuid, text, jsonb, text) to service_role;

comment on function public.emit_notification_rpc(uuid, uuid, text, jsonb, text) is
  'API-facing wrapper for app_private.emit_notification. service_role only: users must not mint their own notifications.';

-- ---------------------------------------------------------------------------
-- Verify the wrapper does what the API expects.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org  uuid;
  v_user uuid;
  v_id1  uuid;
  v_id2  uuid;
  v_id3  uuid;
  v_count int;
begin
  select id into v_org from public.organizations limit 1;
  select id into v_user from public.profiles where organization_id = v_org limit 1;

  if v_org is null or v_user is null then
    raise notice '0027: no organisation to self-test against, skipping';
    return;
  end if;

  -- First insert returns an id.
  v_id1 := public.emit_notification_rpc(v_org, v_user, 'selftest', '{"n":1}'::jsonb, 'selftest:0027');
  if v_id1 is null then
    raise exception '0027: emit_notification_rpc returned null on a fresh insert';
  end if;

  -- A duplicate unread row is suppressed and returns null.
  v_id2 := public.emit_notification_rpc(v_org, v_user, 'selftest', '{"n":2}'::jsonb, 'selftest:0027');
  if v_id2 is not null then
    raise exception '0027: dedupe failed — a duplicate unread notification was inserted';
  end if;

  -- Marking it read must free the slot. This is the property the API relies on:
  -- an alert that was acknowledged can be raised again if it recurs.
  update public.notifications set read_at = now() where id = v_id1;
  v_id3 := public.emit_notification_rpc(v_org, v_user, 'selftest', '{"n":3}'::jsonb, 'selftest:0027');
  if v_id3 is null then
    raise exception '0027: a resolved alert could not be re-raised after being marked read';
  end if;

  select count(*) into v_count from public.notifications where dedupe_key = 'selftest:0027';
  if v_count <> 2 then
    raise exception '0027: expected 2 rows for the dedupe key, found %', v_count;
  end if;

  -- Leave no trace.
  delete from public.notifications where dedupe_key = 'selftest:0027';

  raise notice '0027: emit_notification_rpc verified (insert, dedupe, re-raise after read)';
end
$$;
