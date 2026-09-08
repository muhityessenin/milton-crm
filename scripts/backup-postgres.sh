#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

BACKUP_DIR="${BACKUP_DIR:-/opt/backups/milton-crm}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
install -d -m 700 "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/milton-$timestamp.dump"
temporary="$target.partial"
compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

"${compose[@]}" exec -T db pg_dump \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --format custom \
  --compress 6 \
  --no-owner \
  --no-privileges > "$temporary"

"${compose[@]}" exec -T db pg_restore --list < "$temporary" >/dev/null
chmod 600 "$temporary"
mv "$temporary" "$target"
find "$BACKUP_DIR" -type f -name 'milton-*.dump' -mtime "+$BACKUP_RETENTION_DAYS" -delete

echo "Backup created and verified: $target"
echo "Copy it to encrypted storage outside this VPS."
