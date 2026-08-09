#!/usr/bin/env bash
# SAOS encrypted backup (M21). Dumps PostgreSQL, mirrors the MinIO buckets,
# tars the stateful service volumes, then ships everything to a restic
# repository — encrypted client-side by restic (AES-256) before a single
# byte leaves the box. Backblaze B2 is the production target (approved
# vendor); a local directory repo works for dev and for restore drills.
#
# Required environment:
#   BACKUP_STAGING_DIR   Working dir for the dump/mirror. MUST be outside any
#                        synced folder (Dropbox!) — it briefly holds client
#                        data in the clear. On the server: /var/lib/saos/backup-staging
#   RESTIC_REPOSITORY    'b2:<bucket>:<path>' for production, or a local dir
#                        (absolute path) for dev/drills.
#   RESTIC_PASSWORD      The backup encryption key. Store it in Vaultwarden —
#                        losing it means losing every backup.
#   B2_ACCOUNT_ID / B2_ACCOUNT_KEY   Only when RESTIC_REPOSITORY is b2:...
#
# Optional:
#   COMPOSE_PROJECT      Compose project to back up (default: saos)
#   POSTGRES_USER        default: saos
#   BACKUP_STATUS_PATH   Machine-readable result for the WISP export
#                        (default: ./backups/status.json next to this repo)
#
# Cron (production, from the repo checkout):
#   15 2 * * *  cd /opt/saos && ./scripts/backup.sh >> /var/log/saos-backup.log 2>&1
set -euo pipefail

# Git Bash (Windows) rewrites container-side paths like /data into Windows
# paths unless told not to. No-op elsewhere.
export MSYS_NO_PATHCONV=1

# Load ENV_FILE (default: /opt/saos/.env when present, i.e. cron on the
# server). Parsed literally, line by line — NEVER `source`d: dotenv values
# aren't shell, and the file may carry a UTF-8 BOM. Existing environment wins.
ENV_FILE="${ENV_FILE:-}"
[ -z "$ENV_FILE" ] && [ -f /opt/saos/.env ] && ENV_FILE=/opt/saos/.env
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#$'\xEF\xBB\xBF'}"
    line="${line%$'\r'}"
    case "$line" in ''|\#*) continue ;; esac
    case "$line" in
      [A-Za-z_]*=*)
        key="${line%%=*}"
        [ -n "${!key:-}" ] || export "$key=${line#*=}"
        ;;
    esac
  done < "$ENV_FILE"
fi

RESTIC_IMAGE="restic/restic:0.19.1"
TAR_IMAGE="alpine:3.23"
BUCKETS="saos-documents saos-returns saos-signed-docs saos-recordings"
VOLUME_SUFFIXES="docuseal_data vaultwarden_data uptime_kuma_data ntfy_data"

PROJECT="${COMPOSE_PROJECT:-saos}"
PGUSER="${POSTGRES_USER:-saos}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATUS_PATH="${BACKUP_STATUS_PATH:-$REPO_DIR/backups/status.json}"

fail() { echo "backup: ERROR: $*" >&2; exit 1; }

[ -n "${BACKUP_STAGING_DIR:-}" ] || fail "BACKUP_STAGING_DIR is required and must be OUTSIDE any synced folder (it stages client data in the clear)."
[ -n "${RESTIC_REPOSITORY:-}" ] || fail "RESTIC_REPOSITORY is required (b2:<bucket>:<path> or a local directory)."
[ -n "${RESTIC_PASSWORD:-}" ] || fail "RESTIC_PASSWORD is required (the backup encryption key — keep it in Vaultwarden)."
case "$BACKUP_STAGING_DIR" in
  "$REPO_DIR"*) fail "BACKUP_STAGING_DIR is inside the repo — the repo syncs to Dropbox. Pick a path outside it." ;;
esac

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_EPOCH="$(date +%s)"
STAGING="$BACKUP_STAGING_DIR/current"
rm -rf "$STAGING"
mkdir -p "$STAGING/postgres" "$STAGING/minio" "$STAGING/volumes"

compose() { docker compose -p "$PROJECT" "$@"; }

echo "backup: [1/5] pg_dumpall from project '$PROJECT'..."
# --clean --if-exists makes the restore idempotent on a non-virgin cluster;
# test databases are ephemeral by definition and excluded.
compose exec -T postgres pg_dumpall -U "$PGUSER" --clean --if-exists \
  --exclude-database='saos_api_test_*' | gzip > "$STAGING/postgres/dumpall.sql.gz"
[ -s "$STAGING/postgres/dumpall.sql.gz" ] || fail "pg_dumpall produced no output."

echo "backup: [2/5] mirroring MinIO buckets..."
# One-shot mc on the stack's network. --remove keeps the mirror exact so the
# restic snapshot reflects deletions too.
compose run --rm --no-deps -v "$STAGING/minio:/staging" --entrypoint /bin/sh minio-init -c "
  mc alias set src http://minio:9000 \"\${MINIO_ROOT_USER:-saos}\" \"\${MINIO_ROOT_PASSWORD:-saos_dev_password}\" >/dev/null &&
  for b in $BUCKETS; do
    mkdir -p /staging/\$b
    mc mirror --overwrite --remove --quiet src/\$b /staging/\$b || exit 1
  done
"

echo "backup: [3/5] archiving service volumes..."
for suffix in $VOLUME_SUFFIXES; do
  vol="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | grep "saos_${suffix}\$" || true)"
  if [ -n "$vol" ]; then
    docker run --rm -v "$vol:/vol:ro" -v "$STAGING/volumes:/backup" "$TAR_IMAGE" \
      tar czf "/backup/${suffix}.tar.gz" -C /vol .
  else
    echo "backup:   volume *saos_${suffix} not found — skipping (service not deployed here)."
  fi
done

echo "backup: [4/5] writing verification manifest..."
# Row counts the restore drill re-checks after restoring to a clean stack.
compose exec -T postgres psql -U "$PGUSER" -d saos -tA -F "$(printf '\t')" -c "
  SELECT 'table:contacts', count(*) FROM contacts
  UNION ALL SELECT 'table:engagements', count(*) FROM engagements
  UNION ALL SELECT 'table:documents', count(*) FROM documents
  UNION ALL SELECT 'table:audit_log', count(*) FROM audit_log
  UNION ALL SELECT 'table:price_book_items', count(*) FROM price_book_items
  UNION ALL SELECT 'table:templates', count(*) FROM templates
  UNION ALL SELECT 'table:invoices', count(*) FROM invoices
" > "$STAGING/manifest.tsv"
for b in $BUCKETS; do
  n="$(find "$STAGING/minio/$b" -type f 2>/dev/null | wc -l | tr -d ' ')"
  printf 'bucket:%s\t%s\n' "$b" "$n" >> "$STAGING/manifest.tsv"
done
sed 's/\t/  /' "$STAGING/manifest.tsv" | sed 's/^/backup:   /'

echo "backup: [5/5] restic snapshot -> $RESTIC_REPOSITORY"
restic_run() {
  case "$RESTIC_REPOSITORY" in
    b2:*)
      docker run --rm -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY \
        -v "$STAGING:/data:ro" "$RESTIC_IMAGE" "$@"
      ;;
    *)
      mkdir -p "$RESTIC_REPOSITORY"
      docker run --rm -e RESTIC_REPOSITORY=/repo -e RESTIC_PASSWORD \
        -v "$RESTIC_REPOSITORY:/repo" -v "$STAGING:/data:ro" "$RESTIC_IMAGE" "$@"
      ;;
  esac
}
restic_run cat config >/dev/null 2>&1 || restic_run init
SNAPSHOT_JSON="$(restic_run backup /data --tag saos --json | tail -n 1)"
SNAPSHOT_ID="$(printf '%s' "$SNAPSHOT_JSON" | sed -n 's/.*"snapshot_id":"\([^"]*\)".*/\1/p')"
[ -n "$SNAPSHOT_ID" ] || fail "restic did not report a snapshot id. Last line: $SNAPSHOT_JSON"
# Retention: 2 weeks daily, 2 months weekly, 1 year monthly.
restic_run forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune --quiet

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DURATION=$(( $(date +%s) - START_EPOCH ))
REPO_KIND="local"
case "$RESTIC_REPOSITORY" in b2:*) REPO_KIND="b2" ;; esac

mkdir -p "$(dirname "$STATUS_PATH")"
{
  echo '{'
  echo "  \"last_backup_at\": \"$FINISHED_AT\","
  echo "  \"started_at\": \"$STARTED_AT\","
  echo "  \"duration_seconds\": $DURATION,"
  echo "  \"snapshot_id\": \"$SNAPSHOT_ID\","
  echo "  \"repository_kind\": \"$REPO_KIND\","
  echo "  \"retention\": \"14 daily / 8 weekly / 12 monthly\","
  echo '  "counts": {'
  awk -F '\t' '{ printf "%s    \"%s\": %s", sep, $1, $2; sep = ",\n" } END { print "" }' sep='' "$STAGING/manifest.tsv"
  echo '  }'
  echo '}'
} > "$STATUS_PATH"

# The staging dir held client data in the clear — remove it now that the
# encrypted snapshot exists.
rm -rf "$STAGING"

echo "backup: OK — snapshot $SNAPSHOT_ID ($REPO_KIND repo, ${DURATION}s). Status: $STATUS_PATH"
