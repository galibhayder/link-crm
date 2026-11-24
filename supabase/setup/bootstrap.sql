/**
 * BOOTSTRAP A FRESH HOSTED PROJECT — run ONCE, before creating any auth user.
 *
 * Idempotent: safe to re-run.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE ORDER IS LOAD-BEARING, not a convention
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `on_auth_user_created_provision_profile` looks for a PENDING invitation for the
 * new email and creates NOTHING if it does not find one — deliberately "fail
 * closed", so a public signup cannot mint itself an account.
 *
 * So the organisation and the invitation must exist BEFORE the user is created in
 * the dashboard. The wrong order leaves an auth user with no profile: they can
 * authenticate, but `authenticate.ts` finds no profile and replies 403
 * "Your account is inactive", which reads like a bug in the app rather than an
 * incomplete bootstrap.
 *
 * Verified end-to-end against a live database by
 * scripts/test-bootstrap-sequence.mjs — including the negative case.
 */

-- ---------------------------------------------------------------------------
-- 1. Organisation. `slug` is NOT NULL with no default, so it must be supplied,
--    and it is unique — hence the upsert.
-- ---------------------------------------------------------------------------
insert into public.organizations (name, slug, brand_color)
values ('Trivero Marketing', 'trivero-marketing', '#4F5BEE')
on conflict (slug) do update
  set name = excluded.name,
      brand_color = excluded.brand_color;

-- ---------------------------------------------------------------------------
-- 2. The owner invitation.
--
-- `invited_by` is nullable, which is what lets the FIRST owner exist: there is no
-- profile yet to attribute it to. Every later user is invited through the app.
--
-- The email must match EXACTLY what you use in Authentication -> Users.
-- ---------------------------------------------------------------------------
insert into public.invitations (organization_id, email, full_name, role, invited_by)
select o.id, 'galib@triveromarketing.com', 'Galib', 'owner', null
from public.organizations o
where o.slug = 'trivero-marketing'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. Report, so the result is checkable at a glance.
-- ---------------------------------------------------------------------------
select
  (select count(*) from public.organizations) as organisations,
  (select count(*) from public.invitations where status = 'pending') as pending_invites,
  (select string_agg(lower(email), ', ') from public.invitations where role = 'owner') as owner_email,
  (select count(*) from public.profiles) as profiles;
