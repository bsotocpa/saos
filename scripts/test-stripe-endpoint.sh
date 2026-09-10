#!/usr/bin/env bash
# The three cases of decision 2 (2026-09-10), against a stubbed Stripe. Needs python3 (the lib
# parses Stripe's JSON with it), so it runs where the installer runs — on the box, or any host
# with python3: `bash scripts/test-stripe-endpoint.sh`.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/stripe-endpoint.sh
. "$HERE/lib/stripe-endpoint.sh"

WEBHOOK_URL="https://api.example.test/webhooks/stripe"
WEBHOOK_EVENTS=(checkout.session.completed charge.refunded)
# Calls are logged to a file: the lib calls stripe_api inside $(...) subshells, where a variable would be lost.
CALLS_FILE="$(mktemp)"
calls() { tr -d '\n' < "$CALLS_FILE"; }
EXISTING_STATUS="enabled"
HAVE_ENDPOINT=1

stripe_api() { # a Stripe that remembers what it was asked
  local method="$1" path="$2"; shift 2
  printf '%s %s;' "$method" "$path" >> "$CALLS_FILE"
  case "$method $path" in
    "GET /webhook_endpoints?limit=100")
      if [ "$HAVE_ENDPOINT" = 1 ]; then
        printf '{"data":[{"id":"we_existing","url":"%s","status":"%s"}]}' "$WEBHOOK_URL" "$EXISTING_STATUS"
      else
        printf '{"data":[]}'
      fi ;;
    "POST /webhook_endpoints") printf '{"id":"we_new","secret":"whsec_new"}' ;;
    "POST /webhook_endpoints/we_existing") printf '{"id":"we_existing"}' ;;
    "DELETE /webhook_endpoints/we_existing") printf '{"deleted":true}' ;;
    *) echo "unexpected call: $method $path" >&2; exit 1 ;;
  esac
}

FAILED=0
check() { if [ "$2" = "$3" ]; then printf '  PASS  %s\n' "$1"; else printf '  FAIL  %s — got %s, wanted %s\n' "$1" "$2" "$3"; FAILED=1; fi; }

echo "case 1: the secret is missing -> recreate"
: > "$CALLS_FILE"; STORED_WHSEC=""; secret_verifies() { return 0; }
ensure_webhook_endpoint
check "action" "$ENDPOINT_ACTION" "recreated"
check "new id" "$WEBHOOK_ID" "we_new"
check "new secret" "$WHSEC" "whsec_new"
check "old endpoint deleted, new one created" "$(calls)" "GET /webhook_endpoints?limit=100;DELETE /webhook_endpoints/we_existing;POST /webhook_endpoints;"

echo "case 2: the secret is present but fails verification -> recreate"
: > "$CALLS_FILE"; STORED_WHSEC="whsec_stale"; secret_verifies() { return 1; }
ensure_webhook_endpoint
check "action" "$ENDPOINT_ACTION" "recreated"
check "new secret replaces the stale one" "$WHSEC" "whsec_new"
check "calls" "$(calls)" "GET /webhook_endpoints?limit=100;DELETE /webhook_endpoints/we_existing;POST /webhook_endpoints;"

echo "case 3: the secret verifies -> update the events in place and stop"
: > "$CALLS_FILE"; STORED_WHSEC="whsec_good"; secret_verifies() { return 0; }
ensure_webhook_endpoint
check "action" "$ENDPOINT_ACTION" "updated"
check "same id" "$WEBHOOK_ID" "we_existing"
check "same secret" "$WHSEC" "whsec_good"
check "no delete, no create — one in-place update" "$(calls)" "GET /webhook_endpoints?limit=100;POST /webhook_endpoints/we_existing;"

echo "case 3b: Stripe disabled the endpoint -> recreate even though the secret verifies"
: > "$CALLS_FILE"; STORED_WHSEC="whsec_good"; EXISTING_STATUS="disabled"; secret_verifies() { return 0; }
ensure_webhook_endpoint
check "action" "$ENDPOINT_ACTION" "recreated"
EXISTING_STATUS="enabled"

echo "case 0: no endpoint at all -> create"
: > "$CALLS_FILE"; HAVE_ENDPOINT=0; STORED_WHSEC=""
ensure_webhook_endpoint
check "action" "$ENDPOINT_ACTION" "created"
check "calls" "$(calls)" "GET /webhook_endpoints?limit=100;POST /webhook_endpoints;"

if [ "$FAILED" = 0 ]; then echo "ALL CASES PASSED"; else echo "SOME CASES FAILED"; exit 1; fi
