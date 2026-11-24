-- ============================================================================
-- 0007 — Audit log: widen the action vocabulary, and stop silent write failures
--
-- Problem found by the authorization suite:
--
--   lib/audit.ts introduced actions `role_change`, `suspend`, `activate`,
--   `logout` and `password_reset`, but `activity_log.action` was still limited
--   to the original CHECK list. Inserts for a role change were therefore
--   REJECTED by the constraint — and because lib/audit.ts deliberately does not
--   fail the request when an audit write fails, the API returned 200 while no
--   audit row was written.
--
-- A 200 with no audit trail is worse than an error: it looks like the control
-- works. The constraint is widened here, and the writer now also records its own
-- failure into the application log with the entry payload so a gap is
-- detectable even if the insert is rejected again.
-- ============================================================================

alter table public.activity_log
  drop constraint if exists activity_log_action_check;

alter table public.activity_log
  add constraint activity_log_action_check check (action in (
    'create',
    'update',
    'delete',
    'status_change',
    'login',
    'logout',
    'export',
    'invite',
    'impersonate',
    'password_reset',
    'role_change',
    'activate',
    'suspend'
  ));

-- ---------------------------------------------------------------------------
-- Guard: audit rows are immutable, for every role including service_role.
--
-- The table has no UPDATE or DELETE policy, which protects end users. This
-- trigger additionally protects against a mistaken service-role statement
-- rewriting history — the scenario an auditor actually worries about.
-- ---------------------------------------------------------------------------
create or replace function app_private.audit_log_is_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'The audit log is append-only and cannot be modified'
    using errcode = '42501';
end;
$$;

drop trigger if exists activity_log_no_update on public.activity_log;
create trigger activity_log_no_update
  before update on public.activity_log
  for each row execute function app_private.audit_log_is_append_only();

drop trigger if exists activity_log_no_delete on public.activity_log;
create trigger activity_log_no_delete
  before delete on public.activity_log
  for each row execute function app_private.audit_log_is_append_only();

-- ---------------------------------------------------------------------------
-- Index for the admin dashboard's most common query shape.
-- ---------------------------------------------------------------------------
create index if not exists activity_log_action_time_idx
  on public.activity_log (organization_id, action, created_at desc);

-- ---------------------------------------------------------------------------
-- Backfill convenience: existing rows may predate the richer action names.
-- Nothing to migrate, but record the intent so a future reader knows the older
-- rows use the original vocabulary.
-- ---------------------------------------------------------------------------
comment on column public.activity_log.action is
  'Action vocabulary. Older rows may use only the original eight values; role_change/suspend/activate/password_reset/logout were added in migration 0007.';
