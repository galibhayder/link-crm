-- ============================================================================
-- 0002 — Core tables: tenancy, identity, clients, campaigns, suppliers,
--        publishers, prospects, placements, and the financial tiers.
--
-- Design rules enforced here:
--   * Every tenant table carries organization_id NOT NULL.
--   * No money column appears twice. Client price and supplier cost are in
--     DIFFERENT tables so RLS can separate them by role.
--   * Status columns are text + CHECK, never enums, so a new pipeline stage is
--     a constraint change rather than an enum migration.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create table public.organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(trim(name)) > 0),
  slug          text not null unique,
  timezone      text not null default 'UTC',
  currency      char(3) not null default 'USD',
  invoice_prefix text not null default 'INV',
  logo_url      text,
  brand_color   text,
  settings      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.suppliers (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete restrict,
  name               text not null check (length(trim(name)) > 0),
  -- A site owner and a link wholesaler are the same party type with different
  -- capabilities, so they share one table and one portal.
  supplier_type      text not null check (supplier_type in ('direct_publisher', 'link_vendor')),
  contact_name       text,
  contact_email      citext,
  payment_terms_days integer not null default 30 check (payment_terms_days between 0 and 365),
  status             text not null default 'active' check (status in ('active', 'paused', 'archived')),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index suppliers_org_idx on public.suppliers (organization_id, status);

-- ---------------------------------------------------------------------------
-- Profiles — application identity, one row per auth user, in exactly one org.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  full_name       text not null check (length(trim(full_name)) > 0),
  email           citext not null,
  role            text not null check (role in (
                    'owner', 'account_manager', 'prospector', 'outreach_specialist',
                    'content_writer', 'client_user', 'publisher_user')),
  supplier_id     uuid references public.suppliers(id) on delete set null,
  phone           text,
  avatar_url      text,
  is_active       boolean not null default true,
  last_seen_at    timestamptz,
  role_changed_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A publisher_user must be bound to a supplier; nobody else may be.
  constraint publisher_requires_supplier check (
    (role = 'publisher_user' and supplier_id is not null)
    or (role <> 'publisher_user')
  )
);
create index profiles_org_role_idx on public.profiles (organization_id, role);
create unique index profiles_org_email_idx on public.profiles (organization_id, email);

-- ---------------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------------
create table public.clients (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  name            text not null check (length(trim(name)) > 0),
  domain          text not null,
  industry        text,
  status          text not null default 'prospect' check (status in ('prospect', 'active', 'paused', 'churned')),
  manager_id      uuid references public.profiles(id) on delete set null,
  start_date      date,
  notes           text,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- Domain uniqueness per org, case-insensitive: this is what makes CSV dedupe work.
create unique index clients_org_domain_idx on public.clients (organization_id, lower(domain)) where deleted_at is null;
create index clients_org_status_idx on public.clients (organization_id, status);

-- Billing identity, needed by the invoice PDF. Separate table so billing access
-- can be granted or withheld without exposing client rows.
create table public.client_billing_profiles (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete restrict,
  client_id          uuid not null unique references public.clients(id) on delete cascade,
  legal_name         text,
  billing_address    jsonb not null default '{}'::jsonb,
  tax_id             text,
  tax_rate           numeric(5,2) not null default 0 check (tax_rate between 0 and 100),
  billing_currency   char(3) not null default 'USD',
  payment_terms_days integer not null default 30 check (payment_terms_days between 0 and 365),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.client_contacts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  client_id       uuid not null references public.clients(id) on delete cascade,
  name            text not null,
  email           citext,
  phone           text,
  role_title      text,
  is_primary      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index client_contacts_client_idx on public.client_contacts (client_id);

-- Portal scoping: which client_user may see which client.
create table public.user_client_access (
  user_id         uuid not null references public.profiles(id) on delete cascade,
  client_id       uuid not null references public.clients(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  created_at      timestamptz not null default now(),
  primary key (user_id, client_id)
);
create index user_client_access_client_idx on public.user_client_access (client_id);

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------
create table public.campaigns (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete restrict,
  client_id           uuid not null references public.clients(id) on delete restrict,
  name                text not null check (length(trim(name)) > 0),
  status              text not null default 'draft' check (status in ('draft', 'active', 'paused', 'completed', 'cancelled')),
  service_type        text not null default 'guest_post' check (service_type in ('guest_post', 'niche_edit', 'digital_pr', 'link_insertion')),
  start_date          date,
  end_date            date,
  monthly_link_target integer not null default 0 check (monthly_link_target >= 0),
  -- Target thresholds a prospect must clear to be pitched. Central to the
  -- quality rules in the agency's SOPs.
  target_dr_min       integer check (target_dr_min between 0 and 100),
  target_traffic_min  integer check (target_traffic_min >= 0),
  anchor_mix          jsonb not null default '{}'::jsonb,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint campaign_dates_ordered check (end_date is null or start_date is null or end_date >= start_date)
);
create index campaigns_org_client_idx on public.campaigns (organization_id, client_id, status);

create table public.campaign_monthly_targets (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  campaign_id     uuid not null references public.campaigns(id) on delete cascade,
  period_month    date not null,
  target_links    integer not null default 0 check (target_links >= 0),
  target_cost     numeric(12,2) check (target_cost >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint period_month_is_first check (extract(day from period_month) = 1),
  unique (campaign_id, period_month)
);

-- Who is assigned to a campaign. Without this, "assigned only" RLS is undefined.
create table public.campaign_assignments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete restrict,
  campaign_id      uuid not null references public.campaigns(id) on delete cascade,
  profile_id       uuid not null references public.profiles(id) on delete cascade,
  role_on_campaign text not null default 'contributor'
                   check (role_on_campaign in ('manager', 'prospector', 'outreach', 'writer', 'contributor')),
  created_at       timestamptz not null default now(),
  unique (campaign_id, profile_id)
);
create index campaign_assignments_profile_idx on public.campaign_assignments (profile_id);

-- ---------------------------------------------------------------------------
-- Publishers — one row per domain per agency
-- ---------------------------------------------------------------------------
create table public.publishers (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete restrict,
  supplier_id       uuid references public.suppliers(id) on delete set null,
  domain            text not null,
  name              text,
  dr                integer check (dr between 0 and 100),
  da                integer check (da between 0 and 100),
  monthly_traffic   bigint check (monthly_traffic >= 0),
  niche             text[] not null default '{}',
  country           char(2),
  language          text,
  link_type         text check (link_type in ('dofollow', 'nofollow', 'ugc', 'sponsored')),
  accepts_guest_post boolean,
  status            text not null default 'active' check (status in ('active', 'paused', 'blacklisted')),
  contact_email     citext,
  contact_form_url  text,
  metrics_source    text,
  last_checked_at   timestamptz,
  notes             text,
  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index publishers_org_domain_idx on public.publishers (organization_id, lower(domain)) where deleted_at is null;
create index publishers_org_dr_idx on public.publishers (organization_id, dr desc nulls last);
create index publishers_supplier_idx on public.publishers (supplier_id);

-- Price history rather than one overwritable scalar, so a negotiation is
-- auditable and an old quote is never silently lost.
create table public.publisher_offers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  publisher_id    uuid not null references public.publishers(id) on delete cascade,
  quoted_price    numeric(12,2) not null check (quoted_price >= 0),
  currency        char(3) not null default 'USD',
  link_type       text not null default 'dofollow' check (link_type in ('dofollow', 'nofollow', 'ugc', 'sponsored')),
  valid_from      date not null default current_date,
  valid_until     date,
  source          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint offer_window_ordered check (valid_until is null or valid_until >= valid_from)
);
create index publisher_offers_publisher_idx on public.publisher_offers (publisher_id, valid_from desc);

-- ---------------------------------------------------------------------------
-- Pipeline stages — configurable per org, referenced by prospects.stage
-- ---------------------------------------------------------------------------
create table public.pipeline_stages (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  key             text not null,
  label           text not null,
  sort_order      integer not null default 0,
  is_won          boolean not null default false,
  is_lost         boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, key),
  constraint only_one_terminal_flag check (not (is_won and is_lost))
);

-- ---------------------------------------------------------------------------
-- Prospects
-- ---------------------------------------------------------------------------
create table public.prospects (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete restrict,
  campaign_id      uuid not null references public.campaigns(id) on delete cascade,
  publisher_id     uuid references public.publishers(id) on delete set null,
  domain           text not null,
  contact_name     text,
  contact_email    citext,
  stage            text not null default 'prospected',
  assigned_to      uuid references public.profiles(id) on delete set null,
  supplier_id      uuid references public.suppliers(id) on delete set null,
  priority         text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  last_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  reply_received   boolean not null default false,
  notes            text,
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index prospects_campaign_domain_idx on public.prospects (campaign_id, lower(domain)) where deleted_at is null;
create index prospects_org_stage_idx on public.prospects (organization_id, stage);
create index prospects_follow_up_idx on public.prospects (assigned_to, next_follow_up_at) where next_follow_up_at is not null;
create index prospects_supplier_idx on public.prospects (supplier_id);

-- Stage must exist in this org's configured stages. Enforced by trigger because
-- a CHECK constraint cannot query another table.
create or replace function app_private.assert_stage_valid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.pipeline_stages ps
    where ps.organization_id = new.organization_id
      and ps.key = new.stage
  ) then
    raise exception 'Unknown pipeline stage % for organization %', new.stage, new.organization_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger prospects_stage_valid
  before insert or update of stage on public.prospects
  for each row execute function app_private.assert_stage_valid();

create table public.outreach_touchpoints (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete restrict,
  prospect_id      uuid not null references public.prospects(id) on delete cascade,
  user_id          uuid references public.profiles(id) on delete set null,
  channel          text not null check (channel in ('email', 'linkedin', 'contact_form', 'phone', 'other')),
  direction        text not null check (direction in ('outbound', 'inbound')),
  subject          text,
  body_excerpt     text,
  outcome          text check (outcome in ('no_reply', 'positive', 'negative', 'bounce', 'auto_reply')),
  occurred_at      timestamptz not null default now(),
  message_id       text,
  created_at       timestamptz not null default now()
);
create index touchpoints_prospect_idx on public.outreach_touchpoints (prospect_id, occurred_at desc);

create table public.email_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  name            text not null,
  subject         text not null,
  body_md         text not null,
  category        text not null default 'initial'
                  check (category in ('initial', 'follow_up', 'negotiation', 'placement_notice', 'invoice')),
  variables       jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- V2 seam: nothing sends from here in V1, but the shape exists so adding a
-- provider later does not require a schema migration.
create table public.email_outbox (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete restrict,
  prospect_id      uuid references public.prospects(id) on delete set null,
  template_id      uuid references public.email_templates(id) on delete set null,
  to_email         citext not null,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  provider_message_id text,
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Placements — operational data ONLY. No money in this table, by design.
-- ---------------------------------------------------------------------------
create table public.placements (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete restrict,
  campaign_id         uuid not null references public.campaigns(id) on delete restrict,
  prospect_id         uuid references public.prospects(id) on delete set null,
  publisher_id        uuid references public.publishers(id) on delete set null,
  supplier_id         uuid references public.suppliers(id) on delete set null,
  target_url          text not null,
  anchor_text         text,
  anchor_type         text check (anchor_type in ('branded', 'exact_match', 'partial_match', 'generic', 'naked_url', 'image_alt')),
  live_url            text,
  link_type           text check (link_type in ('dofollow', 'nofollow', 'ugc', 'sponsored')),
  rel_attribute       text,
  status              text not null default 'pending' check (status in ('scheduled', 'pending', 'live', 'removed', 'declined', 'refunded')),
  scheduled_date      date,
  live_date           date,
  index_status        text not null default 'unknown' check (index_status in ('unknown', 'indexed', 'not_indexed')),
  index_status_manual boolean not null default false,
  removal_detected_at timestamptz,
  last_checked_at     timestamptz,
  notes               text,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index placements_org_campaign_idx on public.placements (organization_id, campaign_id, status);
create index placements_check_queue_idx on public.placements (status, last_checked_at) where status = 'live';
create index placements_publisher_idx on public.placements (publisher_id);
create index placements_supplier_idx on public.placements (supplier_id);
create index placements_live_url_idx on public.placements (live_url);

create table public.link_checks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  placement_id    uuid not null references public.placements(id) on delete cascade,
  checked_at      timestamptz not null default now(),
  http_status     integer,
  found           boolean not null default false,
  rel_attribute   text,
  index_status    text check (index_status in ('unknown', 'indexed', 'not_indexed')),
  checked_by      text not null default 'system' check (checked_by in ('system', 'manual', 'import')),
  raw             jsonb not null default '{}'::jsonb
);
create index link_checks_placement_idx on public.link_checks (placement_id, checked_at desc);

-- ============================================================================
-- FINANCIAL TIERS
--
-- These five tables are the reason this schema is safe. Client price and
-- supplier cost are in separate tables so RLS can grant one and deny the other.
-- Putting both on placements would leak cost to every role that can read a
-- placement, because RLS filters rows and not columns.
-- ============================================================================

-- TIER 1 — what the client is charged.
create table public.placement_pricing (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  placement_id    uuid not null unique references public.placements(id) on delete cascade,
  client_rate     numeric(12,2) not null default 0 check (client_rate >= 0),
  currency        char(3) not null default 'USD',
  billed          boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- TIER 2 — what we pay the supplier.
create table public.placement_costs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  placement_id    uuid not null unique references public.placements(id) on delete cascade,
  supplier_cost   numeric(12,2) not null default 0 check (supplier_cost >= 0),
  currency        char(3) not null default 'USD',
  supplier_id     uuid references public.suppliers(id) on delete set null,
  paid            boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index placement_costs_supplier_idx on public.placement_costs (supplier_id);

-- Tier 1 at client level.
create table public.client_contracts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  client_id       uuid not null references public.clients(id) on delete cascade,
  retainer_amount numeric(12,2) not null default 0 check (retainer_amount >= 0),
  currency        char(3) not null default 'USD',
  billing_cycle   text not null default 'monthly' check (billing_cycle in ('monthly', 'quarterly', 'one_off')),
  start_date      date not null default current_date,
  end_date        date,
  status          text not null default 'active' check (status in ('active', 'paused', 'ended')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Tier 2 at supplier level.
create table public.supplier_bills (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  supplier_id     uuid not null references public.suppliers(id) on delete restrict,
  placement_id    uuid references public.placements(id) on delete set null,
  amount          numeric(12,2) not null check (amount >= 0),
  currency        char(3) not null default 'USD',
  bill_number     text,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'paid', 'disputed')),
  due_date        date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index supplier_bills_supplier_idx on public.supplier_bills (supplier_id, status);

-- Invoices (tier 1). Status for payment is DERIVED from payments, not stored
-- as the source of truth, so a partial payment is representable.
create table public.invoices (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  client_id       uuid not null references public.clients(id) on delete restrict,
  invoice_number  text not null,
  period_start    date not null,
  period_end      date not null,
  status          text not null default 'draft'
                  check (status in ('draft', 'sent', 'paid', 'partially_paid', 'overdue', 'void')),
  subtotal        numeric(12,2) not null default 0 check (subtotal >= 0),
  tax_rate        numeric(5,2) not null default 0 check (tax_rate between 0 and 100),
  tax_amount      numeric(12,2) not null default 0 check (tax_amount >= 0),
  total           numeric(12,2) not null default 0 check (total >= 0),
  currency        char(3) not null default 'USD',
  due_date        date,
  issued_at       timestamptz,
  pdf_path        text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint invoice_period_ordered check (period_end >= period_start),
  unique (organization_id, invoice_number)
);
create index invoices_org_status_idx on public.invoices (organization_id, status);
create index invoices_client_idx on public.invoices (client_id);

create table public.invoice_line_items (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  invoice_id      uuid not null references public.invoices(id) on delete cascade,
  description     text not null,
  quantity        numeric(10,2) not null default 1 check (quantity > 0),
  unit_price      numeric(12,2) not null default 0 check (unit_price >= 0),
  amount          numeric(12,2) generated always as (round(quantity * unit_price, 2)) stored,
  placement_id    uuid references public.placements(id) on delete set null,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now()
);
create index invoice_line_items_invoice_idx on public.invoice_line_items (invoice_id, sort_order);

-- Payments (tier 1). Multiple rows per invoice; invoice status is computed.
create table public.payments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  invoice_id      uuid not null references public.invoices(id) on delete restrict,
  amount          numeric(12,2) not null check (amount > 0),
  currency        char(3) not null default 'USD',
  method          text not null default 'bank_transfer'
                  check (method in ('bank_transfer', 'card', 'paypal', 'wise', 'other')),
  reference       text,
  received_at     timestamptz not null default now(),
  recorded_by     uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index payments_invoice_idx on public.payments (invoice_id);

-- ---------------------------------------------------------------------------
-- Content briefs — the content_writer's actual work queue.
-- ---------------------------------------------------------------------------
create table public.content_briefs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  placement_id    uuid not null references public.placements(id) on delete cascade,
  assigned_to     uuid references public.profiles(id) on delete set null,
  brief           text,
  draft_url       text,
  status          text not null default 'briefed'
                  check (status in ('briefed', 'drafting', 'submitted', 'revision', 'approved', 'published')),
  revision_notes  text,
  due_date        date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index content_briefs_assignee_idx on public.content_briefs (assigned_to, status);

-- ---------------------------------------------------------------------------
-- Cross-cutting
-- ---------------------------------------------------------------------------
create table public.document_sequences (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  doc_type        text not null,
  next_number     integer not null default 1,
  primary key (organization_id, doc_type)
);

create table public.activity_log (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete restrict,
  actor_id            uuid references public.profiles(id) on delete set null,
  actor_name_snapshot text,
  actor_role          text,
  entity_type         text not null,
  entity_id           uuid,
  action              text not null
                      check (action in ('create', 'update', 'delete', 'status_change', 'login', 'export', 'invite', 'impersonate')),
  diff                jsonb not null default '{}'::jsonb,
  ip                  inet,
  user_agent          text,
  created_at          timestamptz not null default now()
);
create index activity_log_entity_idx on public.activity_log (organization_id, entity_type, entity_id, created_at desc);
create index activity_log_org_time_idx on public.activity_log (organization_id, created_at desc);

-- Attachments: carries a RESOLVED client_id/campaign_id so its RLS policy does
-- not have to trust an unroutable polymorphic entity_id.
create table public.attachments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  entity_type     text not null check (entity_type in ('client', 'campaign', 'placement', 'invoice', 'prospect')),
  entity_id       uuid not null,
  client_id       uuid references public.clients(id) on delete cascade,
  campaign_id     uuid references public.campaigns(id) on delete cascade,
  storage_path    text not null,
  file_name       text not null,
  mime            text not null,
  size_bytes      bigint not null default 0 check (size_bytes >= 0),
  uploaded_by     uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index attachments_entity_idx on public.attachments (entity_type, entity_id);
create index attachments_client_idx on public.attachments (client_id);

create table public.custom_field_definitions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  entity_type     text not null check (entity_type in ('client', 'campaign', 'publisher', 'prospect', 'placement')),
  key             text not null,
  label           text not null,
  field_type      text not null check (field_type in ('text', 'number', 'date', 'select', 'multiselect', 'boolean', 'url')),
  options         jsonb not null default '[]'::jsonb,
  is_required     boolean not null default false,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (organization_id, entity_type, key)
);

create table public.custom_field_values (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  definition_id   uuid not null references public.custom_field_definitions(id) on delete cascade,
  entity_id       uuid not null,
  client_id       uuid references public.clients(id) on delete cascade,
  campaign_id     uuid references public.campaigns(id) on delete cascade,
  value_text      text,
  value_number    numeric,
  value_date      date,
  value_bool      boolean,
  value_jsonb     jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (definition_id, entity_id)
);
create index custom_field_values_entity_idx on public.custom_field_values (definition_id, entity_id);

create table public.saved_views (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  module          text not null,
  name            text not null,
  filters         jsonb not null default '{}'::jsonb,
  sort            jsonb not null default '{}'::jsonb,
  is_shared       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.notifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  type            text not null,
  payload         jsonb not null default '{}'::jsonb,
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, read_at);

create table public.export_jobs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  requested_by    uuid not null references public.profiles(id) on delete cascade,
  entity          text not null,
  format          text not null default 'csv' check (format in ('csv', 'xlsx')),
  filters         jsonb not null default '{}'::jsonb,
  status          text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  storage_path    text,
  row_count       integer,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.job_runs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  job_name        text not null,
  status          text not null default 'running' check (status in ('running', 'ok', 'error')),
  detail          jsonb not null default '{}'::jsonb,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz
);

-- ---------------------------------------------------------------------------
-- Scope helpers that read tables — defined here, after those tables exist.
--
-- SECURITY DEFINER is mandatory for two reasons:
--   1. A subquery written inline in a policy runs AS THE CALLER and is therefore
--      filtered by the target table's own RLS, which silently changes the answer
--      and can recurse. These functions see the real rows.
--   2. A policy on user_client_access must be able to ask
--      "is this client mine?" without recursing into itself.
-- ---------------------------------------------------------------------------

create or replace function app_private.current_supplier_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.supplier_id
  from public.profiles p
  where p.id = auth.uid()
    and p.is_active;
$$;

create or replace function app_private.current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.profiles p
  where p.id = auth.uid()
    and p.is_active;
$$;

-- The single gate the client portal depends on.
-- Internal staff see every client in their org; a client_user sees only the
-- clients explicitly granted; nobody else sees any.
create or replace function app_private.can_see_client(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_client_id is null then false
    when app_private.is_internal() then true
    when app_private.current_app_role() = 'client_user' then exists (
      select 1
      from public.user_client_access uca
      join public.profiles p on p.id = uca.user_id
      where uca.user_id = auth.uid()
        and uca.client_id = p_client_id
        and p.is_active
    )
    else false
  end;
$$;

create or replace function app_private.client_of_campaign(p_campaign_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.client_id from public.campaigns c where c.id = p_campaign_id;
$$;

-- Basis for the "assigned only" scope. Without a real assignment table, the
-- notion of an assigned link_builder is undefined and the matrix is fiction.
create or replace function app_private.is_assigned_to_campaign(p_campaign_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.campaign_assignments ca
    where ca.campaign_id = p_campaign_id
      and ca.profile_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'organizations','suppliers','profiles','clients','client_billing_profiles',
    'client_contacts','campaigns','campaign_monthly_targets','publishers',
    'publisher_offers','pipeline_stages','prospects','email_templates',
    'email_outbox','placements','placement_pricing','placement_costs',
    'client_contracts','supplier_bills','invoices','content_briefs',
    'custom_field_values','saved_views','export_jobs'
  ]
  loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function app_private.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end $$;
