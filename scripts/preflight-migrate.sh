#!/usr/bin/env bash
# PREFLIGHT: run the pending migrations against a COPY of the production database before they
# touch production (Brian, 2026-09-14, ruling 2). A fresh database never has the row that breaks
# an update; migration 0103 passed every test and failed on the box for exactly that reason.
#
# Runs ON THE BOX from /opt/saos, with the images already built and the old containers still
# serving. Copies schema and rows (pg_dump | psql, the database is small), points the new api
# image's migrate at the copy, and exits non-zero if any migration fails. The copy is dropped
# either way. Nothing here touches the production database.
set -euo pipefail
cd /opt/saos
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
PG_USER="$(sed -n 's/^POSTGRES_USER=//p' .env | tr -d '[:space:]')"; PG_USER="${PG_USER:-saos}"
PG_PASS="$(sed -n 's/^POSTGRES_PASSWORD=//p' .env | tr -d '[:space:]')"
PG_DB="$(sed -n 's/^POSTGRES_DB=//p' .env | tr -d '[:space:]')"; PG_DB="${PG_DB:-saos}"
COPY="${PG_DB}_preflight"
PSQL=(docker exec -i saos-postgres-1 psql -U "$PG_USER" -v ON_ERROR_STOP=1 -q)

cleanup() { "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS ${COPY} WITH (FORCE)" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "preflight: copying ${PG_DB} -> ${COPY} (schema and rows)..."
cleanup
"${PSQL[@]}" -d postgres -c "CREATE DATABASE ${COPY} OWNER ${PG_USER}"
docker exec saos-postgres-1 pg_dump -U "$PG_USER" --no-owner --no-privileges "$PG_DB" | "${PSQL[@]}" -d "$COPY" >/dev/null
ROWS="$("${PSQL[@]}" -d "$COPY" -Atc "SELECT count(*) FROM contacts")"
echo "preflight: copy holds ${ROWS} contact row(s); running migrations against it with the NEW image..."

# The extra migration files a sabotage mounts (PREFLIGHT_EXTRA=/host/path.js) land in the copy's run only.
EXTRA=()
if [ -n "${PREFLIGHT_EXTRA:-}" ]; then EXTRA=(-v "${PREFLIGHT_EXTRA}:/app/packages/db/migrations/$(basename "$PREFLIGHT_EXTRA")"); fi

if $COMPOSE run --rm --no-deps "${EXTRA[@]}" \
     -e DATABASE_URL="postgresql://${PG_USER}:${PG_PASS}@postgres:5432/${COPY}" \
     api node packages/db/scripts/migrate.cjs up; then
  echo "preflight: green on the copy of production."
else
  echo "preflight: RED. A migration fails on the production copy. The swap does not happen; the box stays on the previous version." >&2
  exit 1
fi
