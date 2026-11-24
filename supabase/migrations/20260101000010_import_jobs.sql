-- ============================================================================
-- 0010 — CSV import jobs
--
-- A bulk import must be inspectable before it writes anything, and reviewable
-- after. Doing this purely in the browser means:
--   * duplicate detection runs against a stale copy of the data,
--   * a 5,000-row file has to be held and re-posted by the client,
--   * and there is no record of what was imported, by whom, or what failed.
--
-- So the server holds the parsed rows, resolves duplicates against live data,
-- and returns a per-row verdict. Commit then applies only the approved rows.
-- ============================================================================

create table if not exists public.import_jobs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by      uuid references public.profiles(id) on delete set null,
  entity          text not null
                  check (entity in ('clients', 'agency_partners', 'publishers', 'prospects', 'campaigns')),
  status          text not null default 'preview'
                  check (status in ('preview', 'committed', 'cancelled')),
  file_name       text,
  -- The raw parsed rows, exactly as submitted.
  rows            jsonb not null default '[]'::jsonb,
  -- Per-row verdicts produced at preview time: ok | duplicate | error | update.
  -- Stored so "commit" applies precisely what the user was shown — the preview
  -- and the write must never be able to disagree.
  results         jsonb not null default '[]'::jsonb,
  summary         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  committed_at    timestamptz
);

create index if not exists import_jobs_org_idx
  on public.import_jobs (organization_id, created_at desc);

alter table public.import_jobs enable row level security;
alter table public.import_jobs force row level security;

-- A user sees only their own imports; the owner sees the organisation's, which
-- is what an audit needs. Writes go through the API over service_role so the
-- verdicts cannot be tampered with between preview and commit.
create policy import_jobs_select on public.import_jobs
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (created_by = auth.uid() or app_private.current_app_role() = 'owner')
  );

create policy import_jobs_insert on public.import_jobs
  for insert to authenticated
  with check (
    organization_id = app_private.current_org_id()
    and created_by = auth.uid()
  );
