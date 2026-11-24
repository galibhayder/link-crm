# Hostinger Deployment Guide

Target: **Hostinger Business Web Hosting with Node.js**. The app runs as a single Node process that serves both the compiled React frontend and the JSON API on one origin — so there is no CORS to configure and no second server to pay for.

> **Verified, not assumed.** `pnpm build:hostinger` assembles the upload bundle, runs a real `npm install --omit=dev` inside it, then **boots it** and checks it serves the SPA, answers the API and reaches the database. If any of that fails the build fails. See `scripts/verify-hostinger-artifact.mjs`.

---

## 1. What you need before starting

| Thing | Where |
|---|---|
| Hostinger Business plan with Node.js support | — |
| A hosted Supabase project | supabase.com → New project |
| Your domain (or a subdomain) pointed at Hostinger | hPanel → Domains |
| Node 20 or newer selected in hPanel | hPanel → Advanced → Node.js |

> **Check the plan first.** Hostinger's cheapest plans are PHP-only. The **Business** plan (or a VPS) is required — Node.js hosting is not available on Premium. Confirm in hPanel that you can see *Advanced → Node.js*.

---

## 2. Prepare the database

On the hosted Supabase project:

1. **Run the migrations.** Follow `docs/DATABASE-MIGRATIONS.md` §3.
2. **Collect the three values** from *Project Settings → API*:
   - Project URL → `SUPABASE_URL`
   - `anon` public key → `SUPABASE_ANON_KEY`
   - `service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY`
3. **Do not run `supabase/seed.sql`.** It creates demo users with known passwords. On a public deployment that is an open door.

Create your real account instead: sign up through the deployed app, then promote it (`DATABASE-MIGRATIONS.md` §4).

---

## 3. Build the upload bundle

On your own machine:

```bash
pnpm install
pnpm build:hostinger
```

This produces `dist-hostinger/`:

```
dist-hostinger/
  server.js              entry point (the start command)
  package.json           production dependencies only
  node_modules/          already installed, including @crm/shared
  dist/                  compiled API
  web-dist/              compiled React app
```

The script verifies the bundle boots before it finishes. If you see `15 passed, 0 failed`, the artifact runs.

### Why not just upload the monorepo?

Hostinger has no pnpm workspace. `@crm/shared` and the API use `workspace:*`, which `npm install` cannot resolve — the install fails outright. The build script flattens the workspace into a self-contained single package.

---

## 4. Upload

**Option A — File Manager (simplest)**

1. hPanel → **Files → File Manager**.
2. Upload a zip of the **contents** of `dist-hostinger/` (not the folder itself) into your application directory, then extract.
3. Confirm `server.js` sits at the top level of that directory.

**Option B — SSH / Git (better for redeploys)**

```bash
rsync -avz --delete dist-hostinger/ user@your-host:/home/user/domains/yourdomain.com/crm/
```

`--delete` matters: without it, stale hashed assets accumulate forever and old files can shadow new ones.

---

## 5. Configure Node.js in hPanel

hPanel → **Advanced → Node.js**:

| Setting | Value |
|---|---|
| Node.js version | **20** or newer (22 recommended) |
| Application root | the directory holding `server.js` |
| Application startup file | `server.js` |
| Application URL | your domain |

Then click **Run NPM Install** only if `node_modules` is missing. The bundle normally ships it already installed.

> **Do not set a `PORT` manually.** Hostinger injects one. The app reads `process.env.PORT` and binds to it.

---

## 6. Set environment variables

hPanel → **Advanced → Node.js → Environment Variables**. Add each one:

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SUPABASE_URL` | `https://YOUR-PROJECT.supabase.co` |
| `SUPABASE_ANON_KEY` | the anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | the service-role key |
| `JOB_HMAC_SECRET` | 32+ random chars — see `PRODUCTION-ENV.md` §3 |
| `CORS_ORIGINS` | `https://yourdomain.com` |
| `WEB_DIST_PATH` | `./web-dist` |
| `LOG_LEVEL` | `info` |

If the panel has no environment-variable UI, create a `.env` file **outside the document root**, or in the app root only if that directory is not web-served. A `.env` reachable at `https://yourdomain.com/.env` exposes the service-role key, which is full database access.

---

## 7. Restart and verify

hPanel → Node.js → **Restart**.

Then, from your machine:

```bash
# 1. The process is up
curl -s https://yourdomain.com/health/live

# 2. The database is genuinely reachable
curl -s https://yourdomain.com/health/ready
# expect: {"data":{"status":"ok","database":"reachable","latencyMs":N}}

# 3. The SPA is served
curl -sI https://yourdomain.com/ | head -1
# expect: HTTP/2 200

# 4. Deep links work (no 404 on refresh)
curl -s https://yourdomain.com/invoices | grep -o 'id="root"'

# 5. The API is JSON, not HTML
curl -s https://yourdomain.com/api/v1/clients
# expect: {"error":{"code":"unauthorized",...}}
```

If `/health/live` returns 200 but `/health/ready` returns 503, the process is fine and the **database credentials are wrong** — check `SUPABASE_URL` and the service-role key.

If the site loads but every page is blank, open the browser console. A CSP error there means the shell is being served by something other than the app (a Hostinger default page or a proxy) — check that the startup file is `server.js` and not `index.html`.

---

## 8. Scheduled jobs

The app exposes `/api/v1/internal/jobs/*`, signed with `JOB_HMAC_SECRET`. On Supabase these are called by `pg_cron` + `pg_net` (migration `0023`).

If `pg_cron` is unavailable on your plan, call them from Hostinger's cron UI:

```cron
# Link verification, every 6 hours
0 */6 * * * curl -s -X POST https://yourdomain.com/api/v1/internal/jobs/verify-links \
  -H "x-job-signature: $(generate)" 
```

The signature is an HMAC-SHA256 of the payload using `JOB_HMAC_SECRET`. **Note the timestamps are in milliseconds, not seconds** — this trips people up. See `apps/api/src/modules/jobs/`.

---

## 9. Redeploying

```bash
# 1. On your machine
pnpm build:hostinger          # builds AND verifies the artifact

# 2. Upload
rsync -avz --delete dist-hostinger/ user@host:/path/to/app/

# 3. Restart
#    via hPanel → Node.js → Restart
```

Order matters on a schema change: **migrate the database first**, then deploy the code. New API code reading a missing column fails at request time; old code reading a widened column keeps working.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Refusing to start in production:` | A production guard fired | Read the message — it names the variable. Expected behaviour. |
| 502 / 503 from the host | Process crashed on boot | Check the Node.js log in hPanel. Usually an env var or a missing `node_modules`. |
| Site loads, pages blank | Wrong startup file, or a stale shell | Confirm startup is `server.js`; clear the Hostinger cache. |
| `/health/ready` → 503 | Database unreachable | Wrong `SUPABASE_URL` / service-role key, or the project is paused (free tier pauses after inactivity). |
| Every API call 401 | Token not reaching the server | Check the proxy is forwarding the `Authorization` header. |
| Deep links 404 | Static handler not reached | Confirm `WEB_DIST_PATH` points at `./web-dist`. |
| `ERR_MODULE_NOT_FOUND: @crm/shared` | Old artifact uploaded | Rebuild with `pnpm build:hostinger`; the script vendors the package. |
| Fonts/PDF fail | Missing assets in the artifact | Rebuild — never hand-assemble the upload. |

---

## 11. Deployment checklist

- [ ] Hostinger Business plan (Node.js available in hPanel)
- [ ] Migrations applied to the hosted Supabase project
- [ ] **`seed.sql` NOT run** on production
- [ ] First real user created and promoted to `owner`
- [ ] `pnpm build:hostinger` finished with `15 passed, 0 failed`
- [ ] Artifact uploaded, `server.js` at the top level
- [ ] Node 20+ selected, startup file `server.js`
- [ ] All eight environment variables set
- [ ] `/health/live` → 200
- [ ] `/health/ready` → `database: reachable`
- [ ] Deep link refresh works (`/invoices`)
- [ ] API returns JSON 401 for an unauthenticated call
- [ ] Sign-in works with a real account
- [ ] An invoice PDF downloads and opens
- [ ] Scheduled job cron configured
- [ ] Database backup scheduled (`DATABASE-BACKUP.md`)
- [ ] `pnpm verify:secrets` passes on the built bundle
