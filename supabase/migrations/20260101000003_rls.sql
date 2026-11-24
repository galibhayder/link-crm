-- ============================================================================
-- 0003 — Row Level Security
--
-- Rules applied uniformly:
--   * ENABLE + FORCE so even the table owner cannot bypass a policy.
--   * Every policy names `TO authenticated`. Nothing is reachable with the anon key.
--   * Writes specify BOTH `using` and `with check`. A policy with only `using`
--     lets a user move a row into another tenant.
--   * Absence of a policy is the denial mechanism. There is no "deny" policy
--     and no default-allow anywhere in this file.
-- ============================================================================

-- Strip anything the anon role could reach, and stop new tables shipping open.
revoke all on schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public grant all on tables to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Additional scope helpers.
--
-- Every cross-table question a policy needs to ask lives in a SECURITY DEFINER
-- function. This matters for two reasons:
--   1. A subquery written inline in a policy runs AS THE CALLER, so it is
--      itself filtered by the target table's RLS — which silently changes the
--      answer and can recurse.
--   2. These are the only places that need to know the join graph, so a policy
--      below stays a single readable predicate.
-- ---------------------------------------------------------------------------

-- Does the current user hold a content brief for this campaign?
create or replace function app_private.can_write_for_campaign(p_campaign_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.current_app_role() = 'content_writer'
    and exists (
      select 1
      from public.content_briefs cb
      join public.placements pl on pl.id = cb.placement_id
      where pl.campaign_id = p_campaign_id
        and cb.assigned_to = auth.uid()
    );
$$;

-- Is this client visible to the caller, derived from a placement?
create or replace function app_private.can_see_placement(p_placement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.placements pl
    join public.campaigns c on c.id = pl.campaign_id
    where pl.id = p_placement_id
      and app_private.can_see_client(c.client_id)
  );
$$;

-- Is this publisher one the caller may see? Covers the client-portal case
-- (publishers appearing in the client's own campaign pipeline) without the
-- policy having to query prospects inline.
create or replace function app_private.can_see_publisher(p_publisher_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when app_private.is_internal() then true
    when app_private.current_app_role() = 'publisher_user' then exists (
      select 1 from public.publishers p
      where p.id = p_publisher_id
        and p.supplier_id = app_private.current_supplier_id()
    )
    when app_private.current_app_role() = 'client_user' then exists (
      select 1
      from public.prospects pr
      join public.campaigns c on c.id = pr.campaign_id
      where pr.publisher_id = p_publisher_id
        and app_private.can_see_client(c.client_id)
    )
    else false
  end;
$$;

-- Does the caller own this supplier (publisher_user case)?
create or replace function app_private.owns_supplier(p_supplier_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_supplier_id is not null
     and app_private.current_app_role() = 'publisher_user'
     and p_supplier_id = app_private.current_supplier_id();
$$;

-- May the caller see this prospect? Publisher scope is by supplier, client
-- scope is by client ownership of the parent campaign.
create or replace function app_private.can_see_prospect(p_prospect_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.prospects pr
    join public.campaigns c on c.id = pr.campaign_id
    where pr.id = p_prospect_id
      and (
        app_private.is_internal()
        or app_private.owns_supplier(pr.supplier_id)
        or (app_private.current_app_role() = 'client_user' and app_private.can_see_client(c.client_id))
      )
  );
$$;

-- Negotiation threads are a narrower thing than "the prospect is visible".
-- A client may see that a prospect exists without reading our outreach notes,
-- which is exactly what the brief requires. So client_user is deliberately
-- excluded here even though it is included in can_see_prospect.
create or replace function app_private.can_see_touchpoints_for(p_prospect_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.prospects pr
    where pr.id = p_prospect_id
      and (
        app_private.current_app_role() in
          ('owner', 'account_manager', 'prospector', 'outreach_specialist')
        or app_private.owns_supplier(pr.supplier_id)
      )
  );
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'organizations','suppliers','profiles','clients','client_billing_profiles',
    'client_contacts','user_client_access','campaigns','campaign_monthly_targets',
    'campaign_assignments','publishers','publisher_offers','pipeline_stages',
    'prospects','outreach_touchpoints','email_templates','email_outbox',
    'placements','link_checks','placement_pricing','placement_costs',
    'client_contracts','supplier_bills','invoices','invoice_line_items','payments',
    'content_briefs','document_sequences','activity_log','attachments',
    'custom_field_definitions','custom_field_values','saved_views','notifications',
    'export_jobs','job_runs'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- ============================================================================
-- ORGANIZATIONS — visible to its members; only the owner may modify.
-- ============================================================================
create policy organizations_select on public.organizations
  for select to authenticated
  using (id = app_private.current_org_id());

create policy organizations_update on public.organizations
  for update to authenticated
  using (id = app_private.current_org_id() and app_private.current_app_role() = 'owner')
  with check (id = app_private.current_org_id());

-- ============================================================================
-- PROFILES
--   Internal staff may read colleagues. Everyone may read their own row.
--   Only the owner writes, except a user updating their own name/phone.
-- ============================================================================
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (app_private.is_internal() or id = auth.uid())
  );

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and organization_id = app_private.current_org_id());

create policy profiles_manage on public.profiles
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner')
  with check (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

-- ============================================================================
-- CLIENTS
--   Internal staff: full read, managers write.
--   client_user: only clients granted via user_client_access.
--   publisher_user: nothing at all (no policy).
-- ============================================================================
create policy clients_select on public.clients
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and deleted_at is null
    and (
      app_private.is_internal()
      or (app_private.current_app_role() = 'client_user' and app_private.can_see_client(id))
    )
  );

create policy clients_insert on public.clients
  for insert to authenticated
  with check (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager'])
  );

create policy clients_update on public.clients
  for update to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager'])
  )
  with check (organization_id = app_private.current_org_id());

create policy clients_delete on public.clients
  for delete to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

-- Billing profile: tier 1. Not readable by prospectors, outreach or writers.
create policy client_billing_select on public.client_billing_profiles
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'account_manager'])
      or (app_private.current_app_role() = 'client_user' and app_private.can_see_client(client_id))
    )
  );

create policy client_billing_write on public.client_billing_profiles
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']))
  with check (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']));

create policy client_contacts_select on public.client_contacts
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (app_private.is_internal() or app_private.can_see_client(client_id))
  );

create policy client_contacts_write on public.client_contacts
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']))
  with check (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']));

-- Portal scoping table itself. A client_user may see their own grants; only the
-- owner and account manager may create or revoke them.
create policy uca_select on public.user_client_access
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (app_private.has_any_role(array['owner', 'account_manager']) or user_id = auth.uid())
  );

create policy uca_write on public.user_client_access
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']))
  with check (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']));

-- ============================================================================
-- CAMPAIGNS
--   Internal read; account_manager writes. client_user reads own client's.
--   Writers/prospectors are restricted to assigned campaigns.
-- ============================================================================
create policy campaigns_select on public.campaigns
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and deleted_at is null
    and (
      app_private.has_any_role(array['owner', 'account_manager'])
      or (
        app_private.has_any_role(array['prospector', 'outreach_specialist', 'content_writer'])
        and app_private.is_assigned_to_campaign(id)
      )
      or (app_private.current_app_role() = 'client_user' and app_private.can_see_client(client_id))
    )
  );

create policy campaigns_write on public.campaigns
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']))
  with check (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']));

create policy campaign_targets_select on public.campaign_monthly_targets
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (app_private.is_internal() or app_private.can_see_client(app_private.client_of_campaign(campaign_id)))
  );

create policy campaign_targets_write on public.campaign_monthly_targets
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']))
  with check (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']));

-- Assignments: a user may see their own assignment; managers see all.
create policy assignments_select on public.campaign_assignments
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'account_manager'])
      or profile_id = auth.uid()
      or app_private.is_assigned_to_campaign(campaign_id)
    )
  );

create policy assignments_write on public.campaign_assignments
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']))
  with check (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']));

-- ============================================================================
-- SUPPLIERS & PUBLISHERS
--   publisher_user sees ONLY the supplier it belongs to, and only its own sites.
-- ============================================================================
create policy suppliers_select on public.suppliers
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.is_internal()
      or (app_private.current_app_role() = 'publisher_user' and id = app_private.current_supplier_id())
    )
  );

create policy suppliers_insert on public.suppliers
  for insert to authenticated
  with check (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']));

create policy suppliers_update on public.suppliers
  for update to authenticated
  using (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']))
  with check (organization_id = app_private.current_org_id());

create policy suppliers_delete on public.suppliers
  for delete to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

create policy publishers_select on public.publishers
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and deleted_at is null
    and app_private.can_see_publisher(id)
  );

create policy publishers_insert on public.publishers
  for insert to authenticated
  with check (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'account_manager', 'prospector'])
      or app_private.owns_supplier(supplier_id)
    )
  );

create policy publishers_update on public.publishers
  for update to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'account_manager', 'prospector'])
      or app_private.owns_supplier(supplier_id)
    )
  )
  with check (organization_id = app_private.current_org_id());

create policy publishers_delete on public.publishers
  for delete to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

create policy offers_select on public.publisher_offers
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.is_internal()
      or exists (
        select 1 from public.publishers p
        where p.id = publisher_offers.publisher_id
          and app_private.owns_supplier(p.supplier_id)
      )
    )
  );

create policy offers_write on public.publisher_offers
  for all to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'account_manager', 'prospector', 'outreach_specialist'])
      or app_private.current_app_role() = 'publisher_user'
    )
  )
  with check (organization_id = app_private.current_org_id());

create policy stages_select on public.pipeline_stages
  for select to authenticated
  using (organization_id = app_private.current_org_id() and app_private.is_internal());

create policy stages_write on public.pipeline_stages
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner')
  with check (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

-- ============================================================================
-- PROSPECTS
-- ============================================================================
create policy prospects_select on public.prospects
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and deleted_at is null
    and (
      app_private.has_any_role(array['owner', 'account_manager'])
      or (
        app_private.has_any_role(array['prospector', 'outreach_specialist'])
        and app_private.is_assigned_to_campaign(campaign_id)
      )
      or (app_private.current_app_role() = 'content_writer' and app_private.is_assigned_to_campaign(campaign_id))
      or (app_private.current_app_role() = 'client_user'
          and app_private.can_see_client(app_private.client_of_campaign(campaign_id)))
      or (app_private.current_app_role() = 'publisher_user' and supplier_id = app_private.current_supplier_id())
    )
  );

create policy prospects_insert on public.prospects
  for insert to authenticated
  with check (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager', 'prospector', 'outreach_specialist'])
  );

create policy prospects_update on public.prospects
  for update to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'account_manager', 'prospector', 'outreach_specialist'])
      or (app_private.current_app_role() = 'publisher_user' and supplier_id = app_private.current_supplier_id())
    )
  )
  with check (organization_id = app_private.current_org_id());

create policy prospects_delete on public.prospects
  for delete to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

-- Touchpoints: append-only. No update or delete policy exists for anyone, so
-- negotiation history cannot be rewritten.
create policy touchpoints_select on public.outreach_touchpoints
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.can_see_touchpoints_for(prospect_id)
  );

create policy touchpoints_insert on public.outreach_touchpoints
  for insert to authenticated
  with check (
    organization_id = app_private.current_org_id()
    and auth.uid() is not null
    and app_private.can_see_touchpoints_for(prospect_id)
  );

create policy templates_select on public.email_templates
  for select to authenticated
  using (organization_id = app_private.current_org_id() and app_private.is_internal());

create policy templates_write on public.email_templates
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager', 'outreach_specialist']))
  with check (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager', 'outreach_specialist']));

create policy outbox_select on public.email_outbox
  for select to authenticated
  using (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager', 'outreach_specialist']));

create policy outbox_write on public.email_outbox
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager', 'outreach_specialist']))
  with check (organization_id = app_private.current_org_id());

-- ============================================================================
-- PLACEMENTS — operational row. Contains NO money, which is what lets a
-- content_writer read one without learning a client price or supplier cost.
-- ============================================================================
create policy placements_select on public.placements
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and deleted_at is null
    and (
      app_private.is_internal()
      or (app_private.current_app_role() = 'client_user'
          and app_private.can_see_client(app_private.client_of_campaign(campaign_id)))
      or (app_private.current_app_role() = 'publisher_user' and supplier_id = app_private.current_supplier_id())
    )
  );

create policy placements_insert on public.placements
  for insert to authenticated
  with check (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'account_manager', 'prospector', 'outreach_specialist', 'content_writer'])
  );

create policy placements_update on public.placements
  for update to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.is_internal()
      or (app_private.current_app_role() = 'publisher_user' and supplier_id = app_private.current_supplier_id())
    )
  )
  with check (organization_id = app_private.current_org_id());

create policy placements_delete on public.placements
  for delete to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

create policy link_checks_select on public.link_checks
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (app_private.is_internal() or app_private.can_see_placement(placement_id))
  );

create policy link_checks_insert on public.link_checks
  for insert to authenticated
  with check (organization_id = app_private.current_org_id() and app_private.is_internal());

-- ============================================================================
-- TIER 1 — CLIENT PRICING
--   owner, account_manager, and the client that is being charged.
--   NOT prospector, NOT outreach_specialist, NOT content_writer, NOT publisher.
-- ============================================================================
create policy placement_pricing_select on public.placement_pricing
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'account_manager'])
      or (app_private.current_app_role() = 'client_user' and app_private.can_see_placement(placement_id))
    )
  );

create policy placement_pricing_write on public.placement_pricing
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']))
  with check (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']));

create policy client_contracts_select on public.client_contracts
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'account_manager'])
      or (app_private.current_app_role() = 'client_user' and app_private.can_see_client(client_id))
    )
  );

create policy client_contracts_write on public.client_contracts
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']))
  with check (organization_id = app_private.current_org_id() and app_private.has_any_role(array['owner', 'account_manager']));

-- ============================================================================
-- TIER 2 — WHOLESALE COST
--   owner, prospector, outreach_specialist (they negotiate and log it), and the
--   supplier that receives it. account_manager is deliberately ABSENT.
-- ============================================================================
create policy placement_costs_select on public.placement_costs
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'prospector', 'outreach_specialist'])
      or (app_private.current_app_role() = 'publisher_user'
          and supplier_id is not null
          and supplier_id = app_private.current_supplier_id())
    )
  );

create policy placement_costs_write on public.placement_costs
  for all to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'prospector', 'outreach_specialist'])
  )
  with check (
    organization_id = app_private.current_org_id()
    and app_private.has_any_role(array['owner', 'prospector', 'outreach_specialist'])
  );

create policy supplier_bills_select on public.supplier_bills
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'account_manager'])
      or (app_private.current_app_role() = 'publisher_user' and supplier_id = app_private.current_supplier_id())
    )
  );

create policy supplier_bills_write on public.supplier_bills
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner')
  with check (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

-- ============================================================================
-- INVOICES & PAYMENTS
--   Owner writes. account_manager and the client read. Nobody else.
-- ============================================================================
create policy invoices_select on public.invoices
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'account_manager'])
      or (app_private.current_app_role() = 'client_user' and app_private.can_see_client(client_id))
    )
  );

create policy invoices_write on public.invoices
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner')
  with check (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

-- May the caller read this invoice? Owner/account_manager always; a client only
-- for their own invoices.
create or replace function app_private.can_see_invoice(p_invoice_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.invoices i
    where i.id = p_invoice_id
      and (
        app_private.has_any_role(array['owner', 'account_manager'])
        or (app_private.current_app_role() = 'client_user' and app_private.can_see_client(i.client_id))
      )
  );
$$;

create policy invoice_lines_select on public.invoice_line_items
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and app_private.can_see_invoice(invoice_id)
  );

create policy invoice_lines_write on public.invoice_line_items
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner')
  with check (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

create policy payments_select on public.payments
  for select to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

create policy payments_write on public.payments
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner')
  with check (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

-- ============================================================================
-- CONTENT BRIEFS — the writer's queue
-- ============================================================================
create policy briefs_select on public.content_briefs
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'account_manager'])
      or (app_private.current_app_role() = 'content_writer' and assigned_to = auth.uid())
      or (app_private.current_app_role() = 'client_user' and app_private.can_see_placement(placement_id))
    )
  );

create policy briefs_write on public.content_briefs
  for all to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.has_any_role(array['owner', 'account_manager'])
      or (app_private.current_app_role() = 'content_writer' and assigned_to = auth.uid())
    )
  )
  with check (organization_id = app_private.current_org_id());

-- ============================================================================
-- APPEND-ONLY & SYSTEM TABLES
--   SELECT only. No insert/update/delete policy means written exclusively by
--   the API through service_role, which is the only path that bypasses RLS.
-- ============================================================================
create policy activity_log_select on public.activity_log
  for select to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

create policy document_sequences_select on public.document_sequences
  for select to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

-- ============================================================================
-- ATTACHMENTS & CUSTOM FIELD VALUES
--   Both are polymorphic, so they carry a RESOLVED client_id maintained by
--   trigger. Their policies read that column instead of trusting entity_id.
-- ============================================================================
create policy attachments_select on public.attachments
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.is_internal()
      or (client_id is not null and app_private.can_see_client(client_id))
    )
  );

create policy attachments_write on public.attachments
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.is_internal())
  with check (organization_id = app_private.current_org_id() and app_private.is_internal());

create policy custom_field_defs_select on public.custom_field_definitions
  for select to authenticated
  using (organization_id = app_private.current_org_id() and app_private.is_internal());

create policy custom_field_defs_write on public.custom_field_definitions
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner')
  with check (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');

create policy custom_field_values_select on public.custom_field_values
  for select to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (
      app_private.is_internal()
      or (client_id is not null and app_private.can_see_client(client_id))
    )
  );

create policy custom_field_values_write on public.custom_field_values
  for all to authenticated
  using (organization_id = app_private.current_org_id() and app_private.is_internal())
  with check (organization_id = app_private.current_org_id() and app_private.is_internal());

-- ============================================================================
-- PER-USER TABLES
-- ============================================================================
create policy saved_views_own on public.saved_views
  for all to authenticated
  using (
    organization_id = app_private.current_org_id()
    and (user_id = auth.uid() or is_shared)
  )
  with check (organization_id = app_private.current_org_id() and user_id = auth.uid());

create policy notifications_own on public.notifications
  for select to authenticated
  using (organization_id = app_private.current_org_id() and user_id = auth.uid());

create policy notifications_update_own on public.notifications
  for update to authenticated
  using (organization_id = app_private.current_org_id() and user_id = auth.uid())
  with check (organization_id = app_private.current_org_id() and user_id = auth.uid());

create policy export_jobs_own on public.export_jobs
  for select to authenticated
  using (organization_id = app_private.current_org_id() and (requested_by = auth.uid() or app_private.current_app_role() = 'owner'));

create policy export_jobs_insert on public.export_jobs
  for insert to authenticated
  with check (organization_id = app_private.current_org_id() and requested_by = auth.uid());

create policy job_runs_select on public.job_runs
  for select to authenticated
  using (organization_id = app_private.current_org_id() and app_private.current_app_role() = 'owner');
