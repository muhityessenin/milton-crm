#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

die() {
  echo "Deployment failed: $*" >&2
  exit 1
}

for command_name in git docker flock; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is not installed."
done

docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is not installed."
docker info >/dev/null 2>&1 || die "the Docker daemon is not running or is not accessible."
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$ROOT_DIR is not a Git checkout."
git remote get-url origin >/dev/null 2>&1 || die "the Git remote 'origin' is not configured."

DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}"
DEPLOY_COMMIT="${DEPLOY_COMMIT:-}"
DEPLOY_VERSION="${DEPLOY_VERSION:-}"
DEPLOY_HISTORY_DIR="${DEPLOY_HISTORY_DIR:-$ROOT_DIR/.deployment-state}"

if [[ ! -f "$ENV_FILE" ]]; then
  die "missing $ENV_FILE. Copy .env.production.example and set the production passwords."
fi
if [[ -n "$(git status --porcelain)" ]]; then
  die "the server checkout contains uncommitted changes."
fi
if [[ "$(git branch --show-current)" != "$DEPLOY_BRANCH" ]]; then
  git switch "$DEPLOY_BRANCH"
fi

restore_checkout() {
  if [[ "$(git branch --show-current)" != "$DEPLOY_BRANCH" ]]; then
    git switch "$DEPLOY_BRANCH" >/dev/null
  fi
}
trap restore_checkout EXIT

echo "[1/4] Updating origin/$DEPLOY_BRANCH"
git pull --ff-only origin "$DEPLOY_BRANCH" || die "git pull failed. Check the deploy key and remote branch."

TARGET_COMMIT="$(git rev-parse HEAD)"

if [[ -n "$DEPLOY_COMMIT" ]]; then
  [[ "$DEPLOY_COMMIT" =~ ^[a-f0-9]{40}$ ]] || die "DEPLOY_COMMIT must be a full 40-character lowercase Git SHA."
  git cat-file -e "$DEPLOY_COMMIT^{commit}" 2>/dev/null || die "selected commit does not exist after updating origin/$DEPLOY_BRANCH."
  if [[ -n "$DEPLOY_VERSION" ]]; then
    [[ "$DEPLOY_VERSION" =~ ^[1-9][0-9]*$ ]] || die "DEPLOY_VERSION must be a positive integer."
    recorded_commit="$(awk -F '\t' -v wanted="$DEPLOY_VERSION" '$1 == wanted { found = $3 } END { if (found) print found }' "$DEPLOY_HISTORY_DIR/successful.tsv" 2>/dev/null || true)"
    [[ "$recorded_commit" == "$DEPLOY_COMMIT" ]] || die "selected version does not match the successful deployment history."
  else
    git merge-base --is-ancestor "$DEPLOY_COMMIT" "origin/$DEPLOY_BRANCH" || die "selected commit does not belong to origin/$DEPLOY_BRANCH."
  fi
  git cat-file -e "$DEPLOY_COMMIT:server/vps-deployment.js" 2>/dev/null || die "selected commit predates safe deployment status tracking."
  TARGET_COMMIT="$DEPLOY_COMMIT"
  echo "Deploying selected commit $DEPLOY_COMMIT"
  git switch --detach "$DEPLOY_COMMIT"
fi

record_successful_deployment() {
  local history_file="$DEPLOY_HISTORY_DIR/successful.tsv"
  local counter_file="$DEPLOY_HISTORY_DIR/last-version"
  local lock_file="$DEPLOY_HISTORY_DIR/history.lock"
  local temporary_file="$DEPLOY_HISTORY_DIR/successful.tsv.tmp.$$"
  local deployed_at cutoff deployed_epoch last_version next_version

  install -d -m 700 "$DEPLOY_HISTORY_DIR"
  exec 8>"$lock_file"
  flock 8

  deployed_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  cutoff="$(date -u -d '30 days ago' +%s)"
  : > "$temporary_file"
  if [[ -f "$history_file" ]]; then
    while IFS=$'\t' read -r version recorded_at commit; do
      [[ "$version" =~ ^[0-9]+$ && "$commit" =~ ^[a-f0-9]{40}$ ]] || continue
      deployed_epoch="$(date -u -d "$recorded_at" +%s 2>/dev/null || true)"
      [[ -n "$deployed_epoch" && "$deployed_epoch" -ge "$cutoff" ]] || continue
      printf '%s\t%s\t%s\n' "$version" "$recorded_at" "$commit" >> "$temporary_file"
    done < "$history_file"
  fi

  last_version="$(cat "$counter_file" 2>/dev/null || true)"
  if [[ ! "$last_version" =~ ^[0-9]+$ ]]; then
    last_version="$(awk -F '\t' '($1 + 0) > max { max = $1 + 0 } END { print max + 0 }' "$temporary_file")"
  fi
  next_version=$((last_version + 1))
  printf '%s\t%s\t%s\n' "$next_version" "$deployed_at" "$TARGET_COMMIT" >> "$temporary_file"
  mv "$temporary_file" "$history_file"
  printf '%s\n' "$next_version" > "$counter_file"
  chmod 600 "$history_file" "$counter_file" "$lock_file"
  echo "Application version $next_version recorded: $TARGET_COMMIT at $deployed_at"
}

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
    record_successful_deployment
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
