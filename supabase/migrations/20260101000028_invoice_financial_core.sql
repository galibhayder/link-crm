-- ===========================================================================
-- 0028 — INVOICE FINANCIAL CORE
--
-- Extends the Phase 1 invoice tables rather than replacing them. Three things
-- happen here:
--
--   1. The status vocabulary moves to the Phase 6 names (issued/published/
--      cancelled) and gains the states the brief requires.
--   2. Discounts and a frozen snapshot become first-class.
--   3. Effective status becomes DERIVED in one place, which removes a real bug:
--      `flag-overdue` used to write status='overdue' and `recompute_invoice_status`
--      could immediately write it back to 'sent'. Two writers, one field.
--
-- The snapshot is the mechanism that makes "the PDF matches what was issued"
-- structural rather than hopeful. Content is frozen at issue; payment state is
-- joined live, so a PDF downloaded after a partial payment shows the right balance.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Status vocabulary.
--
-- Casting-free, in-place rename so existing rows survive. `void` → `cancelled`
-- and `sent` → `issued`; `published` is new and means "issued AND shareable".
-- ---------------------------------------------------------------------------
alter table public.invoices drop constraint if exists invoices_status_check;

update public.invoices set status = 'issued'    where status = 'sent';
update public.invoices set status = 'cancelled' where status = 'void';

alter table public.invoices
  add constraint invoices_status_check
  check (status in ('draft', 'issued', 'published', 'partially_paid', 'paid', 'overdue', 'cancelled'));

comment on column public.invoices.status is
  'Lifecycle as WRITTEN. Effective status is derived in v_invoices; a cron must never write overdue here.';

-- Statuses that were derived rather than stored ('partially_paid', 'paid',
-- 'overdue') are legitimate historical rows; the constraint permits them so old
-- data stays valid, but nothing writes them any more.

-- ---------------------------------------------------------------------------
-- 1b. Repair the earlier views.
--
-- `v_client_profitability` and `v_ar_aging` were written against the old
-- vocabulary: they filter `status <> 'void'` and exclude `('paid', 'void')`.
-- After the rename above those predicates match nothing, so a CANCELLED invoice
-- would silently count as billed revenue and would appear in receivables.
--
-- This is exactly the kind of breakage a vocabulary rename causes quietly: no
-- error, just numbers that are wrong. Both views are recreated against the new
-- values, and `cancelled` is the only state either of them excludes.
-- ---------------------------------------------------------------------------
create or replace view public.v_client_profitability as
with billed as (
  select
    i.organization_id,
    i.client_id,
    date_trunc('month', i.period_start)::date as period_month,
    count(distinct i.id)                      as invoice_count,
    coalesce(sum(i.total), 0)                 as billed
  from public.invoices i
  where i.status <> 'cancelled'
  group by i.organization_id, i.client_id, date_trunc('month', i.period_start)::date
),
collected as (
  select
    i.organization_id,
    i.client_id,
    date_trunc('month', i.period_start)::date as period_month,
    coalesce(sum(pa.amount), 0)               as collected
  from public.invoices i
  left join public.payments pa on pa.invoice_id = i.id
  where i.status <> 'cancelled'
  group by i.organization_id, i.client_id, date_trunc('month', i.period_start)::date
),
margins as (
  select
    m.organization_id,
    m.client_id,
    date_trunc('month', coalesce(m.live_date, current_date))::date as period_month,
    sum(coalesce(m.margin, 0))                                     as margin
  from public.v_placement_margin m
  group by m.organization_id, m.client_id,
           date_trunc('month', coalesce(m.live_date, current_date))::date
)
select
  coalesce(b.organization_id, c.organization_id)   as organization_id,
  coalesce(b.client_id, c.client_id)               as client_id,
  coalesce(b.period_month, c.period_month)         as period_month,
  coalesce(b.invoice_count, 0)                     as invoice_count,
  coalesce(b.billed, 0)                            as billed,
  coalesce(c.collected, 0)                         as collected,
  coalesce(mg.margin, 0)                           as margin
from billed b
full join collected c on c.organization_id = b.organization_id
                     and c.client_id = b.client_id
                     and c.period_month = b.period_month
left join margins mg on mg.organization_id = coalesce(b.organization_id, c.organization_id)
                    and mg.client_id = coalesce(b.client_id, c.client_id)
                    and mg.period_month = coalesce(b.period_month, c.period_month);

-- Receivables: anything with a balance that is not cancelled. `paid` invoices
-- still appear (with a zero balance) because the schedule is a statement of
-- account, not a list of debts.
create or replace view public.v_ar_aging as
select
  i.organization_id,
  i.client_id,
  i.id                                                           as invoice_id,
  i.invoice_number,
  i.total,
  i.due_date,
  i.status,
  coalesce(sum(pa.amount), 0)                                    as paid_amount,
  i.total - coalesce(sum(pa.amount), 0)                          as balance,
  greatest(0, current_date - i.due_date)                         as days_overdue
from public.invoices i
left join public.payments pa on pa.invoice_id = i.id
where i.status <> 'cancelled'
group by i.organization_id, i.client_id, i.id, i.invoice_number, i.total, i.due_date, i.status;

revoke all on public.v_client_profitability from public, anon, authenticated;
grant select on public.v_client_profitability to service_role;
revoke all on public.v_ar_aging from public, anon, authenticated;
grant select on public.v_ar_aging to service_role;

-- ---------------------------------------------------------------------------
-- 2. New invoice fields.
-- ---------------------------------------------------------------------------
alter table public.invoices
  add column if not exists discount_amount      numeric(12,2) not null default 0,
  add column if not exists payment_instructions text,
  add column if not exists agency_partner_id    uuid references public.agency_partners(id) on delete set null,
  add column if not exists published_at         timestamptz,
  add column if not exists cancelled_at         timestamptz,
  add column if not exists snapshot             jsonb,
  add column if not exists snapshot_version     integer not null default 0,
  add column if not exists snapshot_hash        text;

alter table public.invoices
  add constraint invoices_discount_check check (discount_amount >= 0);

-- A 3-letter ISO code. The column already existed as char(3); this rejects
-- 'usd ', '1US' and '' without needing a currency table.
alter table public.invoices
  add constraint invoices_currency_iso check (currency::text ~ '^[A-Z]{3}$');

create index if not exists invoices_partner_idx on public.invoices (agency_partner_id);
create index if not exists invoices_due_idx     on public.invoices (organization_id, due_date)
  where status not in ('paid', 'cancelled');

comment on column public.invoices.snapshot is
  'Frozen document content (lines, tax, discount, bill-to, branding) captured at issue. NULL while draft.';
comment on column public.invoices.snapshot_version is
  'Increments each time the snapshot is frozen. 0 means never issued.';

-- ---------------------------------------------------------------------------
-- 3. Totals with discount.
--
-- Tax applies to (subtotal - discount). That ordering is stated once, here, and
-- every screen and PDF reads the result rather than recomputing it.
--
-- The discount is clamped to the subtotal so a total can never go negative — a
-- negative invoice is not a refund, it is a data error.
-- ---------------------------------------------------------------------------
create or replace function app_private.recompute_invoice_totals(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subtotal    numeric(12,2);
  v_discount    numeric(12,2);
  v_effective   numeric(12,2);
  v_tax_rate    numeric(5,2);
  v_tax         numeric(12,2);
begin
  select coalesce(sum(li.amount), 0) into v_subtotal
  from public.invoice_line_items li where li.invoice_id = p_invoice_id;

  select i.discount_amount, i.tax_rate into v_discount, v_tax_rate
  from public.invoices i where i.id = p_invoice_id;

  v_discount  := coalesce(v_discount, 0);
  v_tax_rate  := coalesce(v_tax_rate, 0);

  -- Never discount more than is owed.
  v_discount  := least(greatest(v_discount, 0), v_subtotal);
  v_effective := v_subtotal - v_discount;
  v_tax       := round(v_effective * v_tax_rate / 100, 2);

  update public.invoices
  set subtotal     = v_subtotal,
      tax_amount   = v_tax,
      total        = v_effective + v_tax,
      updated_at   = now()
  where id = p_invoice_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Status recompute — lifecycle only.
--
-- The previous version wrote 'partially_paid' and 'paid' directly, which made a
-- payment the only thing that could move status, and then fought with the
-- overdue cron. Now it writes ONLY the states that must persist (draft, issued,
-- published) and lets the view derive payment and lateness.
--
-- `cancelled` is terminal and never touched.
-- ---------------------------------------------------------------------------
create or replace function app_private.recompute_invoice_status(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select i.status into v_status from public.invoices i where i.id = p_invoice_id;

  -- Terminal. A cancelled invoice never reopens because money appeared.
  if v_status = 'cancelled' then
    return;
  end if;

  -- Nothing to do: payment states are derived, and draft/issued/published are
  -- set by explicit user actions.
  return;
end;
$$;

comment on function app_private.recompute_invoice_status(uuid) is
  'No-op retained for trigger compatibility. Effective status is derived in v_invoices; see migration 0028.';

-- ---------------------------------------------------------------------------
-- 5. Effective status, derived once.
--
-- Precedence, highest first:
--   cancelled                       terminal
--   paid / partially_paid           money received wins over lateness
--   overdue                         past due with a balance
--   published / issued / draft      lifecycle
--
-- "published" deliberately precedes "issued" so a published, unpaid invoice reads
-- as published. It is not a payment state and must not be hidden by one.
-- ---------------------------------------------------------------------------
create or replace view public.v_invoices
with (security_invoker = true) as
select
  i.*,
  c.name  as client_name,
  ap.name as agency_partner_name,
  coalesce(p.paid, 0)::numeric(12,2)                         as paid_amount,
  (i.total - coalesce(p.paid, 0))::numeric(12,2)              as balance,
  case
    when i.status = 'cancelled'                              then 'cancelled'
    when coalesce(p.paid, 0) >= i.total and i.total > 0       then 'paid'
    when coalesce(p.paid, 0) > 0                              then 'partially_paid'
    when i.status = 'paid'                                    then 'paid'
    when i.due_date is not null
         and i.due_date < current_date
         and coalesce(p.paid, 0) < i.total                    then 'overdue'
    when i.published_at is not null                           then 'published'
    when i.issued_at is not null or i.status = 'issued'       then 'issued'
    when i.status = 'partially_paid' or i.status = 'overdue'  then 'issued'
    else 'draft'
  end                                                          as effective_status,
  case
    when i.due_date is null then 0
    when i.due_date >= current_date then 0
    else (current_date - i.due_date)
  end                                                          as days_overdue
from public.invoices i
join public.clients c on c.id = i.client_id
left join public.agency_partners ap on ap.id = i.agency_partner_id
left join (
  select invoice_id, sum(amount) as paid
  from public.payments
  group by invoice_id
) p on p.invoice_id = i.id;

comment on view public.v_invoices is
  'Invoices with derived effective_status and balance. security_invoker so the caller''s RLS applies; a client_user therefore sees only their own.';

grant select on public.v_invoices to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Audit actions for financial operations.
--
-- Phase 2 hit this exact trap: widening the CHECK in the database but not the
-- TypeScript union meant every new action was rejected and the failure surfaced
-- only as a log line. The self-test below fails the migration rather than
-- letting a silent gap ship.
-- ---------------------------------------------------------------------------
alter table public.activity_log drop constraint if exists activity_log_action_check;

alter table public.activity_log
  add constraint activity_log_action_check
  check (action in (
    'create', 'update', 'delete', 'status_change', 'login', 'logout', 'export',
    'invite', 'impersonate', 'password_reset', 'role_change', 'activate', 'suspend',
    -- Phase 6
    'publish', 'unpublish', 'share_link_created', 'share_link_revoked', 'view', 'download'
  ));

do $$
declare
  v_org  uuid;
  v_actor uuid;
  v_action text;
begin
  select id into v_org from public.organizations limit 1;
  if v_org is null then
    raise notice '0028: no organisation, skipping audit-action self-test';
    return;
  end if;
  select id into v_actor from public.profiles where organization_id = v_org limit 1;

  foreach v_action in array array[
    'publish', 'unpublish', 'share_link_created', 'share_link_revoked', 'view', 'download'
  ]
  loop
    begin
      insert into public.activity_log (organization_id, actor_id, entity_type, action)
      values (v_org, v_actor, 'selftest_0028', v_action);
    exception when others then
      raise exception '0028: activity_log rejected action % — the AuditAction union would drift', v_action;
    end;
  end loop;

  delete from public.activity_log where entity_type = 'selftest_0028';
end
$$;
