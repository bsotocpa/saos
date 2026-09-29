#!/usr/bin/env bash
# THE CUTOVER-FACTS REHEARSAL ON A COPY OF PRODUCTION (Brian, 2026-09-29, R90).
#
# "Rehearse on the 2026-09-19 bundle with the two fields absent, to prove nothing breaks. The real
# rehearsal waits for the fresh bundle." Run from the checkout, after the R90 deploy, with the bundle
# directory as the one argument:
#
#   bash scripts/rehearse-cutover-facts.sh <bundle dir> [decisions.json]
#   (the 2026-09-19 bundle: /c/Users/brian/saos-imports/trello_import_v2/trello_import)
#
# What it does, in order, and nothing else:
#   1. ships the bundle to the box (our own server; no third party) under /opt/saos/imports/rehearsal;
#   2. copies production into saos_trello_copy (pg_dump | psql, the preflight's shape);
#   3. runs the DEPLOYED api image's matcher (with Brian's R24 decisions) and then its importer against
#      the copy (both refuse any database whose name does not end in _copy); the importer runs inside
#      its import context; keeps the counts;
#   4. drops the copy and deletes the bundle from the box, whatever happened.
# Prints the importer's count lines only; no row, name or file content leaves the box.
set -euo pipefail
BUNDLE="${1:?usage: rehearse-cutover-facts.sh <bundle dir> [decisions.json]}"
DECISIONS="${2:-/c/Users/brian/saos-imports/decisions.json}"
[ -f "$BUNDLE/04b_service_facts.csv" ] || { echo "rehearsal: no 04b_service_facts.csv in $BUNDLE" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IP="$(sed -n 's/^SERVER_IPV4=//p' "$ROOT/.env.production" | tr -d '[:space:]')"
SSH=(ssh -i "$HOME/.ssh/saos_hetzner_ed25519" -o BatchMode=yes "root@$IP")

echo "rehearsal: shipping the bundle's CSV files to the box..."
tar -C "$BUNDLE" -cf - $(cd "$BUNDLE" && ls *.csv) | "${SSH[@]}" 'rm -rf /opt/saos/imports/rehearsal && mkdir -p /opt/saos/imports/rehearsal/trello_import && tar -C /opt/saos/imports/rehearsal/trello_import -xf -'
if [ -f "$DECISIONS" ]; then "${SSH[@]}" 'cat > /opt/saos/imports/rehearsal/decisions.json' < "$DECISIONS"; fi

# The box's part goes up as a file and runs from there: fed to `bash -s`, its `docker exec -i` would
# swallow the rest of the script as its own stdin (the first rehearsal attempt, 2026-09-29).
"${SSH[@]}" 'cat > /opt/saos/imports/rehearsal/run.sh' <<'BOX'
set -euo pipefail
cd /opt/saos
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
PG_USER="$(sed -n 's/^POSTGRES_USER=//p' .env | tr -d '[:space:]')"; PG_USER="${PG_USER:-saos}"
PG_PASS="$(sed -n 's/^POSTGRES_PASSWORD=//p' .env | tr -d '[:space:]')"
PG_DB="$(sed -n 's/^POSTGRES_DB=//p' .env | tr -d '[:space:]')"; PG_DB="${PG_DB:-saos}"
COPY="saos_trello_copy"
PSQL=(docker exec -i saos-postgres-1 psql -U "$PG_USER" -v ON_ERROR_STOP=1 -q)
cleanup() {
  "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS ${COPY} WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf /opt/saos/imports/rehearsal
  echo "rehearsal: the copy is dropped and the bundle is deleted from the box."
}
trap cleanup EXIT
"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS ${COPY} WITH (FORCE)" >/dev/null
"${PSQL[@]}" -d postgres -c "CREATE DATABASE ${COPY} OWNER ${PG_USER}"
docker exec saos-postgres-1 pg_dump -U "$PG_USER" --no-owner --no-privileges "$PG_DB" | "${PSQL[@]}" -d "$COPY" >/dev/null
echo "rehearsal: production copied to ${COPY}; matching, then importing..."
$COMPOSE run --rm --no-deps -T -v /opt/saos/imports/rehearsal:/imports   -e TRELLO_IMPORT_DIR=/imports/trello_import -e TRELLO_DECISIONS_FILE=/imports/decisions.json   -e DATABASE_URL="postgresql://${PG_USER}:${PG_PASS}@postgres:5432/${COPY}"   api node --experimental-strip-types apps/api/scripts/trello-match.ts >/dev/null 2>&1   || { echo "rehearsal: RED — the matcher failed on the copy" >&2; exit 1; }
$COMPOSE run --rm --no-deps -T -v /opt/saos/imports/rehearsal:/imports \
  -e TRELLO_IMPORT_DIR=/imports/trello_import \
  -e DATABASE_URL="postgresql://${PG_USER}:${PG_PASS}@postgres:5432/${COPY}" \
  api node --experimental-strip-types apps/api/scripts/trello-import.ts 2>/dev/null \
  | grep -E '^(A|B|C|D) |R2[0-9]|R3[0-9]|R90|ALL FILES|04b|delta|refused|ledger|rerun|RERUN|zero' || true
BOX
"${SSH[@]}" 'bash /opt/saos/imports/rehearsal/run.sh'
