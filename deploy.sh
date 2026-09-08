#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}"
if [[ "${ENABLE_CADDY:-false}" == "true" ]]; then
  COMPOSE_FILE="compose.caddy.yaml"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy .env.production.example and set the production passwords." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Deployment stopped: the server checkout contains uncommitted changes." >&2
  exit 1
fi
if [[ "$(git branch --show-current)" != "$DEPLOY_BRANCH" ]]; then
  git switch "$DEPLOY_BRANCH"
fi

echo "Updating origin/$DEPLOY_BRANCH"
git fetch origin "$DEPLOY_BRANCH"
git pull --ff-only origin "$DEPLOY_BRANCH"

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
echo "Rebuilding and recreating Milton CRM"
"${compose[@]}" up -d --build --force-recreate --remove-orphans

container_id="$("${compose[@]}" ps -q app)"
for attempt in {1..30}; do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
  if [[ "$health" == "healthy" ]]; then
    echo "Deployment complete: Milton CRM is healthy."
    exit 0
  fi
  if [[ "$health" == "unhealthy" || "$health" == "exited" ]]; then
    "${compose[@]}" logs --tail=100 app
    echo "Deployment failed: app container is $health." >&2
    exit 1
  fi
  sleep 2
done

"${compose[@]}" logs --tail=100 app
echo "Deployment failed: health check timed out." >&2
exit 1
