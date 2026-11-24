# Supabase configuration

Everything needed to stand up this project against a Supabase instance, local or
hosted, plus the parts that are easy to get wrong.

---

## 1. Local development

```bash
pnpm exec supabase start      # pulls Docker images on first run
pnpm exec supabase db reset   # applies migrations + seed
```

`supabase/config.toml` in this repo configures:

| Setting | Value | Why |
|---|---|---|
| `project_id` | `link-building-crm` | Container name prefix |
| `api.port` | `54321` | PostgREST |
| `db.port` | `54322` | Direct Postgres |
| `studio.port` | `54323` | Table editor |
| `local_smtp.port` | `54324` | Mailpit — invite and reset emails land here |
| `auth.jwt_expiry` | `3600` | One-hour access tokens |
| `auth.enable_refresh_token_rotation` | `true` | Rotating refresh tokens |
| `auth.hook.custom_access_token` | `pg-functions://postgres/app_private/custom_access_token_hook` | **Critical — see §3** |

Read the generated keys with:

```bash
pnpm exec supabase status -o env
```

Emails sent during local development (invitations, password resets) are captured
by Mailpit at **http://127.0.0.1:54324** — they are not delivered.

---

## 2. Hosted project setup

1. Create a project at supabase.com. Note the project URL and both keys.
2. Apply the schema:

```bash
pnpm exec supabase link --project-ref <ref>
pnpm exec supabase db push
```

3. **Do not run `seed.sql` against production.** It inserts demo organisations
   and test accounts with a known password.

4. Set the environment variables in the API host:

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>   # server only, never VITE_
```

5. Set the frontend variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).
   Both are public by design.

---

## 3. The Custom Access Token Hook — do not skip this

Every RLS policy in this schema reads `org_id` and `role` from
`auth.jwt() -> 'app_metadata'`. Those claims are added by
`app_private.custom_access_token_hook`, configured in `config.toml`.

On a **hosted** project this must be enabled in the dashboard:

> Authentication → Hooks → Custom Access Token → select
> `app_private.custom_access_token_hook`

If it is not enabled, every policy reads a null `org_id` and **all reads return
zero rows**. It looks like a broken app rather than a misconfiguration, so it is
worth verifying immediately after setup:

```sql
select app_private.custom_access_token_hook(
  jsonb_build_object(
    'user_id', (select id::text from auth.users where email = 'you@agency.com'),
    'claims', '{}'::jsonb
  )
);
-- Expect: {"claims":{"app_metadata":{"role":"...","org_id":"...","supplier_id":null}},...}
```

Two grants are easy to miss and both cause sign-in to fail with the unhelpful
message `Database error querying schema`:

```sql
grant execute on function app_private.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant usage   on schema    app_private                             to supabase_auth_admin;
```

`EXECUTE` alone is not enough — without `USAGE` on the schema, auth cannot reach
the function. Migration `0001` grants both.

---

## 4. Registration is invitation-only

There is deliberately no open sign-up:

- `auth.email.enable_signup` may be `true`; Supabase will create an auth user.
- But a trigger (`app_private.provision_profile_from_invitation`) only creates a
  **profile** when a matching pending invitation exists.
- No profile means `authenticate` rejects the request, so an uninvited sign-up
  can hold a session and do nothing with it.

The role is taken from the **invitation row**, never from sign-up metadata. A
client sending `{ "data": { "role": "owner" } }` gains nothing.

### The invitation lifecycle

`inviteUserByEmail` creates the auth user **immediately**, at invite time — not
when the invitee clicks the link. The lifecycle therefore has two distinct
moments, handled by two triggers:

| Moment | Trigger | Effect |
|---|---|---|
| Admin invites | `after insert on auth.users` | Profile provisioned with the invited role; invitation stays `pending` |
| Invitee confirms email | `after update of email_confirmed_at` | Invitation moves to `accepted` |

This distinction matters. If the invitation is consumed at invite time:

- every invitation is instantly `accepted`,
- the "Pending invitations" panel is permanently empty,
- `resend` and `revoke` are unreachable, since both require `pending`.

That was the behaviour before migration `0008`; see the note in that file.

**Revoking an invitation also deactivates the provisioned account**, because the
profile already exists and would otherwise keep working. The user is signed out.

**An invitee cannot sign in until they confirm their email.** GoTrue returns
`email_not_confirmed`, which is correct — the invitation is not accepted until
they prove control of the address.

To invite someone, sign in as the owner and use **Staff & Roles → Invite user**.

---

## 5. Password reset

Supabase sends the reset email; the app handles the callback at
`/reset-password`. Add these to **Authentication → URL Configuration**:

- **Site URL:** `https://your-app.example`
- **Redirect URLs:** `https://your-app.example/reset-password`

For local development the equivalents are `http://localhost:5173` and
`http://localhost:5173/reset-password`.

The request form always reports the same result whether or not the address
exists, so it cannot be used to enumerate staff accounts.

---

## 6. Row Level Security

RLS is enabled **and forced** on every table in `public`. Verified mechanically:

```bash
docker exec supabase_db_link-building-crm psql -U postgres -d postgres -t -c "
  select count(*) from pg_tables t
  where t.schemaname='public' and not exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=t.tablename
      and c.relrowsecurity and c.relforcerowsecurity);"
# Expect: 0
```

### Privileged profile columns

`role`, `is_active`, `supplier_id` and `organization_id` are **not** writable by
`authenticated`. Migration `0005` revokes column-level UPDATE and adds a trigger.
Users may edit only `full_name`, `phone` and `avatar_url`.

This exists because the first version of the policy allowed any signed-in user to
PATCH their own row — including `role: "owner"` — and the token hook would then
re-stamp the escalated role into their JWT. The exploit is preserved as a
regression test in `scripts/attack-privilege-escalation.mjs`.

---

## 7. Storage

Not used in Phase 2. When it is added:

- No public buckets.
- Object paths must be `{organization_id}/{entity_type}/{entity_id}/{filename}`.
- Policies on `storage.objects` use `(storage.foldername(name))[1]::uuid = app_private.current_org_id()`.
- Downloads are short-lived signed URLs.

---

## 8. Verifying a deployment

```bash
pnpm verify:secrets          # no server secret in the browser bundle
node scripts/test-authorization.mjs   # 85 authorization assertions
node scripts/attack-privilege-escalation.mjs
```

Run the authorization suite against any environment by setting `API_URL` and
`SUPABASE_URL`. It needs seeded users, so point it at staging, not production.
