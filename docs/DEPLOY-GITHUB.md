# GitHub Deployment Guide

Two things live here: getting the repository into GitHub safely, and a CI pipeline that catches the failures this project actually has — not a generic lint-and-test template.

---

## 1. Before the first push: prove no secret is in the history

A secret committed once is compromised forever. Deleting the file in a later commit does nothing — it stays in the object history and in every clone, fork and CI cache.

```bash
# 1. Is anything sensitive tracked RIGHT NOW?
git status --short
git ls-files | grep -iE '\.env$|\.pem$|\.key$|secret|credential'
# expect: nothing except .env.example files

# 2. What does .gitignore actually cover?
cat .gitignore | grep -E 'env|node_modules|dist'
```

Required `.gitignore` entries:

```
node_modules/
dist/
dist-hostinger/
.env
.env.local
*.local
supabase/.branches/
supabase/.temp/
```

`.env.example` files **are** committed on purpose — they document the shape without the values.

### If a secret was already committed

Rotate it first, then clean history. Cleaning history without rotating leaves a live credential in every existing clone.

```bash
# Rotate in Supabase: Project Settings → API → regenerate the service_role key.

# Then rewrite history (requires git-filter-repo)
git filter-repo --path apps/api/.env --invert-paths
git push --force --all
```

Force-pushing rewrites shared history. Coordinate with anyone who has cloned the repo — their copies will diverge.

---

## 2. Create the repository

```bash
git init
git add .
git commit -m "Initial commit: Trivero Marketing CRM"

# Create an empty repo on GitHub first (no README, no .gitignore — this repo has both)
git remote add origin git@github.com:YOUR-ORG/trivero-crm.git
git branch -M main
git push -u origin main
```

Use SSH, not HTTPS with an embedded token. A token in `.git/config` is a credential in a file that gets copied around.

---

## 3. Branch model

| Branch | Purpose | Deploys to |
|---|---|---|
| `main` | Always deployable | Production |
| `dev` | Integration | Staging (optional) |
| `feature/*` | Work in progress | — |

Protect `main`: require a pull request, require the CI check to pass, and disallow force pushes. Without the last rule, a force push can silently discard commits.

---

## 4. CI pipeline

Save as `.github/workflows/ci.yml`. This runs the checks that have actually caught defects in this project.

```yaml
name: CI

on:
  push:
    branches: [main, dev]
  pull_request:
    branches: [main, dev]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 12

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm typecheck

      # The @crm/shared package must be built before anything imports it, and a
      # production build is the only thing that proves the artifact is runnable.
      - name: Build
        run: pnpm build

      - name: Unit tests
        run: pnpm test

      # Fails if a server-only secret reached the browser bundle. This is a hard
      # security gate, not a warning: a service-role key in the bundle is a full
      # database compromise.
      - name: No secrets in the bundle
        run: pnpm verify:secrets

      # Proves the deployable artifact boots. This step exists because a bundle was
      # once produced that could not start (workspace resolution, then an ESM font
      # import) — none of which typecheck or unit tests can see.
      - name: Deployment artifact boots
        run: pnpm build:hostinger
```

### Integration tests need a database

The API suites require a running Supabase stack. Add a job that provisions one:

```yaml
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 12 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }

      - run: pnpm install --frozen-lockfile

      - uses: supabase/setup-cli@v1
        with: { version: latest }

      - name: Start Supabase
        run: supabase start

      - name: Apply migrations and seed
        run: supabase db reset

      - run: pnpm build

      - name: Start API
        run: |
          pnpm --filter @crm/api start &
          npx wait-on http://127.0.0.1:3000/health/ready --timeout 120000

      - name: API suites
        run: pnpm verify:all
```

`wait-on /health/ready`, not `/health/live`. The former proves the database connection works; the latter returns 200 even when the database is unreachable.

---

## 5. CD: deploy on merge to main

Hostinger accepts uploads over SSH/SFTP, so the pipeline builds the verified artifact and rsyncs it.

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    needs: verify          # never deploy an artifact that failed verification
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 12 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile

      - name: Build the deployment artifact
        run: pnpm build:hostinger

      - name: Install rsync
        run: sudo apt-get update && sudo apt-get install -y rsync

      - name: Upload
        env:
          SSH_KEY: ${{ secrets.HOSTINGER_SSH_KEY }}
          HOST: ${{ secrets.HOSTINGER_HOST }}
          USER: ${{ secrets.HOSTINGER_USER }}
          TARGET: ${{ secrets.HOSTINGER_PATH }}
        run: |
          mkdir -p ~/.ssh
          echo "$SSH_KEY" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          ssh-keyscan -H "$HOST" >> ~/.ssh/known_hosts
          # --delete removes stale hashed assets; without it old bundles accumulate
          rsync -avz --delete -e "ssh -i ~/.ssh/deploy_key" \
            dist-hostinger/ "$USER@$HOST:$TARGET/"

      - name: Verify the deployment is live and healthy
        run: |
          # A deploy that uploaded fine but cannot reach the database is not a
          # successful deploy. Fail the job rather than reporting green.
          curl -fsS https://yourdomain.com/health/ready \
            | grep -q '"database":"reachable"'
```

### Repository secrets to add

GitHub → **Settings → Secrets and variables → Actions**:

| Secret | What |
|---|---|
| `HOSTINGER_SSH_KEY` | private key for a **deploy-only** key pair |
| `HOSTINGER_HOST` | server hostname |
| `HOSTINGER_USER` | SSH user |
| `HOSTINGER_PATH` | absolute path to the app directory |

Never add `SUPABASE_SERVICE_ROLE_KEY` to GitHub if it is not needed there. It is only needed on the server, where it already lives in Hostinger's panel.

Generate a dedicated deploy key rather than reusing a personal one:

```bash
ssh-keygen -t ed25519 -C "github-deploy" -f ./deploy_key -N ""
# Add deploy_key.pub to the server's ~/.ssh/authorized_keys
# Add deploy_key (private) to GitHub secrets
```

---

## 6. What CI must never do

- **Never print environment values.** `echo $SUPABASE_SERVICE_ROLE_KEY` in a workflow is visible in logs to anyone with repo access and often in error reports.
- **Never run `supabase db reset` against a hosted project.** It drops the database.
- **Never deploy on a failing `verify`.** `needs: verify` enforces this; deleting it to "unblock a release" is how a broken build reaches production.
- **Never commit `.env`.** Rotate if it happens; do not merely delete.

---

## 7. Release checklist

- [ ] `pnpm verify:all` passes locally
- [ ] `pnpm build:hostinger` finishes `15 passed, 0 failed`
- [ ] No secret in `git status` or `git log -p`
- [ ] Database migrations applied **before** the code deploy
- [ ] A backup exists and is restorable (`DATABASE-BACKUP.md`)
- [ ] CI green on the PR
- [ ] Post-deploy: `/health/ready` reports `reachable`
- [ ] Post-deploy: sign-in, dashboard, one invoice PDF
