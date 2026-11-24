# Database Backup Guide

A link building agency's database is the business. Clients, campaigns, placements, invoices and payment history cannot be regenerated from anything else. A backup you have never restored is a guess, not a backup.

---

## 1. What is actually at risk

| Data | Recoverable from elsewhere? |
|---|---|
| Clients, campaigns, placements | No |
| Invoices, line items, payments, payouts | No — and these are financial records |
| Publisher contacts, outreach history | No |
| Audit log | No — and it is what proves *who* changed what |
| Custom field definitions, UI settings | No |
| Uploaded files (logos, attachments, briefs) | No — **stored in Supabase Storage, not in the database dump** |

That last row is the one people miss. A `pg_dump` restores rows; it does **not** restore objects held in Storage buckets. Both need backing up.

---

## 2. Hosted Supabase

### Option A — Supabase's own backups (a starting point, not a plan)

Paid plans include daily automated backups with a retention window shown in **Project Settings → Database → Backups**. Point-in-time recovery may be available.

Two limits to know:

* Restoring is done through the dashboard, and a restore **replaces the whole database**. You cannot restore a single table.
* The retention window is the entire recovery objective. A 7-day window means a corrupted import discovered on day 9 is unrecoverable.

Confirm the retention window for your plan and write it down. If it is shorter than your financial-record retention obligations, Option B is mandatory.

### Option B — your own scheduled dump (recommended alongside A)

```bash
#!/usr/bin/env bash
set -euo pipefail

# Requires the database connection string (Project Settings → Database → Connection string).
# Store it in the environment, never in this file.
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is not set}"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="./backups/crm-${STAMP}.dump"

mkdir -p ./backups

# -Fc = custom format: compressed, and restorable table-by-table with pg_restore.
# --no-acl keeps role grants out of the dump so it restores into a clean project.
pg_dump "$SUPABASE_DB_URL" \
  --format=custom \
  --no-acl \
  --no-owner \
  --file="$OUT"

# Verify the dump is readable BEFORE trusting it. A truncated dump is worse than
# no dump, because it looks like a backup.
pg_restore --list "$OUT" > /dev/null

echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
```

Run it on a schedule (`cron` on any small host):

```cron
# 02:15 UTC daily
15 2 * * * /path/to/backup.sh >> /var/log/crm-backup.log 2>&1
```

Use `-Fc` (custom format) rather than plain SQL: it compresses, and `pg_restore` can then restore one table without replaying everything.

### Storage bucket backup

```bash
# Requires the Supabase CLI and a linked project
pnpm exec supabase storage cp -r ss:///logos ./backups/storage/logos
```

Run this on the same schedule as the database dump. A database row pointing at a logo that no longer exists is a broken invoice.

---

## 3. Restoring — and proving the backup works

**Do this before you need it.** A restore you have never performed is untested code.

### Restore into a scratch project (the safe first test)

```bash
# 1. Create a NEW, empty Supabase project. Never test a restore against production.
# 2. Restore into it.
pg_restore \
  --dbname="$SCRATCH_DB_URL" \
  --no-owner \
  --no-acl \
  --clean --if-exists \
  ./backups/crm-20260101T021500Z.dump

# 3. Prove the data is there.
psql "$SCRATCH_DB_URL" -c "select count(*) from clients;"
psql "$SCRATCH_DB_URL" -c "select count(*) from invoices;"
psql "$SCRATCH_DB_URL" -c "select count(*) from placements;"

# 4. Prove RLS survived. A restore that loses policies is a data leak waiting.
psql "$SCRATCH_DB_URL" -c "
  select c.relname from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname='public' and c.relkind='r'
    and (not c.relrowsecurity or not c.relforcerowsecurity);
"
# expect: zero rows

# 5. Point the API at the scratch project and confirm it serves correctly.
```

Step 4 is not optional. `pg_dump`/`pg_restore` preserves RLS policies and the `force` flag, but a restore that used `--no-acl` across a different project, or an incomplete dump, can leave a table exposed. Verify rather than assume.

### Restoring into production

Only after the scratch restore succeeded, and only with a written record of the data that will be lost (everything written since the dump).

1. Put the application into maintenance mode, or stop the API.
2. Take a fresh dump of the *current* state first — even a bad current state is better than none.
3. Restore.
4. `pnpm verify:rls` and `pnpm verify:all` against the restored database.
5. Restart the API and check `/health/ready`.

---

## 4. Retention and off-site copies

A backup on the same provider as the database is not protection against losing that provider account.

| Copy | Where | How long |
|---|---|---|
| Daily dump | Object storage, different provider | 30 days |
| Weekly dump | Same, but in a second region | 12 weeks |
| Monthly dump | Cold storage | 7 years (financial records) |
| Supabase automated | Supabase's retention window | as offered |

Encrypt dumps at rest. They contain client PII and full financial history:

```bash
# Encrypt before uploading off-site
gpg --symmetric --cipher-algo AES256 --output "$OUT.gpg" "$OUT"
rm "$OUT"   # do not leave the plaintext copy behind
```

Keep the passphrase somewhere other than the storage bucket holding the dumps. A key stored beside its own ciphertext is not encryption.

---

## 5. What "verified" means

A backup is verified only when all four are true:

- [ ] The dump restored successfully into a **separate** project
- [ ] Row counts match the source for clients, invoices, payments, placements
- [ ] RLS is enabled **and forced** on every restored table, with zero exceptions
- [ ] The API served a real request against the restored database

Record the date of the last verified restore. If it is older than a quarter, the process has rotted.

---

## 6. Restore drill (quarterly, 30 minutes)

1. Pick the most recent daily dump.
2. Restore into a scratch Supabase project.
3. Run the verification SQL above.
4. Point a local API instance at it: `SUPABASE_URL=<scratch> pnpm dev:api`.
5. Sign in, open an invoice, generate its PDF, load the dashboard.
6. Record the date and any deviations from this document.

Step 5 is what catches the failures the SQL cannot see — a missing Storage object, a view that restored without its dependencies, a function whose `search_path` now points somewhere empty.
