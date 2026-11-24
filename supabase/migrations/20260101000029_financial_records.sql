-- ===========================================================================
-- 0029 — FINANCIAL RECORDS
--
-- Three new tables, each with a deliberately narrow audience:
--
--   writer_payouts      what we pay writers        owner only
--   campaign_expenses   other campaign costs       owner only
--   invoice_share_links public-link tokens         owner + account_manager
--
-- The first two are the most sensitive numbers in the business after wholesale
-- cost, so they get their OWN permissions rather than reusing `costs:*`.
-- `costs:read` includes prospector and outreach_specialist; neither has any
-- business seeing what a writer is paid.
--
-- Share links store a SHA-256 HASH of the token, never the token. A dump of this
-- table therefore yields no working link — which is the entire point of hashing
-- something you still need to look up by value.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. WRITER PAYOUTS
--
-- One row per fee event, not one row per writer. A bonus and a per-article fee
-- on the same placement are separate rows with separate payment states, which a
-- single `fee` column could not express.
-- ---------------------------------------------------------------------------
create table public.writer_payouts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  placement_id    uuid references public.placements(id) on delete set null,
  campaign_id     uuid references public.campaigns(id) on delete set null,
  writer_id       uuid references public.profiles(id) on delete set null,
  fee_type        text not null default 'per_article'
                    check (fee_type in ('per_article', 'per_word', 'bonus', 'other')),
  description     text,
  amount          numeric(12,2) not null check (amount >= 0),
  currency        char(3) not null default 'USD' check (currency::text ~ '^[A-Z]{3}$'),
  status          text not null default 'pending'
                    check (status in ('pending', 'approved', 'paid')),
  paid_at         timestamptz,
  reference       text,
  notes           text,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- A row marked paid must say when, otherwise "paid" is unfalsifiable.
  constraint writer_payouts_paid_at_check
    check (status <> 'paid' or paid_at is not null)
);

create index writer_payouts_org_status_idx on public.writer_payouts (organization_id, status, created_at desc);
create index writer_payouts_placement_idx  on public.writer_payouts (placement_id);
create index writer_payouts_campaign_idx   on public.writer_payouts (campaign_id);
create index writer_payouts_writer_idx     on public.writer_payouts (writer_id);

create trigger writer_payouts_set_updated_at
  before update on public.writer_payouts
  for each row execute function app_private.set_updated_at();

alter table public.writer_payouts enable row level security;
alter table public.writer_payouts force row level security;

-- OWNER ONLY. Not account_manager, not the writer themself: a writer seeing their
-- own payout history would also see every other writer's, because RLS filters
-- rows and there is no per-writer visibility concept in the product.
create policy writer_payouts_select on public.writer_payouts
  for select to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

create policy writer_payouts_write on public.writer_payouts
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner')
  with check (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

comment on table public.writer_payouts is
  'Internal writer fees. Owner-only by policy; never exposed to clients, publishers or writers.';

-- ---------------------------------------------------------------------------
-- 2. CAMPAIGN EXPENSES
--
-- The "other campaign expenses" line. Kept separate from placement_costs because
-- a tool subscription is not a publisher cost and must not be attributed to a
-- single placement's margin.
-- ---------------------------------------------------------------------------
create table public.campaign_expenses (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  campaign_id     uuid not null references public.campaigns(id) on delete cascade,
  placement_id    uuid references public.placements(id) on delete set null,
  category        text not null default 'other'
                    check (category in ('tools', 'subcontractor', 'advertising', 'travel', 'other')),
  description     text not null,
  amount          numeric(12,2) not null check (amount >= 0),
  currency        char(3) not null default 'USD' check (currency::text ~ '^[A-Z]{3}$'),
  incurred_on     date not null default current_date,
  vendor          text,
  notes           text,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index campaign_expenses_campaign_idx on public.campaign_expenses (campaign_id, incurred_on desc);
create index campaign_expenses_org_idx      on public.campaign_expenses (organization_id, incurred_on desc);

create trigger campaign_expenses_set_updated_at
  before update on public.campaign_expenses
  for each row execute function app_private.set_updated_at();

alter table public.campaign_expenses enable row level security;
alter table public.campaign_expenses force row level security;

create policy campaign_expenses_select on public.campaign_expenses
  for select to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

create policy campaign_expenses_write on public.campaign_expenses
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner')
  with check (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

comment on table public.campaign_expenses is
  'Non-publisher campaign costs. Owner-only; rolled into v_campaign_profitability.';

-- ---------------------------------------------------------------------------
-- 3. INVOICE SHARE LINKS
--
-- `token_hash` is SHA-256 of a 32-byte random token. The raw token is returned to
-- the caller exactly once, at creation, and is never stored — so "show me all my
-- links" can list them for revocation without being able to reconstruct one.
--
-- Hashing makes the lookup a deliberate equality on a hex string with its own
-- unique index: constant time in practice, and no plaintext at rest.
-- ---------------------------------------------------------------------------
create table public.invoice_share_links (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete restrict,
  invoice_id       uuid not null references public.invoices(id) on delete cascade,
  token_hash       text not null unique,
  created_by       uuid references public.profiles(id) on delete set null,
  expires_at       timestamptz,
  revoked_at       timestamptz,
  revoked_by       uuid references public.profiles(id) on delete set null,
  last_accessed_at timestamptz,
  access_count     integer not null default 0,
  created_at       timestamptz not null default now(),

  -- A 64-char lowercase hex digest. Rejecting anything else means a bug cannot
  -- silently store a raw token in the hash column.
  constraint invoice_share_links_hash_format
    check (token_hash ~ '^[0-9a-f]{64}$'),

  constraint invoice_share_links_expiry_after_creation
    check (expires_at is null or expires_at > created_at)
);

-- One ACTIVE link per invoice. Revoked and expired links remain as history but
-- do not block a new one, which is how rotation works without deleting the trail.
create unique index invoice_share_links_one_active_idx
  on public.invoice_share_links (invoice_id)
  where revoked_at is null;

create index invoice_share_links_invoice_idx on public.invoice_share_links (invoice_id, created_at desc);
create index invoice_share_links_expiry_idx  on public.invoice_share_links (expires_at)
  where revoked_at is null;

alter table public.invoice_share_links enable row level security;
alter table public.invoice_share_links force row level security;

-- Two roles only, matching the `invoices:share` permission.
create policy invoice_share_links_select on public.invoice_share_links
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.current_app_role() in ('owner', 'account_manager')
  );

create policy invoice_share_links_write on public.invoice_share_links
  for all to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.current_app_role() in ('owner', 'account_manager')
  )
  with check (
    organization_id = app_private.current_org_id()
    and app_private.current_app_role() in ('owner', 'account_manager')
  );

comment on table public.invoice_share_links is
  'Public invoice access tokens, stored as SHA-256 only. The raw token is shown once at creation.';

-- ---------------------------------------------------------------------------
-- 4. A public read path that does NOT go through RLS.
--
-- The anonymous route has no JWT, so every policy above correctly denies it. This
-- SECURITY DEFINER function is the single controlled exception: it takes exactly
-- one hash, returns only what the public page needs, and touches nothing else.
--
-- It returns the SNAPSHOT, not live invoice rows. The public page therefore cannot
-- expose anything that was not frozen at issue time — internal costs never entered
-- the snapshot, so they cannot leak through this door.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_invoice_share(p_token_hash text)
returns table (
  invoice_id       uuid,
  organization_id  uuid,
  invoice_number   text,
  snapshot         jsonb,
  issued_at        timestamptz,
  due_date         date,
  total            numeric,
  paid_amount      numeric,
  balance          numeric,
  effective_status text,
  expires_at       timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    i.id,
    i.organization_id,
    i.invoice_number,
    i.snapshot,
    i.issued_at,
    i.due_date,
    i.total,
    coalesce(p.paid, 0)::numeric(12,2),
    (i.total - coalesce(p.paid, 0))::numeric(12,2),
    case
      when coalesce(p.paid, 0) >= i.total and i.total > 0 then 'paid'
      when coalesce(p.paid, 0) > 0 then 'partially_paid'
      when i.due_date is not null and i.due_date < current_date then 'overdue'
      -- Matches v_invoices exactly. A second, subtly different ladder here meant
      -- the same invoice read "published" internally and "issued" on the public
      -- page. The public projector decides what to DISPLAY; this returns the
      -- truth.
      when i.published_at is not null then 'published'
      when i.issued_at is not null or i.status = 'issued' then 'issued'
      else 'draft'
    end,
    l.expires_at
  from public.invoice_share_links l
  join public.invoices i on i.id = l.invoice_id
  left join (
    select invoice_id, sum(amount) as paid from public.payments group by invoice_id
  ) p on p.invoice_id = i.id
  where l.token_hash = p_token_hash
    and l.revoked_at is null
    and (l.expires_at is null or l.expires_at > now())
    and l.token_hash ~ '^[0-9a-f]{64}$'
    -- Never serve a link for an invoice that was cancelled after sharing.
    and i.status <> 'cancelled';
$$;

revoke all on function public.resolve_invoice_share(text) from public, anon, authenticated;
grant execute on function public.resolve_invoice_share(text) to service_role;

comment on function public.resolve_invoice_share(text) is
  'The only anonymous invoice read path. Takes a token HASH, returns the frozen snapshot. Granted to service_role only; the API calls it.';

-- ---------------------------------------------------------------------------
-- 5. Bump the access counter.
--
-- Separate from the resolver so a read stays a read. SECURITY DEFINER because the
-- anonymous caller cannot write under RLS.
-- ---------------------------------------------------------------------------
create or replace function public.touch_invoice_share(p_token_hash text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.invoice_share_links
  set access_count = access_count + 1,
      last_accessed_at = now()
  where token_hash = p_token_hash
    and revoked_at is null
    and (expires_at is null or expires_at > now());
$$;

revoke all on function public.touch_invoice_share(text) from public, anon, authenticated;
grant execute on function public.touch_invoice_share(text) to service_role;
