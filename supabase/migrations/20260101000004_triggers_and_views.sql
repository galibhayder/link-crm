-- ============================================================================
-- 0004 — Triggers, derived state and reporting views
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Public RPC wrapper for document numbering.
--
-- The real implementation lives in app_private, which PostgREST cannot reach.
-- This wrapper is callable by service_role only (the API), and it refuses to
-- operate outside the caller's stated organization so an id cannot be spoofed
-- into another tenant's counter.
-- ---------------------------------------------------------------------------
create or replace function public.next_document_number_rpc(p_org uuid, p_type text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_org is null then
    raise exception 'organization is required' using errcode = '22004';
  end if;

  return app_private.next_document_number(p_org, p_type);
end;
$$;

revoke all on function public.next_document_number_rpc(uuid, text) from public, anon, authenticated;
grant execute on function public.next_document_number_rpc(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Resolve polymorphic scope.
--
-- attachments and custom_field_values key on (entity_type, entity_id), which a
-- policy cannot safely interpret. This trigger stamps the resolved client_id /
-- campaign_id so their policies are a plain `can_see_client(client_id)` check.
-- Without it, a client_user could read another client's attachments by guessing
-- an entity_id.
-- ---------------------------------------------------------------------------
create or replace function app_private.resolve_attachment_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.client_id := null;
  new.campaign_id := null;

  case new.entity_type
    when 'client' then
      new.client_id := new.entity_id;
    when 'campaign' then
      new.campaign_id := new.entity_id;
      select c.client_id into new.client_id from public.campaigns c where c.id = new.entity_id;
    when 'placement' then
      select c.id, c.client_id into new.campaign_id, new.client_id
      from public.placements pl
      join public.campaigns c on c.id = pl.campaign_id
      where pl.id = new.entity_id;
    when 'prospect' then
      select c.id, c.client_id into new.campaign_id, new.client_id
      from public.prospects pr
      join public.campaigns c on c.id = pr.campaign_id
      where pr.id = new.entity_id;
    when 'invoice' then
      select i.client_id into new.client_id from public.invoices i where i.id = new.entity_id;
    else
      null;
  end case;

  return new;
end;
$$;

create trigger attachments_resolve_scope
  before insert or update of entity_type, entity_id on public.attachments
  for each row execute function app_private.resolve_attachment_scope();

create or replace function app_private.resolve_custom_value_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity_type text;
begin
  new.client_id := null;
  new.campaign_id := null;

  select d.entity_type into v_entity_type
  from public.custom_field_definitions d
  where d.id = new.definition_id;

  case v_entity_type
    when 'client' then
      new.client_id := new.entity_id;
    when 'campaign' then
      new.campaign_id := new.entity_id;
      select c.client_id into new.client_id from public.campaigns c where c.id = new.entity_id;
    when 'prospect' then
      select c.id, c.client_id into new.campaign_id, new.client_id
      from public.prospects pr join public.campaigns c on c.id = pr.campaign_id
      where pr.id = new.entity_id;
    when 'placement' then
      select c.id, c.client_id into new.campaign_id, new.client_id
      from public.placements pl join public.campaigns c on c.id = pl.campaign_id
      where pl.id = new.entity_id;
    else
      null;
  end case;

  return new;
end;
$$;

create trigger custom_field_values_resolve_scope
  before insert or update of entity_id, definition_id on public.custom_field_values
  for each row execute function app_private.resolve_custom_value_scope();

-- ---------------------------------------------------------------------------
-- Invoice status derived from payments.
--
-- `payments` is the source of truth, so a partial payment or a refund is
-- representable. The status column is a projection, recomputed on every
-- payment change — never typed in by hand.
-- ---------------------------------------------------------------------------
create or replace function app_private.recompute_invoice_status(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total numeric(12,2);
  v_paid  numeric(12,2);
  v_status text;
begin
  select i.total, i.status into v_total, v_status
  from public.invoices i where i.id = p_invoice_id;

  if v_status = 'void' then
    return; -- a voided invoice never reopens
  end if;

  select coalesce(sum(p.amount), 0) into v_paid
  from public.payments p where p.invoice_id = p_invoice_id;

  update public.invoices
  set status = case
      when v_paid <= 0 then case when v_status = 'draft' then 'draft' else 'sent' end
      when v_paid < v_total then 'partially_paid'
      else 'paid'
    end,
    updated_at = now()
  where id = p_invoice_id;
end;
$$;

create or replace function app_private.on_payment_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.recompute_invoice_status(coalesce(new.invoice_id, old.invoice_id));
  return coalesce(new, old);
end;
$$;

create trigger payments_recompute_invoice
  after insert or update or delete on public.payments
  for each row execute function app_private.on_payment_change();

-- ---------------------------------------------------------------------------
-- Invoice totals maintained from line items.
-- ---------------------------------------------------------------------------
create or replace function app_private.recompute_invoice_totals(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subtotal numeric(12,2);
  v_tax_rate numeric(5,2);
begin
  select coalesce(sum(li.amount), 0) into v_subtotal
  from public.invoice_line_items li where li.invoice_id = p_invoice_id;

  select i.tax_rate into v_tax_rate from public.invoices i where i.id = p_invoice_id;

  update public.invoices
  set subtotal   = v_subtotal,
      tax_amount = round(v_subtotal * coalesce(v_tax_rate, 0) / 100, 2),
      total      = v_subtotal + round(v_subtotal * coalesce(v_tax_rate, 0) / 100, 2),
      updated_at = now()
  where id = p_invoice_id;
end;
$$;

create or replace function app_private.on_line_item_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.recompute_invoice_totals(coalesce(new.invoice_id, old.invoice_id));
  return coalesce(new, old);
end;
$$;

create trigger invoice_lines_recompute_totals
  after insert or update or delete on public.invoice_line_items
  for each row execute function app_private.on_line_item_change();

-- ---------------------------------------------------------------------------
-- Guard: the last active owner cannot be demoted, deactivated or deleted.
-- A single-owner org that loses its owner has no way back in through the app.
-- ---------------------------------------------------------------------------
create or replace function app_private.guard_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_other_owners integer;
begin
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;

  -- Only intervene when ownership is actually being given up.
  if tg_op = 'UPDATE'
     and new.role = 'owner'
     and new.is_active
     and new.organization_id = old.organization_id then
    return new;
  end if;

  select count(*) into v_other_owners
  from public.profiles p
  where p.organization_id = old.organization_id
    and p.role = 'owner'
    and p.is_active
    and p.id <> old.id;

  if v_other_owners = 0 then
    raise exception 'Cannot remove the last active owner of an organization'
      using errcode = '23514';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger profiles_guard_last_owner
  before update or delete on public.profiles
  for each row execute function app_private.guard_last_owner();

-- ---------------------------------------------------------------------------
-- Guard: an assigned profile must belong to the same org as the row.
-- Applies to every table with a profile reference, preventing a cross-org
-- identifier from being written and then resolved by a policy.
-- ---------------------------------------------------------------------------
create or replace function app_private.assert_same_org_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref uuid;
begin
  v_ref := nullif(to_jsonb(new) ->> 'assigned_to', '')::uuid;
  if v_ref is null then
    v_ref := nullif(to_jsonb(new) ->> 'manager_id', '')::uuid;
  end if;
  if v_ref is null then
    return new;
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = v_ref and p.organization_id = new.organization_id
  ) then
    raise exception 'Referenced profile does not belong to this organization'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger clients_same_org_manager
  before insert or update of manager_id on public.clients
  for each row execute function app_private.assert_same_org_profile();

create trigger prospects_same_org_assignee
  before insert or update of assigned_to on public.prospects
  for each row execute function app_private.assert_same_org_profile();

create trigger briefs_same_org_assignee
  before insert or update of assigned_to on public.content_briefs
  for each row execute function app_private.assert_same_org_profile();

-- ============================================================================
-- REPORTING VIEWS
--
-- Every view below joins a tier-1 table to a tier-2 table, so it MUST NOT be
-- granted to any end-user role — that would reopen the exact leak the tier
-- split exists to prevent. They are granted to service_role only; the API
-- computes reports through them after authorize('reports:margins').
--
-- They are created with security_invoker = false (the default, owner-run) so
-- service_role reads them without needing direct grants on the base tables.
-- ============================================================================

-- Tier 3: per-placement margin.
create or replace view public.v_placement_margin as
select
  p.organization_id,
  p.id                as placement_id,
  p.campaign_id,
  c.client_id,
  p.publisher_id,
  p.status,
  p.live_date,
  pr.client_rate,
  pc.supplier_cost,
  (pr.client_rate - coalesce(pc.supplier_cost, 0))                       as margin,
  case when pr.client_rate > 0
       then round((pr.client_rate - coalesce(pc.supplier_cost, 0)) / pr.client_rate, 4)
       else 0 end                                                        as margin_pct
from public.placements p
join public.campaigns c on c.id = p.campaign_id
left join public.placement_pricing pr on pr.placement_id = p.id
left join public.placement_costs pc on pc.placement_id = p.id
where p.deleted_at is null;

-- Tier 3: client profitability, per period.
-- Aggregated with CTEs rather than correlated subqueries: a subquery inside an
-- aggregate select cannot reference the outer grouping expression, and the
-- earlier version failed on exactly that.
create or replace view public.v_client_profitability as
with billed as (
  select
    i.organization_id,
    i.client_id,
    date_trunc('month', i.period_start)::date as period_month,
    count(distinct i.id)                      as invoice_count,
    coalesce(sum(i.total), 0)                 as billed
  from public.invoices i
  where i.status <> 'void'
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
  where i.status <> 'void'
  group by i.organization_id, i.client_id, date_trunc('month', i.period_start)::date
),
margins as (
  select
    m.organization_id,
    m.client_id,
    date_trunc('month', m.live_date)::date as period_month,
    coalesce(sum(m.margin), 0)            as margin
  from public.v_placement_margin m
  where m.live_date is not null
  group by m.organization_id, m.client_id, date_trunc('month', m.live_date)::date
)
select
  b.organization_id,
  b.client_id,
  b.period_month,
  b.invoice_count,
  b.billed,
  coalesce(c.collected, 0) as collected,
  coalesce(mg.margin, 0)   as margin
from billed b
left join collected c
  on c.organization_id = b.organization_id
 and c.client_id = b.client_id
 and c.period_month = b.period_month
left join margins mg
  on mg.organization_id = b.organization_id
 and mg.client_id = b.client_id
 and mg.period_month = b.period_month;

-- Campaign progress against its monthly targets.
create or replace view public.v_campaign_progress as
select
  c.organization_id,
  c.id                                                          as campaign_id,
  c.client_id,
  c.name,
  c.monthly_link_target,
  date_trunc('month', current_date)::date                        as current_month,
  count(p.id) filter (
    where p.status = 'live'
      and date_trunc('month', p.live_date)::date = date_trunc('month', current_date)::date
  )                                                             as delivered_this_month,
  coalesce(t.target_links, c.monthly_link_target, 0)             as target_this_month
from public.campaigns c
left join public.placements p on p.campaign_id = c.id and p.deleted_at is null
left join public.campaign_monthly_targets t
  on t.campaign_id = c.id
 and t.period_month = date_trunc('month', current_date)::date
where c.deleted_at is null
group by c.organization_id, c.id, c.client_id, c.name, c.monthly_link_target, t.target_links;

-- Outreach funnel.
create or replace view public.v_outreach_funnel as
select
  pr.organization_id,
  pr.campaign_id,
  pr.stage,
  count(*)                                                      as prospect_count,
  count(*) filter (where pr.reply_received)                      as replied_count,
  count(*) filter (where pr.next_follow_up_at < now())           as overdue_follow_ups
from public.prospects pr
where pr.deleted_at is null
group by pr.organization_id, pr.campaign_id, pr.stage;

-- Anchor text distribution — the over-optimization signal.
create or replace view public.v_anchor_distribution as
select
  p.organization_id,
  p.campaign_id,
  c.client_id,
  coalesce(p.anchor_type, 'unclassified')                        as anchor_type,
  count(*)                                                      as link_count,
  round(
    count(*)::numeric / nullif(sum(count(*)) over (partition by p.campaign_id), 0),
    4
  )                                                             as share
from public.placements p
join public.campaigns c on c.id = p.campaign_id
where p.deleted_at is null and p.status = 'live'
group by p.organization_id, p.campaign_id, c.client_id, p.anchor_type;

-- Accounts receivable aging.
create or replace view public.v_ar_aging as
select
  i.organization_id,
  i.client_id,
  i.id                                                          as invoice_id,
  i.invoice_number,
  i.total,
  i.due_date,
  i.status,
  coalesce(sum(pa.amount), 0)                                   as paid_amount,
  i.total - coalesce(sum(pa.amount), 0)                          as balance,
  greatest(0, current_date - i.due_date)                         as days_overdue
from public.invoices i
left join public.payments pa on pa.invoice_id = i.id
where i.status not in ('paid', 'void')
group by i.organization_id, i.client_id, i.id, i.invoice_number, i.total, i.due_date, i.status;

-- Lock the financial views away from every end-user role. service_role bypasses
-- grants entirely, and the API is the only thing that reaches these.
revoke all on public.v_placement_margin        from authenticated, anon;
revoke all on public.v_client_profitability    from authenticated, anon;
revoke all on public.v_ar_aging                from authenticated, anon;
revoke all on public.v_campaign_progress       from authenticated, anon;
revoke all on public.v_outreach_funnel         from authenticated, anon;
revoke all on public.v_anchor_distribution     from authenticated, anon;

grant select on public.v_placement_margin     to service_role;
grant select on public.v_client_profitability to service_role;
grant select on public.v_ar_aging             to service_role;
grant select on public.v_campaign_progress    to service_role;
grant select on public.v_outreach_funnel      to service_role;
grant select on public.v_anchor_distribution  to service_role;
