# Supabase Migration Guide

32 migrations, applied in filename order. They are **idempotent-safe but ordered**: several later files deliberately fix earlier ones (`0025`, `0027`, `0031`), so skipping or reordering them produces a subtly wrong schema rather than an error.

---

## 1. What the migrations build

| Range | What it establishes |
|---|---|
| `0001`–`0008` | Extensions, helpers, core tables, RLS, triggers/views, privilege-escalation fix, invitations, audit immutability |
| `0009`–`0013` | Phase 3 CRM fields, import jobs, campaign archive |
| `0014`–`0019` | Placement pipeline, portal visibility, stage dedup, negotiated cost, placement invariants |
| `0020`–`0026` | Content briefs, link verification, client draft approval/revision, scheduled jobs, notifications |
| `0027` | The `emit_notification` RPC wrapper — without it every notification call fails silently |
| `0028`–`0031` | Invoice core, financial records, profitability views, invoice status single-source |
| `0032` | Admin customization: `ui_settings`, `notification_preferences`, saved-view flags, custom-field lifecycle |

### Ordering hazards that already bit once

* **`0028` renamed invoice statuses** (`void`→`cancelled`, `sent`→`issued`) and had to also fix the views created in `0004`. A view filtering on `'sent'` becomes always-true, not an error.
* **`0031` declares `app_private.invoice_effective_status` once.** Declaring it twice — even identically — fails.
* **`0027` wraps `emit_notification`** because `app_private` functions are not exposed by PostgREST. Without the `public.*` wrapper every call 404s and the caller counts the failure as "suppressed".
* **`0026`/`0025` add columns the API expects.** The API will boot without them and fail at request time, so always migrate before deploying code.

---

## 2. Local development

```bash
pnpm db:start          # start the Supabase container stack
pnpm db:reset          # drop, recreate, apply ALL migrations, then seed
```

`db:reset` is the only command that guarantees a schema matching the migrations exactly. Use it whenever a migration changes.

```bash
pnpm exec supabase migration new <name>   # scaffold a new timestamped file
pnpm db:reset                             # apply it
```

**Never edit an applied migration.** Add a new one. Editing an applied file leaves every existing environment on the old shape while a fresh one gets the new shape — a divergence that only shows up in production.

---

## 3. Deploying to a hosted Supabase project

### First deployment

```bash
# 1. Link the local project to the hosted one (once)
pnpm exec supabase link --project-ref <your-project-ref>

# 2. Review what will run, before running it
pnpm exec supabase db push --dry-run

# 3. Apply
pnpm exec supabase db push
```

### Every subsequent deployment

```bash
pnpm exec supabase db push --dry-run   # read the plan
pnpm exec supabase db push
```

### Do NOT use `db reset` against a hosted project

`supabase db reset` **drops the database**. Locally that is fine. Against production it destroys every client, invoice and placement. There is no undo.

---

## 4. Seeding

`supabase/seed.sql` creates the demo organisation, seven role users and sample data. It is **for development only**.

On a hosted project, do not run it. Create the first real user through Supabase Auth, then promote them:

```sql
-- After the user has signed up, grant owner in their profile
update public.profiles
set role = 'owner'
where id = '<auth-user-uuid>';
```

Then set the organisation's branding once:

```sql
update public.organizations
set name = 'Trivero Marketing',
    brand_color = '#4F5BEE'
where id = '<org-uuid>';
```

The logo is uploaded through the Admin UI, not by SQL — that path validates magic bytes and size, which a direct write does not.

---

## 5. Verifying a migration actually applied

Do not trust the exit code. Check the resulting schema.

```bash
# How many migrations does the hosted DB believe it has?
psql "$SUPABASE_DB_URL" -c "select count(*) from supabase_migrations.schema_migrations;"

# Is RLS enabled and FORCED everywhere? Both must be true.
psql "$SUPABASE_DB_URL" -c "
  select c.relname from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname='public' and c.relkind='r'
    and (not c.relrowsecurity or not c.relforcerowsecurity);
"
# expect: zero rows

# Are the critical functions present?
psql "$SUPABASE_DB_URL" -c "
  select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','app_private')
    and proname in ('emit_notification','invoice_effective_status','recompute_invoice_totals');
"
```

`pnpm verify:rls` runs the zero-rows check plus an anonymous data-access probe against a deployed project.

---

## 6. Rollback

There is no automatic rollback. Supabase migrations are forward-only by design.

For a bad migration, the options in order of preference:

1. **Write a corrective migration.** The established pattern in this repo — `0005`, `0008`, `0011`, `0016`, `0025`, `0027`, `0031` all fix earlier files. This is the safe route and leaves a readable history.
2. **Restore from backup** (see `DATABASE-BACKUP.md`). Fast, but loses everything written since the backup.

Never hand-edit the hosted schema to "undo" a migration. The local migrations then disagree with production, and the next `db push` reintroduces the problem in a less obvious form.

---

## 7. Migration safety checklist

Before pushing to production:

- [ ] `supabase db push --dry-run` reviewed line by line
- [ ] The change is additive, or has a stated data-migration plan
- [ ] A backup exists and its restore has been tested (see `DATABASE-BACKUP.md`)
- [ ] New tables have `enable row level security` **and** `force row level security`
- [ ] New tables have at least one policy — RLS-on with no policies denies everything, which looks like an outage
- [ ] New SECURITY DEFINER functions set `search_path` explicitly
- [ ] `pnpm verify:rls` passes against staging
- [ ] The API code that reads a new column ships *after* the column exists
