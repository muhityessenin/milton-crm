#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${ALLOW_DATABASE_RESTORE:-}" != "YES" ]]; then
  echo "Restore replaces the current CRM database." >&2
  echo "Run with ALLOW_DATABASE_RESTORE=YES after stopping user traffic." >&2
  exit 1
fi
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: ALLOW_DATABASE_RESTORE=YES $0 /absolute/path/to/milton.dump" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}"
source_file="$1"
receipt_source="${source_file%.dump}.receipts.tar.gz"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi
set -a
source "$ENV_FILE"
set +a

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
"${compose[@]}" exec -T db pg_restore --list < "$source_file" >/dev/null
"${compose[@]}" stop app
"${compose[@]}" exec -T db pg_restore \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges < "$source_file"
if [[ -f "$receipt_source" ]]; then
  tar -tzf "$receipt_source" >/dev/null
  "${compose[@]}" run --rm --no-deps -T --entrypoint sh app -c "find /app/uploads -mindepth 1 -delete && tar -C /app/uploads -xzf -" < "$receipt_source"
else
  echo "Warning: matching receipt archive not found: $receipt_source" >&2
fi
"${compose[@]}" up -d app

echo "Restore completed and application restarted."
