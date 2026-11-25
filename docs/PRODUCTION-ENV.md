# Production Environment Variables

Every variable the application reads, what happens if it is wrong, and where each one is safe to live. The API validates this list at boot and **refuses to start** if anything required is missing or malformed — a half-configured server is worse than none.

There are **two separate files**, because the frontend bundle is public by definition and the backend secrets are not.

---

## 1. Backend — `apps/api/.env`

Read by Express. **Never** exposed to the browser.

| Variable | Required | Example | What it does |
|---|---|---|---|
| `NODE_ENV` | yes | `production` | Gates the production checks below. Anything but `production` skips them. |
| `PORT` | no | `3000` | Listen port. Hostinger assigns one automatically — see §4. |
| `SUPABASE_URL` | yes | `https://ovxflykukxitapfsayrx.supabase.co` | Project URL. Must be the hosted URL in production. |
| `SUPABASE_ANON_KEY` | yes | `eyJhbGci...` | Public anon key. Used server-side only to validate identity; also ships to the browser via the frontend file. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | `eyJhbGci...` | **Server-only. Full database access, bypasses RLS.** This is the single most dangerous value in the system. |
| `JOB_HMAC_SECRET` | yes in prod | 32+ random chars | Signs `/api/v1/internal/jobs/*`. Without it, scheduled link verification and overdue reminders stop silently. |
| `CORS_ORIGINS` | yes in prod | `https://crm.triveromarketing.com` | Comma-separated allowlist. **No wildcards.** |
| `LOG_LEVEL` | no | `info` | `fatal`…`trace`. Use `info` in production. |
| `WEB_DIST_PATH` | no | `/home/u123/crm/apps/web/dist` | Where the compiled SPA lives. Empty in a monorepo checkout — the default resolves correctly. Set it when the upload is flattened. |

### Production refusal conditions

With `NODE_ENV=production`, the process exits immediately if any of these is true. Each one is a setting whose *default* is correct for development and silently wrong in production — the worst combination, because the server boots happily and the damage appears later.

```
CORS_ORIGINS still points at localhost
SUPABASE_URL points at localhost
JOB_HMAC_SECRET is missing
```

You will see this instead of a running server:

```
Refusing to start in production:
  - CORS_ORIGINS still points at localhost. Set it to the real origin, e.g. https://crm.triveromarketing.com
  - SUPABASE_URL points at localhost. Set it to the hosted project URL.
```

That is working as intended.

---

## 2. Frontend — `apps/web/.env`

Vite inlines these into the bundle **at build time**. Everything here is public. Anyone can read it by opening the JavaScript.

| Variable | Required | Example | Notes |
|---|---|---|---|
| `VITE_SUPABASE_URL` | yes | `https://ovxflykukxitapfsayrx.supabase.co` | Same value as the backend. Public by design. |
| `VITE_SUPABASE_ANON_KEY` | yes | `eyJhbGci...` | The **anon** key. RLS exists because this key is public. |
| `VITE_API_URL` | no | *(empty)* | Empty means same-origin. In the single-server deployment this **must** stay empty. |
| `VITE_APP_NAME` | no | `Trivero Marketing` | Build-time fallback only; the Admin panel overrides it at runtime. |

### Two rules that must not be broken

**1. `VITE_SUPABASE_SERVICE_ROLE_KEY` must never exist.** Anything with a `VITE_` prefix is compiled into the public bundle. A service-role key there is a full database compromise, discoverable by any visitor with a browser console. `pnpm verify:secrets` greps the built bundle for it and fails the build if found.

**2. Build-time means rebuild-to-change.** Editing `apps/web/.env` does nothing to an already-built bundle — the values are baked in. Change the values, then rebuild.

---

## 3. Generating secrets

```bash
# JOB_HMAC_SECRET — 32 bytes of randomness, base64
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Use a different value per environment. Never reuse the development secret in production.

---

## 4. Hostinger-specific notes

Hostinger Business hosting injects `PORT` and expects the app to bind to it. **Do not hardcode a port.**

If Hostinger's panel lets you set environment variables, set them there rather than uploading a `.env` file — the file can be served or leaked by a misconfiguration, while panel values cannot.

If you must upload a `.env`, confirm it is outside the document root, or that the web server refuses to serve dotfiles. A `.env` reachable at `https://yourdomain/.env` gives away the service-role key.

---

## 5. Verifying a deployment's configuration

After deploying, before announcing anything:

```bash
# 1. The process boots and reports its environment
curl -s https://yourdomain.com/health/live

# 2. The database is actually reachable (not just "the server is up")
curl -s https://yourdomain.com/health/ready
# expect: {"data":{"status":"ok","database":"reachable","latencyMs":N}}

# 3. The SPA is served
curl -sI https://yourdomain.com/ | head -1
# expect: HTTP/2 200

# 4. An API path is JSON, not HTML
curl -s https://yourdomain.com/api/v1/clients
# expect: {"error":{"code":"unauthorized",...}}   ← 401, and JSON

# 5. No secret reached the bundle
pnpm verify:secrets
```

`/health/ready` is the one that matters. `/health/live` only proves the process is running — it will happily return 200 while the database is unreachable.

---

## 6. Environment matrix

| Variable | Local dev | Production |
|---|---|---|
| `NODE_ENV` | `development` | `production` |
| `SUPABASE_URL` | `http://127.0.0.1:54321` | hosted URL |
| `CORS_ORIGINS` | `http://localhost:5173` | real origin |
| `JOB_HMAC_SECRET` | optional | **required** |
| `VITE_API_URL` | *(empty — Vite proxies)* | *(empty — same origin)* |
| `WEB_DIST_PATH` | *(empty)* | *(empty, or the uploaded path)* |
