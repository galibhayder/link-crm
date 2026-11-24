-- ============================================================================
-- 0024 — Anchor alert delivery via notifications
--
-- `notifications` existed as a table with two write paths (`placement_stage_changed`
-- from the placements module, `follow_up_due` from the follow-ups job) but:
--
--   * `type` was free text with no CHECK, so a typo became a row nobody could find;
--   * there was no way to list or mark notifications read (no endpoint at all);
--   * there was no dedupe, so a recurring alert job would notify every run forever.
--
-- This migration adds the schema pieces. The list/mark-read endpoints live in
-- `apps/api/src/modules/notifications/index.ts` and work entirely through
-- `req.auth.db`, because the existing `notifications_own` and
-- `notifications_update_own` policies already allow exactly the right access.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Constrain `type` to the vocabulary the code actually writes.
--
-- Without this a typo silently produces a row no filter will ever match, and the
-- UI shows a notification it cannot label.
-- ---------------------------------------------------------------------------
alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in ('placement_stage_changed', 'follow_up_due', 'anchor_alert'));

-- ---------------------------------------------------------------------------
-- 2. Dedupe.
--
-- `dedupe_key` identifies "the same unresolved thing" — for an anchor alert it is
-- the category plus the scope, e.g. `anchor_alert:campaign:<uuid>:exact_match`.
--
-- The unique index is PARTIAL on `read_at is null`: while a notification is unread,
-- a second identical one cannot be inserted. Once the user reads it, the slot frees
-- up and a later re-fire can notify again. That is the correct semantic — "tell me
-- once about this problem, and tell me again if it comes back after I have seen it".
-- ---------------------------------------------------------------------------
alter table public.notifications
  add column if not exists dedupe_key text;

create unique index if not exists notifications_dedupe_unread_idx
  on public.notifications (organization_id, user_id, dedupe_key)
  where dedupe_key is not null and read_at is null;

comment on column public.notifications.dedupe_key is
  'Identifies an unresolved condition so it notifies once. Unique among UNREAD rows only, so it can fire again after the user has acknowledged it.';

-- Covers the list endpoint: "my unread, newest first".
create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Dedupe-safe emit.
--
-- Called by the anchor-alerts job. A conflict on the partial unique index means
-- "this user has already been told and has not read it", which is a no-op rather
-- than an error — a job must not fail because one of forty notifications was a
-- duplicate.
--
-- SECURITY DEFINER so the job (running as service_role, which bypasses RLS) and
-- any future caller share one implementation of the dedupe rule.
-- ---------------------------------------------------------------------------
create or replace function app_private.emit_notification(
  p_org        uuid,
  p_user       uuid,
  p_type       text,
  p_payload    jsonb,
  p_dedupe_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.notifications (organization_id, user_id, type, payload, dedupe_key)
  values (p_org, p_user, p_type, coalesce(p_payload, '{}'::jsonb), p_dedupe_key)
  on conflict (organization_id, user_id, dedupe_key)
    where dedupe_key is not null and read_at is null
  do nothing
  returning id into v_id;

  -- On conflict, `v_id` stays null. Return it so the caller can count real
  -- deliveries rather than attempted ones.
  return v_id;
end;
$$;

revoke all on function app_private.emit_notification(uuid, uuid, text, jsonb, text)
  from public, anon, authenticated;

comment on function app_private.emit_notification(uuid, uuid, text, jsonb, text) is
  'Insert a notification, ignoring a duplicate of an unread one. Returns NULL when suppressed.';

-- ---------------------------------------------------------------------------
-- 4. Who receives an anchor alert.
--
-- Derived from existing permissions rather than a new membership table: the people
-- who can act on anchor strategy are the owner and the account managers. A
-- prospector or writer cannot change a campaign's anchor mix, so notifying them
-- would be noise they cannot resolve.
--
-- Returns profiles, not ids, so the caller has a name for the payload.
-- ---------------------------------------------------------------------------
create or replace function app_private.anchor_alert_recipients(p_org uuid)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.profiles p
  where p.organization_id = p_org
    and p.is_active
    and p.role in ('owner', 'account_manager');
$$;

revoke all on function app_private.anchor_alert_recipients(uuid) from public, anon, authenticated;
