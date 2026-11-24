-- ===========================================================================
-- 0031 — ONE SOURCE OF TRUTH FOR INVOICE STATUS
--
-- THE DEFECT.
--
-- The effective-status precedence ladder had THREE independent copies:
--
--   1. `v_invoices`                    (SQL, migration 0028)
--   2. `resolve_invoice_share`         (SQL, migration 0029)
--   3. `deriveStatus()` in the invoices module (TypeScript)
--
-- Copies 1 and 3 already disagreed on two reachable cases:
--
--   * a zero-total invoice past its due date  -> view 'issued',  API 'overdue'
--   * a legacy row with status='paid'         -> view 'paid',    API 'issued'
--
-- Copy 2 had also drifted (it omitted `published`), which is why the same invoice
-- read "Published" internally and "Issued" on the public page. I patched that by
-- hand, which is exactly how a third divergence gets introduced later.
--
-- THE FIX.
--
-- The precedence is now a single SQL function. The view calls it, the share
-- resolver calls it, and the API stops deriving status entirely — it reads the
-- derived column the database already computed. There is nothing left to drift.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The one ladder.
--
-- Every input is explicit so the function is pure and testable. Precedence,
-- highest first:
--
--   cancelled        terminal; money does not reopen it
--   paid             fully settled
--   partially_paid   money received, balance remains
--   paid (legacy)    a stored lifecycle value from before 0028
--   overdue          past due with an outstanding balance
--   published        issued and publicly shareable
--   issued           issued, not published
--   draft            everything else
--
-- A zero-total invoice is never "overdue": there is nothing owed, so chasing it
-- would be wrong. That case is why `total > 0` guards the paid branch and why
-- overdue additionally requires `paid < total`.
-- ---------------------------------------------------------------------------
create or replace function app_private.invoice_effective_status(
  p_status      text,
  p_total       numeric,
  p_paid        numeric,
  p_due_date    date,
  p_published_at timestamptz,
  p_issued_at   timestamptz
)
returns text
language sql
-- STABLE, not IMMUTABLE: `current_date` makes the result time-dependent. IMMUTABLE
-- would also permit the planner to fold a call to a constant, which would freeze
-- "overdue" at plan time.
stable
as $$
  select case
    when p_status = 'cancelled'                              then 'cancelled'
    when p_paid >= p_total and p_total > 0                    then 'paid'
    when p_paid > 0                                           then 'partially_paid'
    when p_status = 'paid'                                    then 'paid'
    when p_due_date is not null
         and p_due_date < current_date
         and p_paid < p_total                                 then 'overdue'
    when p_published_at is not null                           then 'published'
    when p_issued_at is not null or p_status = 'issued'       then 'issued'
    when p_status in ('partially_paid', 'overdue')            then 'issued'
    else 'draft'
  end;
$$;

comment on function app_private.invoice_effective_status(text, numeric, numeric, date, timestamptz, timestamptz) is
  'The ONLY invoice status ladder. v_invoices and resolve_invoice_share both call this; nothing else may reimplement it.';

create or replace function app_private.invoice_days_overdue(
  p_total    numeric,
  p_paid     numeric,
  p_due_date date
)
returns integer
language sql
stable
as $$
  select case
    when p_due_date is null then 0
    when p_paid >= p_total and p_total > 0 then 0
    when p_due_date >= current_date then 0
    else (current_date - p_due_date)
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The view delegates.
-- ---------------------------------------------------------------------------
create or replace view public.v_invoices
with (security_invoker = true) as
select
  i.*,
  c.name  as client_name,
  ap.name as agency_partner_name,
  coalesce(p.paid, 0)::numeric(12,2)                    as paid_amount,
  (i.total - coalesce(p.paid, 0))::numeric(12,2)         as balance,
  app_private.invoice_effective_status(
    i.status, i.total, coalesce(p.paid, 0), i.due_date, i.published_at, i.issued_at
  )                                                       as effective_status,
  app_private.invoice_days_overdue(i.total, coalesce(p.paid, 0), i.due_date) as days_overdue
from public.invoices i
join public.clients c on c.id = i.client_id
left join public.agency_partners ap on ap.id = i.agency_partner_id
left join (
  select invoice_id, sum(amount) as paid
  from public.payments
  group by invoice_id
) p on p.invoice_id = i.id;

grant select on public.v_invoices to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The share resolver delegates too.
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
    app_private.invoice_effective_status(
      i.status, i.total, coalesce(p.paid, 0), i.due_date, i.published_at, i.issued_at
    ),
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
    and i.status <> 'cancelled';
$$;

revoke all on function public.resolve_invoice_share(text) from public, anon, authenticated;
grant execute on function public.resolve_invoice_share(text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Self-test: the ladder's edge cases, asserted in the database.
--
-- These are the cases the three copies disagreed on. Asserting them here means a
-- future edit to the function fails the migration rather than shipping a
-- disagreement between the screen and the PDF.
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  v := app_private.invoice_effective_status('issued', 0, 0, current_date - 30, null, now());
  if v <> 'issued' then
    raise exception '0031: zero-total past-due invoice returned %, expected issued', v;
  end if;

  v := app_private.invoice_effective_status('paid', 100, 0, null, null, now());
  if v <> 'paid' then
    raise exception '0031: legacy stored paid returned %, expected paid', v;
  end if;

  v := app_private.invoice_effective_status('issued', 100, 0, current_date - 30, null, now());
  if v <> 'overdue' then
    raise exception '0031: past-due with a balance returned %, expected overdue', v;
  end if;

  v := app_private.invoice_effective_status('issued', 100, 100, current_date - 30, null, now());
  if v <> 'paid' then
    raise exception '0031: paid beats lateness, got %', v;
  end if;

  v := app_private.invoice_effective_status('issued', 100, 40, null, null, now());
  if v <> 'partially_paid' then
    raise exception '0031: part payment returned %, expected partially_paid', v;
  end if;

  v := app_private.invoice_effective_status('issued', 100, 0, null, now(), now());
  if v <> 'published' then
    raise exception '0031: published unpaid returned %, expected published', v;
  end if;

  v := app_private.invoice_effective_status('cancelled', 100, 100, null, now(), now());
  if v <> 'cancelled' then
    raise exception '0031: cancelled must be terminal, got %', v;
  end if;

  v := app_private.invoice_effective_status('draft', 100, 0, null, null, null);
  if v <> 'draft' then
    raise exception '0031: a fresh invoice returned %, expected draft', v;
  end if;

  -- Days overdue is zero once settled, so a late-but-paid invoice is not chased.
  if app_private.invoice_days_overdue(100, 100, current_date - 10) <> 0 then
    raise exception '0031: a settled invoice reported days overdue';
  end if;
  if app_private.invoice_days_overdue(100, 0, current_date - 10) <> 10 then
    raise exception '0031: days overdue miscounted';
  end if;

  raise notice '0031: invoice status ladder verified (8 cases + days overdue)';
end
$$;
