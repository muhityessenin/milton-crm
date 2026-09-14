# Milton CRM VPS deployment

The frontend and HTTP API are deployed together: `server.js` serves the static
files in `public/` and the `/api` routes. PostgreSQL runs in a separate `db`
container on the same private Compose network. Its port is not published.

## 1. Prepare the cloud server once

Install Git, Docker Engine, and the Docker Compose plugin. Create a dedicated
non-root deploy user, add it to the Docker group, and clone the `main` branch:

```bash
git clone --branch main YOUR_PRIVATE_REPOSITORY_URL /opt/milton-crm
cd /opt/milton-crm
cp .env.production.example .env.production
chmod 600 .env.production
```

Replace the `POSTGRES_PASSWORD` and `PGPASSWORD` placeholders with the same
long, random database password. Set a different strong
`INITIAL_ADMIN_PASSWORD`; it is used only when the database has no users.
This file is ignored by Git and excluded from the Docker build context.
After the first successful login, change the Owner password in the CRM profile;
later deployments skip bootstrap as soon as any user exists.

For temporary direct access on port 4173, allow that port in the cloud firewall
and run:

```bash
./deploy.sh
```

For production, point the domain's A/AAAA record to the server, allow TCP 80/443
and UDP 443, keep PostgreSQL port 5432 closed, and set
`DOMAIN=crm.example.com` in `.env.production`. A manual deployment is then:

```bash
git pull --ff-only origin main
docker compose --env-file .env.production -f compose.caddy.yaml up -d --build --force-recreate --remove-orphans
```

The `migrate` one-shot service is part of the normal Compose dependency graph.
It waits for PostgreSQL, applies pending migrations, and bootstraps only an empty
database. The app starts only after that service succeeds. Therefore the two
commands above are sufficient; do not run migrations separately.

## 2. Connect GitHub to the server

Add these GitHub Actions secrets in **Repository → Settings → Secrets and
variables → Actions**:

- `DEPLOY_HOST`: server hostname or IP;
- `DEPLOY_USER`: dedicated deploy user;
- `DEPLOY_PORT`: SSH port, normally `22`;
- `DEPLOY_PATH`: `/opt/milton-crm`;
- `DEPLOY_SSH_KEY`: private half of a dedicated deployment SSH key;
- `DEPLOY_KNOWN_HOSTS`: the verified `known_hosts` line for the server.

Add the public half of the key to the deploy user's
`~/.ssh/authorized_keys`. The workflow `.github/workflows/deploy-develop.yml`
runs after a push to `main` and calls `deploy.sh` over SSH.

The server checkout also needs read access to the GitHub repository. For a
private repository, add a separate read-only GitHub deploy key to the repository
and configure it for the deploy user. Do not reuse the server-login private key.

## 3. What deploy.sh does

1. Refuses to overwrite uncommitted server-side changes.
2. Fetches and fast-forwards from `origin/main`.
3. Rebuilds and force-recreates the complete Compose stack.
4. Waits until PostgreSQL reports healthy.
5. Runs the one-shot `migrate` service to apply migrations and bootstrap only an
   empty database.
6. Starts the app only after database preparation succeeds.
7. Waits for `/api/health` to become healthy.

The app container runs as a non-root user with a read-only filesystem. Client
data is stored in the named `postgres_data` volume. Paid-trial receipt files are
stored separately in the named `receipt_files` volume; PostgreSQL stores only
their protected metadata/reference. Both volumes survive app rebuilds/restarts.

The PostgreSQL read model stays hot while its `LISTEN/NOTIFY` change feed is
connected and is invalidated immediately after committed changes. If the change
feed reconnects, the cache is discarded and the configured
`PG_STATE_CACHE_TTL_MS` (5000 ms by default) is used as the safety fallback.
Time-based notification maintenance is coalesced and limited to once per user
per 30 seconds, avoiding four repeated maintenance queries on rapid refreshes.

Profile photos and the company logo remain in PostgreSQL for compatibility,
but API payloads expose versioned media URLs instead of repeating base64 data.
JSON, JavaScript, and CSS responses support gzip. Static assets use ETag
revalidation, so a deploy is visible immediately while unchanged files return
`304 Not Modified` instead of being downloaded again.

## Owner publication panel

Only the global Owner can see or call the publication panel. Add these values
to the existing `.env.production` before rebuilding the app:

```bash
VPS_DEPLOY_HOST=YOUR_VPS_IP
VPS_DEPLOY_PORT=22
VPS_DEPLOY_USER=ubuntu
VPS_DEPLOY_PASSWORD=YOUR_VPS_LOGIN_PASSWORD
VPS_DEPLOY_HOST_FINGERPRINT=SHA256:YOUR_ED25519_HOST_FINGERPRINT
VPS_DEPLOY_PATH=/opt/milton-crm
```

Read the VPS fingerprint on the VPS itself with:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'
```

The backend verifies this fingerprint before sending the password. Clicking
**Опубликовать** starts `COMPOSE_FILE=compose.yaml ./deploy.sh` as a detached
job. Its status and log live under `/tmp/milton-crm-deployments`, so the browser
can reconnect and keep polling after the app container recreates itself.

**Детальный деплой** fetches up to 30 recent commits from `origin/main` and
shows each commit's date, time, author, SHA, and message. The selected full SHA
is validated on the backend and again on the VPS: it must be an ancestor of
`origin/main`. `deploy.sh` temporarily checks out that commit, rebuilds the
stack, and restores the server checkout to `main` when it finishes.

## Backups

Create a verified PostgreSQL dump and matching encrypted-ready receipt archive:

```bash
./scripts/backup-postgres.sh
```

Schedule it as the deploy user, for example every night, and monitor its exit
status. The default retention is 14 days. A backup on the same VPS is not enough:
copy both generated files (`.dump` and `.receipts.tar.gz`) to encrypted storage
outside the VPS. Restore automatically uses the matching receipt archive when
it is next to the selected dump.

Test restoration periodically on a staging stack. Restoring production is
destructive and therefore requires an explicit guard:

```bash
ALLOW_DATABASE_RESTORE=YES ./scripts/restore-postgres.sh /absolute/path/to/milton.dump
```

For stricter recovery-point objectives, add PostgreSQL WAL archiving/PITR after
the basic dump-and-restore procedure is operational.

## Operations

```bash
docker compose ps
docker compose logs -f --tail=200 app
docker compose logs -f --tail=200 db
docker compose restart app
docker compose exec db pg_isready -U milton -d milton
```

With Caddy, add `-f compose.caddy.yaml --env-file .env.production` to manual
Compose commands.

## Rollback

Application rollback can be started from **Детальный деплой** by selecting a
previously verified commit. Database migrations are forward-only; create and
copy a verified backup before every destructive future migration. The current
migrations are additive and `deploy.sh` never deletes business data.

## Capacity target

The defaults target approximately 20 active users with headroom for 50 on a VPS
with at least 4 vCPU, 4 GB RAM, SSD/NVMe storage, and adequate free disk space.
The app is capped at 768 MB and PostgreSQL at 2 GB by default. Adjust these values
only after observing memory, CPU, query latency, connection usage, and disk I/O.
