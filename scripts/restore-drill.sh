#!/usr/bin/env bash
# SAOS restore drill (M21). Proves the backups actually restore: pulls the
# LATEST restic snapshot, stands up a CLEAN postgres+minio stack (separate
# compose project, fresh volumes), restores into it, and verifies row counts
# and object counts against the manifest captured at backup time.
#
# Run it quarterly (the daily job nags when it's overdue). After a passing
# drill, record the date in Admin -> Settings -> ops.last_restore_drill_at.
#
# Required environment:
#   RESTIC_REPOSITORY / RESTIC_PASSWORD   (+ B2_ACCOUNT_ID/B2_ACCOUNT_KEY for b2:)
#   DRILL_DIR    Scratch dir for the restored files — outside any synced folder.
#
# Optional:
#   KEEP_DRILL_STACK=1   Leave the drill stack running for manual inspection
#                        (tear down later: docker compose -p saos-restore-drill down -v)
set -uo pipefail

export MSYS_NO_PATHCONV=1

RESTIC_IMAGE="restic/restic:0.19.1"
BUCKETS="saos-documents saos-returns saos-signed-docs saos-recordings"
PROJECT="saos-restore-drill"
PGUSER="${POSTGRES_USER:-saos}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

fail() { echo "drill: ERROR: $*" >&2; exit 1; }

[ -n "${RESTIC_REPOSITORY:-}" ] || fail "RESTIC_REPOSITORY is required."
[ -n "${RESTIC_PASSWORD:-}" ] || fail "RESTIC_PASSWORD is required."
[ -n "${DRILL_DIR:-}" ] || fail "DRILL_DIR is required and must be outside any synced folder."
case "$DRILL_DIR" in
  "$REPO_DIR"*) fail "DRILL_DIR is inside the repo — the repo syncs to Dropbox. Pick a path outside it." ;;
esac

restic_run() {
  case "$RESTIC_REPOSITORY" in
    b2:*)
      docker run --rm -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY \
        -v "$DRILL_DIR:/restore" "$RESTIC_IMAGE" "$@"
      ;;
    *)
      docker run --rm -e RESTIC_REPOSITORY=/repo -e RESTIC_PASSWORD \
        -v "$RESTIC_REPOSITORY:/repo:ro" -v "$DRILL_DIR:/restore" "$RESTIC_IMAGE" "$@"
      ;;
  esac
}
# Relative -f paths (with cwd pinned to the repo): absolute MSYS paths would
# reach docker.exe unconverted under MSYS_NO_PATHCONV and not resolve.
drill() { (cd "$REPO_DIR" && docker compose -p "$PROJECT" -f docker-compose.yml -f scripts/compose.restore-drill.yml "$@"); }

set -e
rm -rf "$DRILL_DIR"
mkdir -p "$DRILL_DIR"

echo "drill: [1/5] restoring latest snapshot from $RESTIC_REPOSITORY..."
# --no-lock: the drill only READS the repository (the local mount is :ro and
# the B2 key can be a read-only application key) — restoring must not need
# write access to the thing it is verifying.
restic_run restore latest --target /restore --quiet --no-lock
DATA="$DRILL_DIR/data"   # snapshots were taken of /data
[ -f "$DATA/manifest.tsv" ] || fail "restored snapshot has no manifest.tsv — was it made by scripts/backup.sh?"
[ -s "$DATA/postgres/dumpall.sql.gz" ] || fail "restored snapshot has no postgres dump."

echo "drill: [2/5] booting a CLEAN stack (project $PROJECT, fresh volumes)..."
drill down -v --remove-orphans >/dev/null 2>&1 || true
drill up -d --quiet-pull postgres minio
for i in $(seq 1 30); do
  drill exec -T postgres pg_isready -U "$PGUSER" -d postgres >/dev/null 2>&1 && break
  [ "$i" = 30 ] && fail "drill postgres never became ready."
  sleep 2
done

echo "drill: [3/5] restoring PostgreSQL (pg_dumpall)..."
# Roles that already exist in a fresh cluster produce ignorable errors; the
# count verification below is what decides pass/fail.
gunzip -c "$DATA/postgres/dumpall.sql.gz" | drill exec -T postgres psql -U "$PGUSER" -d postgres -q >/dev/null

echo "drill: [4/5] restoring MinIO buckets..."
drill run --rm --no-deps -v "$DATA/minio:/staging" --entrypoint /bin/sh minio-init -c "
  mc alias set dst http://minio:9000 \"\${MINIO_ROOT_USER:-saos}\" \"\${MINIO_ROOT_PASSWORD:-saos_dev_password}\" >/dev/null &&
  for b in $BUCKETS; do
    mc mb --ignore-existing dst/\$b >/dev/null &&
    { [ -d /staging/\$b ] && mc mirror --overwrite --quiet /staging/\$b dst/\$b || true; }
  done
"

echo "drill: [5/5] verifying against the backup-time manifest..."
set +e
PASS=0; FAILED=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then
    echo "drill:   PASS  $1  ($2)"
    PASS=$((PASS + 1))
  else
    echo "drill:   FAIL  $1  expected=$2 restored=$3"
    FAILED=$((FAILED + 1))
  fi
}

# NB: inner docker commands read from /dev/null so they can't consume the
# while-loop's stdin (the manifest itself).
while IFS="$(printf '\t')" read -r key expected; do
  case "$key" in
    table:*)
      tbl="${key#table:}"
      actual="$(drill exec -T postgres psql -U "$PGUSER" -d saos -tA -c "SELECT count(*) FROM ${tbl}" </dev/null 2>/dev/null | tr -d '[:space:]')"
      check "$key" "$expected" "${actual:-QUERY_FAILED}"
      ;;
    bucket:*)
      b="${key#bucket:}"
      actual="$(drill run --rm --no-deps --entrypoint /bin/sh minio-init -c "
        mc alias set dst http://minio:9000 \"\${MINIO_ROOT_USER:-saos}\" \"\${MINIO_ROOT_PASSWORD:-saos_dev_password}\" >/dev/null &&
        mc ls -r dst/$b | wc -l" </dev/null 2>/dev/null | tr -d '[:space:]')"
      check "$key" "$expected" "${actual:-LIST_FAILED}"
      ;;
  esac
done < "$DATA/manifest.tsv"

# Volume tarballs: integrity check (they restore by untarring into a fresh
# volume). --force-local: GNU tar would otherwise read the colon in Windows
# paths (C:/...) as a remote host:file spec.
for t in "$DATA"/volumes/*.tar.gz; do
  [ -e "$t" ] || continue
  if tar --force-local -tzf "$t" >/dev/null 2>&1; then
    echo "drill:   PASS  volume-archive:$(basename "$t")"
    PASS=$((PASS + 1))
  else
    echo "drill:   FAIL  volume-archive:$(basename "$t") is not a readable tar.gz"
    FAILED=$((FAILED + 1))
  fi
done

if [ "${KEEP_DRILL_STACK:-0}" = "1" ]; then
  echo "drill: KEEP_DRILL_STACK=1 — drill stack left running (postgres :${DRILL_POSTGRES_PORT:-7432}, minio :${DRILL_MINIO_PORT:-11000})."
else
  drill down -v >/dev/null 2>&1
fi
rm -rf "$DRILL_DIR"

echo "drill: ---------------------------------------------"
if [ "$FAILED" -eq 0 ] && [ "$PASS" -gt 0 ]; then
  echo "drill: RESTORE DRILL PASSED ($PASS checks)."
  echo "drill: Record it: Admin -> Settings -> ops.last_restore_drill_at = $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 0
fi
echo "drill: RESTORE DRILL FAILED ($FAILED of $((PASS + FAILED)) checks failed)."
exit 1
