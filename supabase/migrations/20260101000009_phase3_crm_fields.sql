-- ============================================================================
-- 0009 — Phase 3: CRM field completeness + agency partners
--
-- Three gaps this closes:
--
-- 1. PUBLISHERS lacked fields the module specification requires: a website URL
--    (a domain is not a URL), a spam metric, contact NAME, and a current asking
--    price. `publisher_offers` already existed as a history table, but nothing
--    recorded "what this site costs right now" for a list view.
--
-- 2. PROSPECTS carried no metrics at all. A prospective site is evaluated on the
--    SAME numbers as a publisher — DR, traffic, spam, niche, price — so those
--    belong on the row, denormalized from the publisher when one is linked.
--    Without them the prospect pipeline cannot be filtered or sorted sensibly.
--
-- 3. AGENCY PARTNERS did not exist. The business distinguishes a CLIENT (the
--    brand paying for links) from an AGENCY PARTNER (a white-label or reseller
--    agency that buys fulfilment on behalf of ITS clients). They have different
--    pricing, commission and reporting needs, so folding them into `clients`
--    would conflate two different commercial relationships.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PUBLISHERS — specification fields
-- ---------------------------------------------------------------------------
alter table public.publishers
  add column if not exists website_url     text,
  add column if not exists contact_name    text,
  -- Spam metrics. 0-100 where higher is worse (the convention every SEO tool
  -- uses). Kept separate from `dr` because they measure opposite things.
  add column if not exists spam_score      numeric(5,2) check (spam_score is null or spam_score between 0 and 100),
  add column if not exists spam_source     text,
  -- The CURRENT asking price. `publisher_offers` remains the full history; a
  -- trigger below appends to it whenever this scalar changes, so the scalar is
  -- the present and the table is the past. One source of truth for each.
  add column if not exists price           numeric(12,2) check (price is null or price >= 0),
  add column if not exists currency        char(3) not null default 'USD',
  add column if not exists accepts_link_insertion boolean;

comment on column public.publishers.price is
  'Current asking price. Changes are appended to publisher_offers by trigger; never edit history by hand.';
comment on column public.publishers.spam_score is
  '0-100, higher is worse. Null means not yet assessed, which is different from a good score.';

create index if not exists publishers_org_price_idx on public.publishers (organization_id, price);
create index if not exists publishers_org_spam_idx on public.publishers (organization_id, spam_score);
create index if not exists publishers_traffic_idx on public.publishers (organization_id, monthly_traffic desc nulls last);

-- Keep the offer history in step with the scalar.
create or replace function app_private.record_publisher_price_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.price is distinct from old.price and new.price is not null then
    insert into public.publisher_offers (
      organization_id, publisher_id, quoted_price, currency, link_type, valid_from, source
    ) values (
      new.organization_id, new.id, new.price, coalesce(new.currency, 'USD'),
      coalesce(new.link_type, 'dofollow'), current_date, 'publisher record edit'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists publishers_record_price_change on public.publishers;
create trigger publishers_record_price_change
  after update of price on public.publishers
  for each row execute function app_private.record_publisher_price_change();

-- ---------------------------------------------------------------------------
-- PROSPECTS — the same evaluation metrics
-- ---------------------------------------------------------------------------
alter table public.prospects
  add column if not exists website_url     text,
  add column if not exists dr              integer check (dr is null or dr between 0 and 100),
  add column if not exists monthly_traffic bigint check (monthly_traffic is null or monthly_traffic >= 0),
  add column if not exists spam_score      numeric(5,2) check (spam_score is null or spam_score between 0 and 100),
  add column if not exists niche           text[] not null default '{}',
  add column if not exists price           numeric(12,2) check (price is null or price >= 0),
  add column if not exists currency        char(3) not null default 'USD',
  add column if not exists contact_name_2  text;

create index if not exists prospects_org_dr_idx on public.prospects (organization_id, dr desc nulls last);
create index if not exists prospects_org_traffic_idx on public.prospects (organization_id, monthly_traffic desc nulls last);

-- When a prospect is linked to a publisher, inherit that publisher's metrics if
-- the prospect has none of its own. This keeps the pipeline readable without
-- forcing a duplicate data-entry pass, and never overwrites a value the user
-- already typed.
create or replace function app_private.inherit_publisher_metrics()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pub record;
begin
  if new.publisher_id is null then
    return new;
  end if;

  select dr, monthly_traffic, spam_score, niche, price, currency, website_url, contact_name, contact_email
    into v_pub
  from public.publishers
  where id = new.publisher_id;

  if v_pub is null then
    return new;
  end if;

  new.dr              := coalesce(new.dr, v_pub.dr);
  new.monthly_traffic := coalesce(new.monthly_traffic, v_pub.monthly_traffic);
  new.spam_score      := coalesce(new.spam_score, v_pub.spam_score);
  new.price           := coalesce(new.price, v_pub.price);
  new.website_url     := coalesce(new.website_url, v_pub.website_url);
  new.contact_name    := coalesce(new.contact_name, v_pub.contact_name);
  new.contact_email   := coalesce(new.contact_email, v_pub.contact_email);

  if coalesce(array_length(new.niche, 1), 0) = 0 and v_pub.niche is not null then
    new.niche := v_pub.niche;
  end if;

  return new;
end;
$$;

drop trigger if exists prospects_inherit_metrics on public.prospects;
create trigger prospects_inherit_metrics
  before insert or update of publisher_id on public.prospects
  for each row execute function app_private.inherit_publisher_metrics();

-- ---------------------------------------------------------------------------
-- AGENCY PARTNERS
--
-- A white-label or reseller agency that buys fulfilment to resell under its own
-- brand. Distinct from a client: it has a discount/markup arrangement and may
-- have several of its own end-clients behind it, which we must never see.
-- ---------------------------------------------------------------------------
create table if not exists public.agency_partners (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete restrict,
  name               text not null check (length(trim(name)) > 0),
  domain             text not null,
  partner_type       text not null default 'white_label'
                     check (partner_type in ('white_label', 'reseller', 'referral')),
  status             text not null default 'active'
                     check (status in ('prospect', 'active', 'paused', 'churned')),
  contact_name       text,
  contact_email      citext,
  contact_phone      text,
  -- How this partner is charged. `markup_pct` is applied to our cost; a
  -- `discount_pct` reduces our list price. Storing both would be ambiguous, so
  -- `pricing_model` says which one is in force.
  pricing_model      text not null default 'markup'
                     check (pricing_model in ('markup', 'discount', 'fixed')),
  markup_pct         numeric(5,2) check (markup_pct is null or markup_pct between 0 and 1000),
  discount_pct       numeric(5,2) check (discount_pct is null or discount_pct between 0 and 100),
  fixed_rate         numeric(12,2) check (fixed_rate is null or fixed_rate >= 0),
  currency           char(3) not null default 'USD',
  billing_email      citext,
  payment_terms_days integer not null default 30 check (payment_terms_days between 0 and 365),
  -- Whether reports carry our brand or theirs.
  white_label_reports boolean not null default true,
  account_manager_id uuid references public.profiles(id) on delete set null,
  start_date         date,
  notes              text,
  deleted_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint partner_pricing_consistent check (
    (pricing_model = 'markup'   and markup_pct   is not null)
    or (pricing_model = 'discount' and discount_pct is not null)
    or (pricing_model = 'fixed'    and fixed_rate   is not null)
  )
);

create unique index if not exists agency_partners_org_domain_idx
  on public.agency_partners (organization_id, lower(domain)) where deleted_at is null;
create index if not exists agency_partners_org_status_idx
  on public.agency_partners (organization_id, status);

alter table public.agency_partners enable row level security;
alter table public.agency_partners force row level security;

create trigger agency_partners_set_updated_at
  before update on public.agency_partners
  for each row execute function app_private.set_updated_at();

-- Internal staff read; account managers and the owner write. A partner is a
-- commercial record, so prospectors and writers have no business seeing it.
create policy agency_partners_select on public.agency_partners
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and deleted_at is null
    and (app_private.is_internal() or app_private.can_see_client(id))
  );

create policy agency_partners_insert on public.agency_partners
  for insert to authenticated
  with check (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager'])
  );

create policy agency_partners_update on public.agency_partners
  for update to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager'])
  )
  with check (organization_id = app_private.current_org_id());

create policy agency_partners_delete on public.agency_partners
  for delete to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

-- ---------------------------------------------------------------------------
-- Clients gain the partner link, so a partner's work can be reported on.
-- ---------------------------------------------------------------------------
alter table public.clients
  add column if not exists agency_partner_id uuid references public.agency_partners(id) on delete set null,
  add column if not exists website_url text;

create index if not exists clients_partner_idx on public.clients (agency_partner_id);

-- ---------------------------------------------------------------------------
-- Full-text search support.
--
-- `ilike '%term%'` cannot use a btree index and degrades badly on a large
-- publisher table. A trigram index makes prefix and substring search fast,
-- which is what the search boxes in every module need.
-- ---------------------------------------------------------------------------
create extension if not exists pg_trgm;

create index if not exists publishers_domain_trgm_idx
  on public.publishers using gin (lower(domain) gin_trgm_ops);
create index if not exists publishers_name_trgm_idx
  on public.publishers using gin (lower(coalesce(name, '')) gin_trgm_ops);
create index if not exists clients_name_trgm_idx
  on public.clients using gin (lower(name) gin_trgm_ops);
create index if not exists prospects_domain_trgm_idx
  on public.prospects using gin (lower(domain) gin_trgm_ops);
create index if not exists agency_partners_name_trgm_idx
  on public.agency_partners using gin (lower(name) gin_trgm_ops);
