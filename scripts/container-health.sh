#!/usr/bin/env bash
# Report container health to the API so an unhealthy service becomes an ALERT and a
# TASK, not a thing somebody notices in a report twelve hours later.
#
# This runs on the HOST, by cron, because the API deliberately has no Docker socket:
# mounting /var/run/docker.sock into the API container would hand root-equivalent
# control of the host to the most internet-exposed process on the box. So the host
# reads Docker and posts a summary; the API decides what is worth waking Brian for.
#
# Installed idempotently by scripts/deploy.sh, the same way the backup cron is —
# after the 2026-08 drill found the backup cron had never been installed at all.
#
# Usage: bash scripts/container-health.sh   (expects /opt/saos/.env)
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/saos/.env}"
[ -f "$ENV_FILE" ] || { echo "container-health: no env file at $ENV_FILE" >&2; exit 1; }

WEBHOOK_SECRET="$(sed -n 's/^WEBHOOK_SECRET=//p' "$ENV_FILE" | tr -d '\r\n')"
[ -n "$WEBHOOK_SECRET" ] || { echo "container-health: WEBHOOK_SECRET not set" >&2; exit 1; }
API_URL="${API_URL:-http://localhost:3001}"

now_epoch=$(date -u +%s)
items=""

for name in $(docker ps -a --filter "name=saos-" --format '{{.Names}}'); do
  # Health is absent for containers with no healthcheck — report "none" rather than
  # inventing a verdict for them.
  health="$(docker inspect "$name" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo none)"
  state="$(docker inspect "$name" --format '{{.State.Status}}' 2>/dev/null || echo unknown)"
  streak="$(docker inspect "$name" --format '{{if .State.Health}}{{.State.Health.FailingStreak}}{{else}}0{{end}}' 2>/dev/null || echo 0)"

  # How long has it been unhealthy? Approximated from the oldest consecutive failing
  # entry in the health log, which is what "unhealthy for N minutes" should mean.
  minutes_field=""
  if [ "$health" = "unhealthy" ]; then
    first_fail="$(docker inspect "$name" \
      --format '{{range .State.Health.Log}}{{.ExitCode}} {{.Start}}{{"\n"}}{{end}}' 2>/dev/null \
      | awk '$1 != 0 {print $2; exit}' || true)"
    if [ -n "$first_fail" ]; then
      fail_epoch="$(date -u -d "$first_fail" +%s 2>/dev/null || echo "$now_epoch")"
      minutes_field=", \"unhealthyMinutes\": $(( (now_epoch - fail_epoch) / 60 ))"
    fi
  fi

  [ -n "$items" ] && items="$items,"
  items="$items{\"name\":\"$name\",\"health\":\"$health\",\"state\":\"$state\",\"failingStreak\":${streak:-0}$minutes_field}"
done

[ -n "$items" ] || { echo "container-health: no saos-* containers found"; exit 0; }

# --fail so a non-2xx is a cron failure (visible in the log) rather than silence.
curl -sS --fail --max-time 20 \
  -X POST "$API_URL/webhooks/container-health" \
  -H "content-type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d "{\"containers\":[$items]}"
echo
