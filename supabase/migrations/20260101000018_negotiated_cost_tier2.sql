-- ============================================================================
-- 0018 — Stop `negotiated_cost` from re-opening the financial leak
--
-- THE PROBLEM
--
-- Phase 3 split money into three physically separate tables precisely because
-- RLS filters ROWS, not COLUMNS: `placement_pricing` (tier 1, client price),
-- `placement_costs` (tier 2, wholesale cost — account_manager has NO policy at
-- all) and margin views (tier 3, service_role only).
--
-- Phase 4 then added `negotiated_cost` as a COLUMN on `placements`, which every
-- internal role can read. Verified live: an account_manager — the one role the
-- brief says must never see wholesale cost — could read 850 from the list, the
-- detail view and the board, while being correctly refused by /costs. The value
-- was also exposed to content_writer, who additionally could WRITE it. That is
-- exactly the failure mode the plan called its number one design error.
--
-- A column on a shared table cannot be protected by policy, and column GRANTs
-- cannot distinguish roles because every signed-in user shares the
-- `authenticated` Postgres role. So the column is removed from the shared table
-- and the data lives where it belongs: in `placement_costs`.
--
-- WHAT REPLACES IT
--
-- * `placement_costs` gains the negotiation state that `negotiated_cost` was
--   carrying: an agreed amount, when it was agreed, and by whom.
-- * `v_placement_negotiation` exposes the agreed figure ONLY to the roles that
--   may see tier 2, so the API has one read path that is safe by construction.
-- * The API's `negotiatedCost` input is accepted for compatibility but writes to
--   `placement_costs`, behind `costs:write`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Remove the leaking column.
--
-- Any value already recorded there is copied into placement_costs first, so no
-- data is lost. `on conflict do nothing` leaves an authoritative tier-2 row
-- alone: a figure recorded in the proper place must not be overwritten by a
-- duplicate from the shared table.
-- ---------------------------------------------------------------------------
insert into public.placement_costs (
  organization_id, placement_id, supplier_cost, currency, supplier_id
)
select
  p.organization_id,
  p.id,
  p.negotiated_cost,
  coalesce(p.negotiated_currency, 'USD'),
  p.supplier_id
from public.placements p
where p.negotiated_cost is not null
on conflict (placement_id) do nothing;

alter table public.placements drop column if exists negotiated_cost;

-- The currency column went with it: it existed only to qualify that figure.
alter table public.placements drop column if exists negotiated_currency;

-- ---------------------------------------------------------------------------
-- 2. Record the negotiation itself in tier 2, where it belongs.
-- ---------------------------------------------------------------------------
alter table public.placement_costs
  add column if not exists agreed_at timestamptz,
  add column if not exists agreed_by uuid references public.profiles(id) on delete set null;

comment on column public.placement_costs.supplier_cost is
  'The agreed wholesale cost. Tier 2: never readable by account_manager or content_writer.';

-- ---------------------------------------------------------------------------
-- 3. One read path for the agreed figure.
--
-- security_invoker so the caller's own policies apply — this view cannot widen
-- access, it only renames a column. A role with no policy on placement_costs
-- sees zero rows here, which is the behaviour we want and can test.
-- ---------------------------------------------------------------------------
create or replace view public.v_placement_negotiation
with (security_invoker = true) as
select
  c.placement_id,
  c.supplier_cost,
  c.currency,
  c.supplier_id,
  c.agreed_at,
  c.agreed_by
from public.placement_costs c;

grant select on public.v_placement_negotiation to authenticated;

comment on view public.v_placement_negotiation is
  'The agreed wholesale cost, readable only by roles holding a placement_costs policy (owner, prospector, outreach_specialist, and the supplier itself).';
