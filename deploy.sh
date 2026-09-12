#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

die() {
  echo "Deployment failed: $*" >&2
  exit 1
}

for command_name in git docker; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is not installed."
done

docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is not installed."
docker info >/dev/null 2>&1 || die "the Docker daemon is not running or is not accessible."
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$ROOT_DIR is not a Git checkout."
git remote get-url origin >/dev/null 2>&1 || die "the Git remote 'origin' is not configured."

DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}"

if [[ ! -f "$ENV_FILE" ]]; then
  die "missing $ENV_FILE. Copy .env.production.example and set the production passwords."
fi
if [[ -n "$(git status --porcelain)" ]]; then
  die "the server checkout contains uncommitted changes."
fi
if [[ "$(git branch --show-current)" != "$DEPLOY_BRANCH" ]]; then
  git switch "$DEPLOY_BRANCH"
fi

echo "[1/4] Pulling origin/$DEPLOY_BRANCH"
git pull --ff-only origin "$DEPLOY_BRANCH" || die "git pull failed. Check the deploy key and remote branch."

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

echo "[2/4] Validating $COMPOSE_FILE"
"${compose[@]}" config --quiet || die "Docker Compose configuration is invalid."

echo "[3/4] Building and recreating PostgreSQL, migrations, app, and proxy"
if ! "${compose[@]}" up -d --build --force-recreate --remove-orphans; then
  "${compose[@]}" logs --tail=200 db migrate app 2>/dev/null || true
  if [[ "$COMPOSE_FILE" == "compose.caddy.yaml" ]]; then
    "${compose[@]}" logs --tail=200 caddy 2>/dev/null || true
  fi
  die "docker compose up failed."
fi

container_id="$("${compose[@]}" ps -q app)"
[[ -n "$container_id" ]] || die "the app container was not created."

echo "[4/4] Waiting for the application health check"
for attempt in {1..60}; do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
  if [[ "$health" == "healthy" ]]; then
    "${compose[@]}" ps
    echo "Deployment complete: Milton CRM is healthy."
    exit 0
  fi
  if [[ "$health" == "unhealthy" || "$health" == "exited" ]]; then
    "${compose[@]}" logs --tail=200 db migrate app 2>/dev/null || true
    die "app container is $health."
  fi
  sleep 2
done

"${compose[@]}" logs --tail=200 db migrate app 2>/dev/null || true
die "application health check timed out."
