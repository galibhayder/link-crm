-- ===========================================================================
-- 0030 — PROFITABILITY VIEWS
--
-- Two views, both service_role only. The reports router is the door and is gated
-- on `reports:margins` (owner). A view granted to `authenticated` would let any
-- role with table access read margin directly, so these are deliberately NOT
-- granted to any end-user role.
--
-- ARITHMETIC NOTE.
--
-- Every figure is `numeric`, never float. `client_rate` and `supplier_cost` are
-- numeric(12,2) already; summing them in numeric is exact. Rounding happens ONCE,
-- at the point of presentation (margin_pct), not inside the sum. Summing rounded
-- values is how a report ends up a cent off from the invoices it summarises.
--
-- MULTI-CURRENCY NOTE.
--
-- There are no FX rates in this system, so a cross-currency total would be a
-- fabricated number. Views group by currency and never sum across codes. A
-- consumer that wants one figure must pick a currency.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. CAMPAIGN PROFITABILITY
--
-- Revenue  = sum of client rates on priced placements
-- Cost     = sum of supplier costs on the same placements
-- Payouts  = writer fees booked against the campaign
-- Expenses = other campaign costs
--
-- Placements without a price row contribute nothing to revenue but ARE counted,
-- so `unpriced_placements` exposes the gap rather than hiding it: a campaign that
-- looks 95% profitable because half its placements are unpriced is a reporting
-- bug, not a win.
-- ---------------------------------------------------------------------------
create or replace view public.v_campaign_profitability as
with rev as (
  select
    pp.organization_id,
    p.campaign_id,
    pp.currency,
    sum(pp.client_rate)                       as revenue,
    count(*)                                  as priced_placements
  from public.placement_pricing pp
  join public.placements p on p.id = pp.placement_id
  where p.deleted_at is null
  group by pp.organization_id, p.campaign_id, pp.currency
),
cost as (
  select
    pc.organization_id,
    p.campaign_id,
    pc.currency,
    sum(pc.supplier_cost)                     as publisher_cost
  from public.placement_costs pc
  join public.placements p on p.id = pc.placement_id
  where p.deleted_at is null
  group by pc.organization_id, p.campaign_id, pc.currency
),
payout as (
  select
    w.organization_id, w.campaign_id, w.currency, sum(w.amount) as writer_payouts
  from public.writer_payouts w
  where w.campaign_id is not null
  group by w.organization_id, w.campaign_id, w.currency
),
expense as (
  select
    e.organization_id, e.campaign_id, e.currency, sum(e.amount) as other_expenses
  from public.campaign_expenses e
  group by e.organization_id, e.campaign_id, e.currency
),
unpriced as (
  select
    p.organization_id, p.campaign_id, count(*) as unpriced_placements
  from public.placements p
  left join public.placement_pricing pp on pp.placement_id = p.id
  where p.deleted_at is null and pp.id is null
  group by p.organization_id, p.campaign_id
),
-- The currency set for a campaign is the union of every currency any component
-- uses. Each component is then summed ONLY on the matching code, so no cross-
-- currency addition ever occurs.
codes as (
  select organization_id, campaign_id, currency from rev
  union
  select organization_id, campaign_id, currency from cost
  union
  select organization_id, campaign_id, currency from payout
  union
  select organization_id, campaign_id, currency from expense
)
select
  k.organization_id,
  k.campaign_id,
  c.name                                                              as campaign_name,
  cl.id                                                               as client_id,
  cl.name                                                             as client_name,
  k.currency,
  coalesce(r.revenue, 0)::numeric(12,2)                               as revenue,
  coalesce(co.publisher_cost, 0)::numeric(12,2)                       as publisher_cost,
  coalesce(wp.writer_payouts, 0)::numeric(12,2)                       as writer_payouts,
  coalesce(ex.other_expenses, 0)::numeric(12,2)                       as other_expenses,
  (coalesce(r.revenue, 0)
    - coalesce(co.publisher_cost, 0)
    - coalesce(wp.writer_payouts, 0)
    - coalesce(ex.other_expenses, 0))::numeric(12,2)                  as gross_profit,
  -- Round once, here. NULL when there is no revenue: a margin on zero revenue is
  -- undefined, not 0%, and printing 0% would read as "unprofitable".
  case
    when coalesce(r.revenue, 0) > 0 then
      round(
        ((coalesce(r.revenue, 0)
          - coalesce(co.publisher_cost, 0)
          - coalesce(wp.writer_payouts, 0)
          - coalesce(ex.other_expenses, 0)) / r.revenue) * 100
      , 2)
    else null
  end                                                                 as margin_pct,
  coalesce(r.priced_placements, 0)::int                               as priced_placements,
  coalesce(u.unpriced_placements, 0)::int                             as unpriced_placements,
  -- Explicit flag so a caller cannot accidentally average across currencies.
  (select count(*) from codes k2
    where k2.organization_id = k.organization_id
      and k2.campaign_id = k.campaign_id) > 1                          as multi_currency
from codes k
join public.campaigns c on c.id = k.campaign_id
join public.clients cl on cl.id = c.client_id
left join rev     r  on r.organization_id = k.organization_id and r.campaign_id  = k.campaign_id and r.currency  = k.currency
left join cost    co on co.organization_id = k.organization_id and co.campaign_id = k.campaign_id and co.currency = k.currency
left join payout  wp on wp.organization_id = k.organization_id and wp.campaign_id = k.campaign_id and wp.currency = k.currency
left join expense ex on ex.organization_id = k.organization_id and ex.campaign_id = k.campaign_id and ex.currency = k.currency
left join unpriced u on u.organization_id = k.organization_id and u.campaign_id = k.campaign_id;

comment on view public.v_campaign_profitability is
  'Per-campaign revenue, cost, payouts, expenses and margin, grouped by currency. Never sums across currencies.';

revoke all on public.v_campaign_profitability from public, anon, authenticated;
grant select on public.v_campaign_profitability to service_role;

-- ---------------------------------------------------------------------------
-- 2. FINANCIAL SUMMARY
--
-- Organisation-wide, per currency. Three distinct questions, kept separate
-- because conflating them is how a "profitable" business runs out of cash:
--
--   billed / collected / outstanding   accounts RECEIVABLE (clients owe us)
--   costs_outstanding                  accounts PAYABLE  (we owe suppliers)
--   gross_profit                       accrued margin on placements
-- ---------------------------------------------------------------------------
create or replace view public.v_financial_summary as
with money_in as (
  select
    i.organization_id,
    i.currency::text as currency,
    sum(case when i.status <> 'cancelled' then i.total else 0 end)                        as billed,
    coalesce(sum(p.paid), 0)                                                              as collected
  from public.invoices i
  left join (select invoice_id, sum(amount) as paid from public.payments group by invoice_id) p
    on p.invoice_id = i.id
  group by i.organization_id, i.currency
),
money_out as (
  select
    sb.organization_id,
    sb.currency::text as currency,
    sum(case when sb.status <> 'paid' then sb.amount else 0 end)                          as costs_outstanding
  from public.supplier_bills sb
  group by sb.organization_id, sb.currency
),
payouts_open as (
  select
    w.organization_id,
    w.currency::text as currency,
    sum(case when w.status <> 'paid' then w.amount else 0 end)                            as payouts_outstanding
  from public.writer_payouts w
  group by w.organization_id, w.currency
),
margin as (
  select
    organization_id, currency,
    sum(gross_profit)                            as gross_profit,
    sum(revenue)                                 as revenue,
    sum(publisher_cost)                          as publisher_cost,
    sum(writer_payouts)                          as writer_payouts,
    sum(other_expenses)                          as other_expenses
  from public.v_campaign_profitability
  group by organization_id, currency
),
codes as (
  select organization_id, currency from money_in
  union select organization_id, currency from money_out
  union select organization_id, currency from payouts_open
  union select organization_id, currency from margin
)
select
  k.organization_id,
  k.currency,
  coalesce(mi.billed, 0)::numeric(12,2)                     as billed,
  coalesce(mi.collected, 0)::numeric(12,2)                  as collected,
  (coalesce(mi.billed, 0) - coalesce(mi.collected, 0))::numeric(12,2) as outstanding_ar,
  coalesce(mo.costs_outstanding, 0)::numeric(12,2)          as publisher_costs_outstanding,
  coalesce(po.payouts_outstanding, 0)::numeric(12,2)        as writer_payouts_outstanding,
  coalesce(mg.revenue, 0)::numeric(12,2)                    as revenue,
  coalesce(mg.publisher_cost, 0)::numeric(12,2)             as publisher_cost,
  coalesce(mg.writer_payouts, 0)::numeric(12,2)             as writer_payouts,
  coalesce(mg.other_expenses, 0)::numeric(12,2)             as other_expenses,
  coalesce(mg.gross_profit, 0)::numeric(12,2)               as gross_profit,
  case
    when coalesce(mg.revenue, 0) > 0
      then round((coalesce(mg.gross_profit, 0) / mg.revenue) * 100, 2)
    else null
  end                                                       as margin_pct
from codes k
left join money_in    mi on mi.organization_id = k.organization_id and mi.currency = k.currency
left join money_out   mo on mo.organization_id = k.organization_id and mo.currency = k.currency
left join payouts_open po on po.organization_id = k.organization_id and po.currency = k.currency
left join margin      mg on mg.organization_id = k.organization_id and mg.currency = k.currency;

comment on view public.v_financial_summary is
  'Org-level receivables, payables, margin and profit, one row per currency. Service_role only.';

revoke all on public.v_financial_summary from public, anon, authenticated;
grant select on public.v_financial_summary to service_role;

-- ---------------------------------------------------------------------------
-- 3. Ledger for the buyer-facing side of "financial transactions".
--
-- A single chronological list of every money movement, normalised from the four
-- sources that already record them. This is what the brief's
-- `financial_transactions` was asking for, without a fifth table that would
-- duplicate the other four and drift.
-- ---------------------------------------------------------------------------
create or replace view public.v_financial_ledger as
  select
    i.organization_id,
    'invoice'::text                              as entry_type,
    i.id                                         as source_id,
    i.invoice_number                             as reference,
    i.client_id                                  as client_id,
    null::uuid                                   as campaign_id,
    'debit'::text                                as direction,
    i.total                                      as amount,
    i.currency::text                             as currency,
    coalesce(i.issued_at, i.created_at)          as occurred_at
  from public.invoices i
  where i.status <> 'cancelled'

  union all

  select
    p.organization_id, 'payment'::text, p.id, p.reference,
    i.client_id, null::uuid, 'credit'::text,
    p.amount, p.currency::text, p.received_at
  from public.payments p
  join public.invoices i on i.id = p.invoice_id

  union all

  select
    pc.organization_id, 'publisher_cost'::text, pc.id,
    s.name, null::uuid, pl.campaign_id, 'debit'::text,
    pc.supplier_cost, pc.currency::text, coalesce(pc.agreed_at, pc.created_at)
  from public.placement_costs pc
  join public.placements pl on pl.id = pc.placement_id
  left join public.suppliers s on s.id = pc.supplier_id

  union all

  select
    w.organization_id, 'writer_payout'::text, w.id, null,
    null::uuid, w.campaign_id, 'debit'::text,
    w.amount, w.currency::text, w.created_at
  from public.writer_payouts w

  union all

  select
    e.organization_id, 'expense'::text, e.id, e.vendor,
    null::uuid, e.campaign_id, 'debit'::text,
    e.amount, e.currency::text, e.incurred_on::timestamptz
  from public.campaign_expenses e;

comment on view public.v_financial_ledger is
  'Chronological money movements normalised from invoices, payments, costs, payouts and expenses. Replaces the proposed financial_transactions table.';

revoke all on public.v_financial_ledger from public, anon, authenticated;
grant select on public.v_financial_ledger to service_role;
