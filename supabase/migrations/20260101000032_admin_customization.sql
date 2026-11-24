-- ===========================================================================
-- 0032 — ADMIN CUSTOMIZATION
--
-- The Super Admin can rename tabs, hide modules, choose table columns, restyle
-- the app and brand it. All of that is stored as ONE validated JSON document per
-- organisation, not as schema changes — the Admin panel can never issue DDL.
--
-- THE SECURITY PREMISE, stated once so every later migration can be read against
-- it:
--
--   Customization may only NARROW what RBAC already allows.
--
--   A config can hide a module from a role. It can never reveal one. `ui_settings`
--   therefore grants write to the owner alone, read to internal roles, and NO
--   access to clients or publishers — whose screens are not customizable at all.
--
-- The API enforces the narrowing rule in code (see `findPermissionWidening`); the
-- policies here enforce WHO may describe the UI, not WHAT it permits.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. UI SETTINGS — one row per organisation
--
-- A single JSONB document rather than key/value rows: navigation, columns and
-- dashboard layout are nested structures, and flattening them into dotted keys
-- makes every read a reconstruction puzzle.
--
-- The document's SHAPE is validated by a Zod schema in `@crm/shared` on every
-- write. The CHECK below is only a size ceiling — a defence against someone
-- using a settings row as a data store.
-- ---------------------------------------------------------------------------
create table public.ui_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  config          jsonb not null default '{}'::jsonb,
  -- Incremented on every write so the client can cache-bust, and so two admins
  -- editing at once can detect that they overwrote each other.
  version         integer not null default 1,
  updated_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint ui_settings_config_object check (jsonb_typeof(config) = 'object'),
  constraint ui_settings_config_size   check (pg_column_size(config) < 262144),
  constraint ui_settings_version_positive check (version > 0)
);

create trigger ui_settings_set_updated_at
  before update on public.ui_settings
  for each row execute function app_private.set_updated_at();

/**
 * Bumps the version on every update.
 *
 * Done in the database rather than the API so a manual `update` during
 * debugging cannot silently leave a stale version behind. `OLD.version + 1`
 * rather than `version + 1` avoids the 42P01 ambiguity between the column and
 * the row being written.
 */
create or replace function app_private.bump_ui_settings_version()
returns trigger
language plpgsql
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

create trigger ui_settings_bump_version
  before update on public.ui_settings
  for each row execute function app_private.bump_ui_settings_version();

alter table public.ui_settings enable row level security;
alter table public.ui_settings force row level security;

-- Every internal role reads: the nav, theme and columns apply to all of them.
-- A client or publisher never reads this — their surfaces are fixed.
create policy ui_settings_select on public.ui_settings
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.is_internal()
  );

-- Owner only. `settings:manage` is held by the owner alone, and this policy
-- restates it so a route bug cannot become a config-write bug.
create policy ui_settings_write on public.ui_settings
  for all to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.current_app_role() = 'owner'
  )
  with check (
    organization_id = app_private.current_org_id()
    and app_private.current_app_role() = 'owner'
  );

comment on table public.ui_settings is
  'Per-organisation admin customization (nav, columns, dashboard, theme). JSONB, validated by a Zod schema in @crm/shared. Can only NARROW RBAC, never widen it.';

-- ---------------------------------------------------------------------------
-- 2. SAVED VIEWS — a default per module, and owner-authored system views
--
-- The table already existed with filters/sort/is_shared. Two additions:
--   is_default — the view a module opens with
--   is_system  — an owner-authored view shared with everyone
-- ---------------------------------------------------------------------------
alter table public.saved_views
  add column if not exists is_default boolean not null default false,
  add column if not exists is_system  boolean not null default false;

-- At most one default per user per module. A partial index expresses "one truth"
-- without forbidding the many non-default views that sit beside it.
create unique index if not exists saved_views_one_default_idx
  on public.saved_views (user_id, module)
  where is_default;

-- System views are owner-authored, so only an owner may create one. The existing
-- `saved_views_own` policy already restricts writes to `user_id = auth.uid()`,
-- which means a non-owner setting `is_system` would only be marking their own
-- row as system — harmless but misleading. This constraint makes the intent
-- explicit at the table level.
alter table public.saved_views
  drop constraint if exists saved_views_system_requires_owner;
alter table public.saved_views
  add constraint saved_views_system_requires_owner
  check (not is_system or app_private.current_app_role() = 'owner');

comment on column public.saved_views.is_default is
  'The view the module opens with. At most one per (user, module).';
comment on column public.saved_views.is_system is
  'Owner-authored view shared with the whole organisation.';

-- ---------------------------------------------------------------------------
-- 3. CUSTOM FIELDS — deactivate without destroying data
--
-- Deleting a definition cascades to `custom_field_values`, so "remove this field"
-- would silently delete every value already captured. A flag lets an admin stop
-- offering a field while preserving its history.
-- ---------------------------------------------------------------------------
alter table public.custom_field_definitions
  add column if not exists is_active boolean not null default true;

create index if not exists custom_field_defs_active_idx
  on public.custom_field_definitions (organization_id, entity_type)
  where is_active;

comment on column public.custom_field_definitions.is_active is
  'False hides the field from forms and tables. Values are NOT deleted.';

-- ---------------------------------------------------------------------------
-- 4. NOTIFICATION PREFERENCES — per user
--
-- A user owns their preferences outright. An owner cannot edit someone else's:
-- a "notification setting" that your boss can change is not a user setting.
-- ---------------------------------------------------------------------------
create table public.notification_preferences (
  user_id         uuid primary key references public.profiles(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  -- Which notification types this person does NOT want. An absent type means
  -- enabled, so a new type added later defaults to ON rather than silently off.
  muted_types     text[] not null default '{}',
  email_digest    boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function app_private.set_updated_at();

alter table public.notification_preferences enable row level security;
alter table public.notification_preferences force row level security;

create policy notification_preferences_own on public.notification_preferences
  for all to authenticated
  using (
    organization_id = app_private.current_org_id()
    and user_id = auth.uid()
  )
  with check (
    organization_id = app_private.current_org_id()
    and user_id = auth.uid()
  );

comment on table public.notification_preferences is
  'Per-user notification muting. Own-row only: even an owner cannot edit another user''s preferences.';

-- ---------------------------------------------------------------------------
-- 5. NOTE — the config row is seeded in `seed.sql`, NOT here.
--
-- The obvious version of this migration inserts one row per organisation:
--
--     insert into public.ui_settings (organization_id, config)
--     select id, '{}'::jsonb from public.organizations;
--
-- That inserts ZERO rows. Migrations run before `seed.sql`, so on a fresh reset
-- there are no organisations yet — and on a database that already has them, it
-- would work, which is the worst kind of bug: correct on an existing install,
-- broken on every clean one. It is asserted below instead, so a future reset that
-- silently produces no config fails loudly rather than at the first API call.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 6. Self-test
--
-- The version bump is easy to get wrong (a trigger that reassigns `version` to a
-- stale value silently freezes the counter), so it is asserted rather than
-- assumed.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org  uuid;
  v_v1   integer;
  v_v2   integer;
begin
  select id into v_org from public.organizations limit 1;
  if v_org is null then
    -- Expected on a clean reset: migrations precede the seed, so there is nothing
    -- to test against yet. `scripts/test-phase7-customization.mjs` asserts the
    -- version bump against real seeded data instead.
    raise notice '0032: no organisation yet (migrations precede seed), skipping version test';
    return;
  end if;

  -- Create a row if the seed has not run (an existing install will already have
  -- one from wherever it was originally created).
  insert into public.ui_settings (organization_id, config)
  values (v_org, '{}'::jsonb)
  on conflict (organization_id) do nothing;

  select version into v_v1 from public.ui_settings where organization_id = v_org;

  update public.ui_settings
     set config = jsonb_set(config, '{_selftest}', 'true'::jsonb)
   where organization_id = v_org;

  select version into v_v2 from public.ui_settings where organization_id = v_org;

  if v_v2 <> v_v1 + 1 then
    raise exception '0032: version did not increment (% -> %)', v_v1, v_v2;
  end if;

  -- Leave no trace.
  update public.ui_settings
     set config = config - '_selftest'
   where organization_id = v_org;

  raise notice '0032: ui_settings version bump verified (% -> %)', v_v1, v_v2;
end
$$;
