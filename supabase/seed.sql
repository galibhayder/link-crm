-- ============================================================================
-- Seed: a demo organization with one user per role, two clients, campaigns,
-- publishers, prospects, placements with BOTH financial tiers, and an invoice.
--
-- This exists so the RLS suite has something real to assert against. It is
-- applied by `supabase db reset` locally and must never run against production.
-- ============================================================================

do $$
declare
  v_org       uuid;
  v_org2      uuid;
  v_sup       uuid;
  v_sup2      uuid;
  v_client_a  uuid;
  v_client_b  uuid;
  v_camp_a    uuid;
  v_camp_b    uuid;
  v_pub       uuid;
  v_prospect  uuid;
  v_place     uuid;
  v_invoice   uuid;
  v_owner     uuid;
  v_am        uuid;
  v_pros      uuid;
  v_out       uuid;
  v_writer    uuid;
  v_clientu   uuid;
  v_publu     uuid;
  v_template  uuid;
begin
  -- ---------------------------------------------------------------------
  -- Organizations (two, so cross-tenant isolation is testable)
  --
  -- The first is the real business. `brand_color` is the Trivero indigo, taken
  -- from the supplied logo, and it drives BOTH the app accent and the invoice
  -- PDF — one value, one place.
  --
  -- The second is a rival org for isolation tests. It deliberately keeps a plain
  -- name and no logo: if the Trivero mark ever appeared on a rival record, a
  -- screenshot would make the cross-tenant leak obvious.
  -- ---------------------------------------------------------------------
  insert into public.organizations (name, slug, timezone, currency, invoice_prefix, brand_color)
  values ('Trivero Marketing', 'demo-agency', 'Europe/London', 'USD', 'INV', '#4F5BEE')
  returning id into v_org;

  insert into public.organizations (name, slug, timezone, currency, invoice_prefix)
  values ('Rival Link Agency', 'rival-agency', 'UTC', 'USD', 'RV')
  returning id into v_org2;

  -- ---------------------------------------------------------------------
  -- Admin customization row.
  --
  -- Migration 0032 seeds this from `organizations`, but migrations run BEFORE
  -- this file — so at the time 0032 ran there were no organisations and the
  -- insert selected zero rows. The config row therefore belongs here, where the
  -- orgs actually exist.
  -- ---------------------------------------------------------------------
  insert into public.ui_settings (organization_id, config)
  values (v_org, '{}'::jsonb), (v_org2, '{}'::jsonb)
  on conflict (organization_id) do nothing;

  -- ---------------------------------------------------------------------
  -- Auth users, one per role. Passwords are all 'password123' locally.
  --
  -- The token columns matter: GoTrue scans confirmation_token, recovery_token,
  -- email_change and email_change_token_* into non-nullable Go strings, so a
  -- NULL there makes every sign-in fail with "Database error querying schema"
  -- even though the password hash is correct.
  -- ---------------------------------------------------------------------
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token,
    email_change, email_change_token_new, email_change_token_current,
    phone_change, phone_change_token, reauthentication_token
  )
  select
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated', 'authenticated',
    e.email,
    crypt('password123', gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    '', '',
    '', '', '',
    '', '', ''
  from (values
    ('owner@demo.test'),
    ('am@demo.test'),
    ('prospector@demo.test'),
    ('outreach@demo.test'),
    ('writer@demo.test'),
    ('client@demo.test'),
    ('publisher@demo.test'),
    ('owner@rival.test'),
    -- Phase 2 additions: a second client-portal user with NO client grants, to
    -- prove that a client_user with no access sees nothing rather than
    -- everything; and a suspended account to exercise the activation path.
    ('client2@demo.test'),
    ('suspended@demo.test')
  ) as e(email);

  -- GoTrue also needs a matching identities row for password sign-in to resolve
  -- the provider correctly.
  insert into auth.identities (
    id, user_id, provider_id, provider, identity_data,
    last_sign_in_at, created_at, updated_at
  )
  select
    gen_random_uuid(),
    u.id,
    u.id::text,
    'email',
    jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
    now(), now(), now()
  from auth.users u
  where u.email in (
    'owner@demo.test', 'am@demo.test', 'prospector@demo.test', 'outreach@demo.test',
    'writer@demo.test', 'client@demo.test', 'publisher@demo.test', 'owner@rival.test',
    'client2@demo.test', 'suspended@demo.test'
  );

  -- ---------------------------------------------------------------------
  -- Suppliers
  -- ---------------------------------------------------------------------
  insert into public.suppliers (organization_id, name, supplier_type, contact_email, payment_terms_days)
  values (v_org, 'Premium Blog Network', 'link_vendor', 'sales@premium.test', 30)
  returning id into v_sup;

  insert into public.suppliers (organization_id, name, supplier_type, contact_email)
  values (v_org, 'Independent Tech Blog', 'direct_publisher', 'editor@indie.test')
  returning id into v_sup2;

  -- ---------------------------------------------------------------------
  -- Profiles — all seven roles in org 1, plus an owner in org 2
  -- ---------------------------------------------------------------------
  insert into public.profiles (id, organization_id, full_name, email, role)
  select u.id, v_org, 'Olivia Owner', 'owner@demo.test', 'owner' from auth.users u where u.email = 'owner@demo.test'
  returning id into v_owner;

  insert into public.profiles (id, organization_id, full_name, email, role)
  select u.id, v_org, 'Adam Manager', 'am@demo.test', 'account_manager' from auth.users u where u.email = 'am@demo.test'
  returning id into v_am;

  insert into public.profiles (id, organization_id, full_name, email, role)
  select u.id, v_org, 'Priya Prospector', 'prospector@demo.test', 'prospector' from auth.users u where u.email = 'prospector@demo.test'
  returning id into v_pros;

  insert into public.profiles (id, organization_id, full_name, email, role)
  select u.id, v_org, 'Omar Outreach', 'outreach@demo.test', 'outreach_specialist' from auth.users u where u.email = 'outreach@demo.test'
  returning id into v_out;

  insert into public.profiles (id, organization_id, full_name, email, role)
  select u.id, v_org, 'Wendy Writer', 'writer@demo.test', 'content_writer' from auth.users u where u.email = 'writer@demo.test'
  returning id into v_writer;

  insert into public.profiles (id, organization_id, full_name, email, role)
  select u.id, v_org, 'Carla Client', 'client@demo.test', 'client_user' from auth.users u where u.email = 'client@demo.test'
  returning id into v_clientu;

  insert into public.profiles (id, organization_id, full_name, email, role, supplier_id)
  select u.id, v_org, 'Pablo Publisher', 'publisher@demo.test', 'publisher_user', v_sup2
  from auth.users u where u.email = 'publisher@demo.test'
  returning id into v_publu;

  insert into public.profiles (id, organization_id, full_name, email, role)
  select u.id, v_org2, 'Rita Rival', 'owner@rival.test', 'owner' from auth.users u where u.email = 'owner@rival.test';

  -- A client user with NO client grants. Proves that "no grant" means "sees
  -- nothing" rather than "sees everything" — the classic RLS failure.
  insert into public.profiles (id, organization_id, full_name, email, role)
  select u.id, v_org, 'Casey Unassigned', 'client2@demo.test', 'client_user'
  from auth.users u where u.email = 'client2@demo.test';

  -- A suspended account, so the activation path is testable without having to
  -- first suspend someone through the API.
  insert into public.profiles (
    id, organization_id, full_name, email, role, is_active, suspended_at, suspension_reason
  )
  select u.id, v_org, 'Sam Suspended', 'suspended@demo.test', 'content_writer',
         false, now(), 'Left the agency'
  from auth.users u where u.email = 'suspended@demo.test';

  -- ---------------------------------------------------------------------
  -- Pipeline stages
  --
  -- Created automatically by the `organizations_seed_pipelines` trigger
  -- (migration 0014), for BOTH the prospect and placement pipelines. Inserting
  -- them here as well would collide with the trigger's rows and duplicate the
  -- stage definitions in two places, so this file deliberately does nothing.
  -- ---------------------------------------------------------------------

  -- ---------------------------------------------------------------------
  -- Clients — two, so the client portal can be tested for isolation
  -- ---------------------------------------------------------------------
  insert into public.clients (organization_id, name, domain, industry, status, manager_id, start_date)
  values (v_org, 'Acme SaaS', 'acme-saas.test', 'B2B SaaS', 'active', v_am, current_date - 60)
  returning id into v_client_a;

  insert into public.clients (organization_id, name, domain, industry, status, manager_id, start_date)
  values (v_org, 'Beta Commerce', 'beta-commerce.test', 'Ecommerce', 'active', v_am, current_date - 30)
  returning id into v_client_b;

  insert into public.client_billing_profiles (
    organization_id, client_id, legal_name, tax_id, tax_rate, billing_currency, payment_terms_days, billing_address
  ) values (
    v_org, v_client_a, 'Acme SaaS Ltd', 'GB123456789', 20.00, 'USD', 30,
    '{"line1":"1 Market St","city":"London","postcode":"E1 6AN","country":"GB"}'::jsonb
  );

  -- The client portal user is granted access to Acme ONLY.
  insert into public.user_client_access (user_id, client_id, organization_id)
  values (v_clientu, v_client_a, v_org);

  -- ---------------------------------------------------------------------
  -- Campaigns
  -- ---------------------------------------------------------------------
  insert into public.campaigns (
    organization_id, client_id, name, status, service_type, start_date,
    monthly_link_target, target_dr_min, target_traffic_min
  ) values (
    v_org, v_client_a, 'Acme Q1 Guest Posts', 'active', 'guest_post', current_date - 30,
    10, 40, 5000
  ) returning id into v_camp_a;

  insert into public.campaigns (
    organization_id, client_id, name, status, service_type, start_date, monthly_link_target
  ) values (
    v_org, v_client_b, 'Beta Niche Edits', 'active', 'niche_edit', current_date - 20, 5
  ) returning id into v_camp_b;

  -- Assign the writer and prospector to campaign A only.
  insert into public.campaign_assignments (organization_id, campaign_id, profile_id, role_on_campaign)
  values
    (v_org, v_camp_a, v_pros, 'prospector'),
    (v_org, v_camp_a, v_out, 'outreach'),
    (v_org, v_camp_a, v_writer, 'writer');

  insert into public.campaign_monthly_targets (organization_id, campaign_id, period_month, target_links, target_cost)
  values (v_org, v_camp_a, date_trunc('month', current_date)::date, 10, 1200.00);

  -- ---------------------------------------------------------------------
  -- Publishers & offers
  -- ---------------------------------------------------------------------
  insert into public.publishers (
    organization_id, supplier_id, domain, name, dr, da, monthly_traffic, niche, country, link_type, accepts_guest_post, status
  ) values (
    v_org, v_sup, 'techcrunch-ish.test', 'Tech Crunch-ish', 78, 72, 450000,
    array['technology','saas'], 'US', 'dofollow', true, 'active'
  ) returning id into v_pub;

  insert into public.publishers (
    organization_id, supplier_id, domain, name, dr, da, monthly_traffic, niche, country, link_type, status
  ) values
    (v_org, v_sup, 'marketing-weekly.test', 'Marketing Weekly', 65, 60, 120000, array['marketing'], 'GB', 'dofollow', 'active'),
    (v_org, v_sup2, 'indie-dev-blog.test', 'Indie Dev Blog', 42, 38, 8500, array['development'], 'DE', 'dofollow', 'active'),
    (v_org, null, 'low-quality-farm.test', 'Low Quality Farm', 12, 10, 200, array['general'], 'IN', 'dofollow', 'blacklisted');

  insert into public.publisher_offers (organization_id, publisher_id, quoted_price, currency, link_type, valid_from)
  values (v_org, v_pub, 850.00, 'USD', 'dofollow', current_date - 10);

  -- ---------------------------------------------------------------------
  -- Prospects
  -- ---------------------------------------------------------------------
  insert into public.prospects (
    organization_id, campaign_id, publisher_id, domain, contact_name, contact_email,
    stage, assigned_to, supplier_id, priority
  ) values (
    v_org, v_camp_a, v_pub, 'techcrunch-ish.test', 'Tom Editor', 'tom@techcrunch-ish.test',
    'pitched', v_out, v_sup, 'high'
  ) returning id into v_prospect;

  insert into public.prospects (
    organization_id, campaign_id, publisher_id, domain, stage, assigned_to, supplier_id
  ) values
    (v_org, v_camp_a, null, 'saas-blog.test', 'prospected', v_pros, null),
    (v_org, v_camp_a, null, 'dev-tools-hub.test', 'vetting', v_pros, null);

  insert into public.outreach_touchpoints (
    organization_id, prospect_id, user_id, channel, direction, subject, outcome
  ) values
    (v_org, v_prospect, v_out, 'email', 'outbound', 'Guest post opportunity', 'positive');

  -- ---------------------------------------------------------------------
  -- Placements with BOTH financial tiers on separate tables
  -- ---------------------------------------------------------------------
  insert into public.placements (
    organization_id, campaign_id, prospect_id, publisher_id, supplier_id,
    target_url, anchor_text, anchor_type, link_type, status, pipeline_stage,
    live_url, live_date, index_status, assigned_to, internal_notes, client_approved_at
  ) values (
    v_org, v_camp_a, v_prospect, v_pub, v_sup,
    'https://acme-saas.test/features/analytics', 'best analytics platform',
    'partial_match', 'dofollow', 'live', 'live',
    'https://saas-blog.test/acme-analytics-review',
    current_date - 5, 'indexed', v_out,
    'Editor was slow to respond but accepted a partial-match anchor.',
    now() - interval '10 days'
  ) returning id into v_place;

  -- TIER 1: what the client is charged
  insert into public.placement_pricing (organization_id, placement_id, client_rate, currency)
  values (v_org, v_place, 1500.00, 'USD');

  -- TIER 2: what we pay the supplier
  insert into public.placement_costs (organization_id, placement_id, supplier_cost, currency, supplier_id)
  values (v_org, v_place, 850.00, 'USD', v_sup);

  -- A spread across the pipeline, so the board has something on every column.
  --
  -- Live rows carry a live_url because the database now enforces it (migration
  -- 0019): a placement at `live` with nothing to check is indistinguishable from
  -- an untracked one, and link monitoring would have no address to fetch.
  insert into public.placements (
    organization_id, campaign_id, publisher_id, supplier_id,
    target_url, anchor_text, anchor_type, link_type, status, pipeline_stage,
    live_url, live_date, assigned_to, internal_notes, client_approved_at
  ) values
    (v_org, v_camp_a, v_pub, v_sup, 'https://acme-saas.test/pricing', 'acme saas',
     'branded', 'dofollow', 'live', 'live',
     'https://saas-blog.test/acme-pricing-breakdown', current_date - 3, v_out, null,
     now() - interval '12 days'),
    (v_org, v_camp_b, null, null, 'https://beta-commerce.test/shop', 'online store',
     'generic', 'dofollow', 'pending', 'client_approved',
     null, null, v_out,
     'Awaiting the writer to pick this up.', now() - interval '2 days'),
    (v_org, v_camp_b, null, null, 'https://beta-commerce.test/blog', 'ecommerce tips',
     'partial_match', 'dofollow', 'pending', 'pitched',
     null, null, v_pros, 'Publisher quoted 320; still negotiating.', null),
    (v_org, v_camp_a, null, null, 'https://acme-saas.test/blog', 'saas analytics guide',
     'exact_match', 'dofollow', 'pending', 'prospected',
     null, null, v_pros, null, null);

  insert into public.content_briefs (organization_id, placement_id, assigned_to, brief, status)
  values (v_org, v_place, v_writer, 'Write 1200 words on analytics platforms. Natural anchor.', 'submitted');

  -- ---------------------------------------------------------------------
  -- Outreach — one template and two records, so the Outreach screen is not
  -- empty on a fresh reset and the follow-up queue has something in it.
  --
  -- Nothing here claims an email was sent by the system: `delivery_provider`
  -- stays null and `sent_at` is only set on the record that was logged as sent
  -- by hand, which is what an agency without an ESP actually does.
  -- ---------------------------------------------------------------------
  insert into public.email_templates (
    organization_id, name, subject, body_md, category, variables
  ) values (
    v_org,
    'Guest post pitch',
    'Guest post idea for {{domain}}',
    E'Hi {{contact_name}},\n\nI have been reading {{domain}} and would love to contribute a piece.\n\nWould a 1,200 word article on {{topic}} work for you?\n\nThanks,\n{{sender_name}}\n{{agency_name}}',
    'initial',
    '["domain","contact_name","topic","sender_name","agency_name"]'::jsonb
  ) returning id into v_template;

  insert into public.outreach_records (
    organization_id, prospect_id, campaign_id, template_id, kind, status,
    subject, body_excerpt, recipient_email, sent_at, follow_up_due_at,
    follow_up_count, owner_id
  ) values
    -- Sent by hand, reply overdue: appears in the follow-up queue.
    (v_org, v_prospect, v_camp_a, v_template, 'initial', 'sent',
     'Guest post idea for saas-blog.test', 'Happy to write about analytics.',
     'editor@saas-blog.test', now() - interval '6 days',
     now() - interval '2 days', 1, v_out),
    -- A draft that has not been sent anywhere.
    (v_org, v_prospect, v_camp_a, v_template, 'follow_up', 'draft',
     'Following up on the guest post', 'Just checking in on the idea I sent.',
     'editor@saas-blog.test', null, null, 0, v_out);

  -- ---------------------------------------------------------------------
  -- Invoice — issued through the per-org counter, then verified by tests
  --
  -- `issued` (not the pre-Phase-6 `sent`): migration 0028 renamed the lifecycle
  -- state, and this seed is replayed on every db:reset.
  --
  -- The number is ALLOCATED from document_sequences rather than written as a
  -- literal. Hardcoding 'INV-0001' left the counter at 1, so the first invoice
  -- created through the API also asked for 1 and hit the unique constraint —
  -- a 500 on the very first create. Seeding through the same mechanism the API
  -- uses is what keeps the two from disagreeing.
  -- ---------------------------------------------------------------------
  declare
    v_seq integer;
  begin
    v_seq := public.next_document_number_rpc(v_org, 'invoice');

    insert into public.invoices (
      organization_id, client_id, invoice_number, period_start, period_end,
      status, tax_rate, currency, due_date, issued_at
    ) values (
      v_org, v_client_a,
      'INV-' || lpad(v_seq::text, 4, '0'),
      date_trunc('month', current_date - interval '1 month')::date,
      (date_trunc('month', current_date) - interval '1 day')::date,
      'issued', 20.00, 'USD', current_date + 14, now()
    ) returning id into v_invoice;
  end;

  insert into public.invoice_line_items (organization_id, invoice_id, description, quantity, unit_price, placement_id)
  values (v_org, v_invoice, 'Link placement — techcrunch-ish.test', 1, 1500.00, v_place);

  -- A partial payment, so `partially_paid` is exercised rather than assumed.
  insert into public.payments (organization_id, invoice_id, amount, method, reference, recorded_by)
  values (v_org, v_invoice, 900.00, 'bank_transfer', 'REF-001', v_owner);

  -- ---------------------------------------------------------------------
  -- A rival-org client, to prove cross-tenant isolation
  -- ---------------------------------------------------------------------
  insert into public.clients (organization_id, name, domain, status)
  values (v_org2, 'Rival Secret Client', 'rival-secret.test', 'active');

end $$;
