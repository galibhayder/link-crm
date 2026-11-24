-- ============================================================================
-- 0023 — Scheduled job execution
--
-- THE PROBLEM THIS SOLVES
--
-- `pg_cron` and `pg_net` were installed but nothing ever scheduled anything: no
-- `cron.schedule` existed anywhere in the repo, and no HMAC signer existed at all.
-- The three job endpoints (`check-links`, `flag-overdue`, `follow-ups-due`,
-- `anchor-alerts`) were therefore dead code that had never been called.
--
-- WHY THE SCHEDULE LIVES IN POSTGRES, NOT IN NODE
--
-- The deployment target (Hostinger Business) stops the Node process when idle and
-- cold-starts it on the next request. Anything that lives in the Node process — a
-- `setInterval`, a `node-cron` timer — stops the moment the process sleeps, which
-- is exactly when a scheduled check needs to run.
--
-- `pg_cron` runs inside Postgres, which is Supabase and always available. It fires
-- the schedule regardless of the API's state; each firing POSTs the HMAC-signed job
-- via `pg_net`, and that request cold-starts Node on demand — the same path a real
-- user request takes.
--
-- WHY THE SIGNATURE IS COMPUTED IN SQL
--
-- `verifyHmac` in `apps/api/src/modules/jobs/index.ts` checks
-- `HMAC-SHA256(secret, "<ts>.<json body>")` as hex. `pgcrypto`'s `hmac()` computes
-- the identical value, so the secret never has to leave the database and the API's
-- auth path is untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Configuration, so the schedule is tunable without a deploy.
--
-- A single-row settings table rather than environment variables: pg_cron reads it
-- from SQL, and changing the interval should not require restarting the API.
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  key         text primary key,
  value       text not null,
  description text,
  updated_at  timestamptz not null default now()
);

alter table public.app_settings enable row level security;
alter table public.app_settings force row level security;

-- Owner may read the settings; nobody writes them through the API. They are
-- operational config, changed by a migration or by an operator in SQL.
create policy app_settings_select on public.app_settings
  for select to authenticated
  using (app_private.current_app_role() = 'owner');

insert into public.app_settings (key, value, description) values
  -- Where pg_net should POST. Local default; set per environment.
  ('jobs.api_base_url', 'http://host.docker.internal:3000',
   'Base URL the scheduler POSTs signed job requests to'),
  -- How many placements one check-links invocation processes.
  --
  -- Hostinger caps a request at 120s. At a 15s per-fetch timeout, 10 placements is
  -- ~150s worst case, so this is deliberately conservative: the job is bounded and
  -- the scheduler re-fires until the queue drains. Raising it risks a request being
  -- killed mid-run, which loses whatever had not been written yet.
  ('jobs.check_links_batch', '10',
   'Placements processed per check-links invocation (bounded by the 120s request cap)'),
  ('jobs.check_links_interval_hours', '6',
   'How often to run the link verification sweep'),
  ('jobs.anchor_alerts_interval_hours', '12',
   'How often to evaluate anchor alerts')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Invoke a job with a valid HMAC signature.
--
-- SECURITY DEFINER because the cron job runs as the postgres role but should not
-- be able to read the vault secret directly from arbitrary SQL. `search_path = ''`
-- with fully-qualified names, per the convention in this schema.
-- ---------------------------------------------------------------------------
create or replace function app_private.invoke_job(p_job text, p_org uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret   text;
  v_base_url text;
  v_body     text;
  v_ts       bigint;
  v_sig      text;
  v_request  bigint;
begin
  -- Only the three job names this system defines. A caller cannot ask pg_net to
  -- POST arbitrary paths.
  if p_job not in ('check-links', 'flag-overdue', 'follow-ups-due', 'anchor-alerts') then
    raise exception 'Unknown job %', p_job using errcode = '22023';
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'job_hmac_secret'
  limit 1;

  if v_secret is null then
    -- Not configured is a normal state on a fresh environment, not an error worth
    -- crashing a cron run over. Log and skip.
    raise notice 'job_hmac_secret not configured; skipping %', p_job;
    return null;
  end if;

  select value into v_base_url from public.app_settings where key = 'jobs.api_base_url';
  if v_base_url is null then
    raise notice 'jobs.api_base_url not configured; skipping %', p_job;
    return null;
  end if;

  -- The body must serialise EXACTLY as the API will re-serialise it, because the
  -- signature covers `JSON.stringify(req.body)`. A single json_build_object with
  -- one key is unambiguous: no whitespace, no key-order ambiguity.
  v_body := json_build_object('organizationId', p_org)::text;

  -- verifyHmac interpolates the numeric timestamp, so this must be a bare integer.
  v_ts := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;

  v_sig := encode(
    extensions.hmac((v_ts::text || '.' || v_body)::bytea, v_secret::bytea, 'sha256'),
    'hex'
  );

  select net.http_post(
    url     := v_base_url || '/api/v1/internal/jobs/' || p_job,
    body    := v_body::jsonb,
    headers := jsonb_build_object(
      'Content-Type',    'application/json',
      'x-job-timestamp', v_ts::text,
      'x-job-signature', v_sig
    ),
    timeout_milliseconds := 110000
  ) into v_request;

  return v_request;
end;
$$;

revoke all on function app_private.invoke_job(text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Run a job, guarded against overlapping execution.
--
-- `pg_try_advisory_xact_lock` rather than `pg_advisory_lock`: try-lock returns
-- false immediately instead of queueing, so a slow run does not cause a pile of
-- waiting runs. The lock is transaction-scoped and released automatically.
--
-- The lock key is (job, organisation) so two organisations' checks can proceed
-- independently, while the same organisation cannot be checked twice at once.
-- ---------------------------------------------------------------------------
create or replace function app_private.run_scheduled_job(p_job text, p_org uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key bigint;
begin
  v_key := hashtextextended('job:' || p_job || ':' || p_org::text, 0);

  if not pg_try_advisory_xact_lock(v_key) then
    -- Another run of this job for this organisation is in flight. That is the
    -- correct outcome, not an error: the batch that is running will cover it.
    raise notice 'job % for % already running; skipping', p_job, p_org;
    return false;
  end if;

  perform app_private.invoke_job(p_job, p_org);
  return true;
end;
$$;

revoke all on function app_private.run_scheduled_job(text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Cron entry points.
--
-- Wrapped in a single no-argument function per schedule because `cron.schedule`
-- takes a command string, and one function call per schedule keeps the command
-- short enough to be readable in `cron.job`.
--
-- Every organisation is processed: the app is multi-tenant, and a per-org schedule
-- would need a database write whenever a tenant is added. Looping here means adding
-- an organisation needs no cron change.
-- ---------------------------------------------------------------------------
create or replace function app_private.cron_check_links()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  for v_org in select id from public.organizations order by id loop
    perform app_private.run_scheduled_job('check-links', v_org);
  end loop;
end;
$$;

create or replace function app_private.cron_anchor_alerts()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  for v_org in select id from public.organizations order by id loop
    perform app_private.run_scheduled_job('anchor-alerts', v_org);
  end loop;
end;
$$;

create or replace function app_private.cron_flag_overdue()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  for v_org in select id from public.organizations order by id loop
    perform app_private.run_scheduled_job('flag-overdue', v_org);
  end loop;
end;
$$;

revoke all on function app_private.cron_check_links() from public, anon, authenticated;
revoke all on function app_private.cron_anchor_alerts() from public, anon, authenticated;
revoke all on function app_private.cron_flag_overdue() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The schedules.
--
-- Idempotent: `cron.unschedule` by name first, because re-running the migration
-- must not create duplicates. Names are stable so they can be inspected with
-- `select * from cron.job`.
-- ---------------------------------------------------------------------------
do $$
begin
  -- These run inside the `cron` extension, which is present in Supabase. Guarded so
  -- a local database without pg_cron installed still applies the rest of the
  -- migration rather than failing the whole deploy.
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('linkforge-check-links');
    exception when others then null;
    end;
    begin
      perform cron.unschedule('linkforge-anchor-alerts');
    exception when others then null;
    end;
    begin
      perform cron.unschedule('linkforge-flag-overdue');
    exception when others then null;
    end;

    perform cron.schedule(
      'linkforge-check-links',
      '17 */6 * * *',
      $cron$select app_private.cron_check_links()$cron$
    );

    perform cron.schedule(
      'linkforge-anchor-alerts',
      '43 */12 * * *',
      $cron$select app_private.cron_anchor_alerts()$cron$
    );

    -- Overdue invoices are cheap and time-sensitive; hourly is fine.
    perform cron.schedule(
      'linkforge-flag-overdue',
      '8 * * * *',
      $cron$select app_private.cron_flag_overdue()$cron$
    );
  end if;
end $$;

comment on table public.app_settings is
  'Operational configuration read by pg_cron jobs. Owners may read; written by migration or an operator, never through the API.';
