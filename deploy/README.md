# Deployment runbook

Build and test happen on GitHub Actions. The 1 GB VPS only runs pre-built
JavaScript; it never compiles TypeScript, runs the test suite, builds the web
app, or runs `pnpm install`.

```
GitHub Actions (CI)                         Vercel
  install --frozen-lockfile                   apps/web (auto deploy on push)
  contracts build
  api typecheck / test / build
  web typecheck / test / build
  package artifact  ---------------------.
                                          |
GitHub Actions (Deploy API)               v
  download artifact  ->  rsync  ->  /opt/seo-api/
                                      current -> releases/<release-id>
                                      restart seo-api + seo-worker
                                      health check, rollback on failure

Supabase (hosted)  <- migrations applied out of band, never by the pipeline
```

## Pipeline

- `ci.yml`: runs on pull requests and pushes to `main`. It installs with a
  frozen lockfile, builds contracts, then typechecks, tests and builds the API
  and the web app. On `main` it also packages and uploads the API artifact
  (`seo-api-artifact`, retained 14 days).
- `deploy.yml`: runs only after the `CI` workflow completes successfully on
  `main`. It downloads the artifact built by that exact run, uploads it to the
  VPS, and activates it. A failed build or test can never deploy.

The web app is deployed separately by Vercel; CI only gates it.

## Required GitHub secrets

Set these under Settings -> Secrets and variables -> Actions.

| Secret | Required | Purpose |
| --- | --- | --- |
| `VPS_HOST` | yes | VPS hostname or IP |
| `VPS_USER` | yes | SSH user used for deploy |
| `VPS_SSH_KEY` | yes | Private key for `VPS_USER` (PEM) |
| `VPS_PORT` | no | SSH port, default `22` |
| `VPS_KNOWN_HOSTS` | no | Pinned host key; otherwise `ssh-keyscan` |
| `VPS_SERVICE_USER` | no | Systemd service user, default `root` |
| `VPS_HEALTH_URL` | no | Default `http://127.0.0.1:3001/api/health` |

The `production` environment in `deploy.yml` can be used to require manual
approval before a deploy.

## Release layout on the VPS

```
/opt/seo-api/
  current -> releases/<release-id>
  releases/<release-id>/
    dist/index.js
    dist/worker.js
    node_modules/
    package.json
  incoming/<release-id>.tar.gz
  shared/
    .env
    logs/seo-api.log
    logs/seo-worker.log
  scripts/
    deploy-release.sh
```

`current` is switched with an atomic symlink replace. The artifact contains no
`.env`, no secrets, no TypeScript source and no test files. Secrets stay in
`shared/.env` (mode `600`) and are loaded by systemd only.

## One-time VPS setup

Run as root. Adjust `DEPLOY_ROOT` and `SERVICE_USER` if they differ from
`/opt/seo-api` and `root`.

```bash
DEPLOY_ROOT=/opt/seo-api
SERVICE_USER=root

mkdir -p "$DEPLOY_ROOT/releases" "$DEPLOY_ROOT/incoming" "$DEPLOY_ROOT/scripts" "$DEPLOY_ROOT/shared/logs"
chmod 700 "$DEPLOY_ROOT/shared"

# Copy the existing env file into the shared location (keep the repo copy until verified)
install -m 600 /opt/seo-api/repo/apps/api/.env "$DEPLOY_ROOT/shared/.env"

# When SERVICE_USER is root this is a no-op; keep it if you switch service users
chown -R "$SERVICE_USER" "$DEPLOY_ROOT/releases" "$DEPLOY_ROOT/incoming" "$DEPLOY_ROOT/scripts" "$DEPLOY_ROOT/shared"

# Install the rendered systemd units
DEPLOY_ROOT="$DEPLOY_ROOT" SERVICE_USER="$SERVICE_USER" bash deploy/systemd/install-units.sh

sudo systemctl enable seo-api seo-worker
```

Do not start the units yet: `current` does not exist until the first deploy.
The cutover below stops the old services and lets the first deploy start the
new ones.

No sudoers rule is needed when the deploy user is root; the scripts call
`systemctl` directly.

## Cutover from the existing config

The old deployment lives in `/opt/seo-api/repo` with units pointing at
`apps/api/dist/index.js`. The new layout is created alongside it and the old
checkout is left untouched until the new one is proven.

The units keep the same names (`seo-api`, `seo-worker`), so installing the new
definitions replaces the old ones. Do the install and the first deploy close
together so there is no window where a unit points at a missing `current`.

1. Inspect the current units and env first:
   ```bash
   systemctl cat seo-api seo-worker
   cat /etc/systemd/system/seo-api.service
   ```
2. Create the new layout, copy the env file and install the new units as above.
3. Stop the current services:
   ```bash
   sudo systemctl stop seo-api seo-worker
   ```
4. Trigger the `Deploy API` workflow. The first release populates
   `/opt/seo-api/current` and `deploy-release.sh` starts `seo-api` and
   `seo-worker` from the compiled `dist/`.
5. Verify health, status and logs:
   ```bash
   systemctl status seo-api seo-worker
   journalctl -u seo-api -n 50
   curl -fsS http://127.0.0.1:3001/api/health
   ```
6. Only after the new deployment is proven, remove the old `/opt/seo-api/repo`
   checkout and its files.

## Rollback

The activate step rolls back automatically: if the health check fails it points
`current` back at the previous release, restarts the services and exits non-zero
so the workflow fails visibly.

Manual rollback:

```bash
# newest release that is not active
DEPLOY_ROOT=/opt/seo-api bash /opt/seo-api/scripts/rollback-release.sh

# or an explicit release directory
DEPLOY_ROOT=/opt/seo-api bash /opt/seo-api/scripts/rollback-release.sh /opt/seo-api/releases/<release-id>
```

The deploy script keeps the last `KEEP_RELEASES` (default 3) releases and never
prunes `current` or the release it just rolled back from.

## Migrations

Migrations are deliberately not part of the deploy pipeline. The artifact is
pure code; a restart never changes the schema.

- Validate on a fresh local database before applying:
  ```bash
  pnpm db:migrate:local
  ```
- Apply to hosted Supabase manually, either by pasting the consolidated
  `dist/supabase-schema.sql` into the SQL editor and running only the new
  statements, or by applying the matching files under `supabase/migrations/`.
- Keep the RLS and smoke-test additions in `scripts/db-migrate-local.sh`.
- Never run destructive SQL against the shared hosted project.

## Memory

The VPS has 1 GB of RAM, so measure before adding limits. Builds run on CI now,
which is the largest saving.

Before a change:

```bash
free -h
ps aux --sort=-rss | head -20
systemctl show seo-api -p MemoryCurrent
```

After a restart:

```bash
free -h
ps -o pid,rss,cmd -C node
systemctl show seo-api -p MemoryCurrent
systemctl show seo-worker -p MemoryCurrent
```

Reference points measured while validating the artifact on a build host:

| Process | Resident memory |
| --- | --- |
| `dist/index.js` (API, idle after boot) | ~150 MB |
| `dist/worker.js` (worker, idle) | ~80 MB |
| artifact on disk | ~104 MB unpacked, 21 MB compressed |

Only after recording real VPS values should `MemoryMax=` be enabled in the unit
files. Start with a soft limit comfortably above the observed peak (for example
`512M`) and watch for OOM restarts with `systemctl status` and
`journalctl -u seo-api`.

## What must never run on the VPS

- `tsc`, `pnpm build`, full test suites, `vite build`
- `pnpm install` / `pnpm dev`
- `git pull`
- migrations
