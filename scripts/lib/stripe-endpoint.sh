# shellcheck shell=bash
# The webhook endpoint step of install-stripe-live.sh, as functions — so the three cases can be
# tested with a stubbed Stripe (scripts/test-stripe-endpoint.sh).
#
# DECISION 2 (2026-09-10, Brian's ruling): recreate the endpoint ONLY when the signing secret is
# missing or fails verification. Otherwise update enabled_events in place and stop — no new
# secret, no window in which events in flight are missed.
#
# Callers provide:
#   stripe_api METHOD PATH [data...]   — the Stripe REST call (curl in the installer, a stub in tests)
#   secret_verifies                    — exit 0 when the stored secret verifies (installer: the
#                                        container signs a payload with it and the API accepts it,
#                                        and rejects a forged one; tests stub this)
#   WEBHOOK_URL, WEBHOOK_EVENTS (array), STORED_WHSEC (may be empty)
# Results, in variables:
#   ENDPOINT_ACTION  = created | recreated | updated
#   WEBHOOK_ID       = the endpoint id
#   WHSEC            = the signing secret to store (the new one on create/recreate; STORED_WHSEC on update)

endpoint_for_url() { # endpoint_for_url URL -> prints "id status" of the endpoint at that URL, or nothing
  local url="$1"
  stripe_api GET "/webhook_endpoints?limit=100" | python3 -c '
import json,sys
url = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for e in data.get("data", []):
    if e.get("url") == url:
        print(e.get("id", ""), e.get("status", ""))
        break
' "$url" 2>/dev/null || true
}

event_args() { # the enabled_events[] arguments, from WEBHOOK_EVENTS
  local out=()
  for ev in "${WEBHOOK_EVENTS[@]}"; do out+=("enabled_events[]=$ev"); done
  printf '%s\n' "${out[@]}"
}

create_endpoint() { # create_endpoint -> sets WEBHOOK_ID and WHSEC from Stripe's response
  local args=()
  while IFS= read -r a; do args+=("$a"); done < <(event_args)
  local created
  created="$(stripe_api POST /webhook_endpoints "url=$WEBHOOK_URL" "${args[@]}" "description=SAOS deposit checkout (installed by install-stripe-live.sh)")"
  read -r WEBHOOK_ID WHSEC < <(printf '%s' "$created" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("", ""); sys.exit(0)
print(d.get("id", "") or "", d.get("secret", "") or "")
' 2>/dev/null || echo " ")
}

ensure_webhook_endpoint() {
  local found id status
  found="$(endpoint_for_url "$WEBHOOK_URL")"
  id="${found%% *}"
  status="${found##* }"

  if [ -z "$id" ]; then
    ENDPOINT_ACTION=created
    create_endpoint
    return 0
  fi

  if [ -n "${STORED_WHSEC:-}" ] && [ "$status" = "enabled" ] && secret_verifies; then
    # The secret on the box verifies against the app and Stripe still delivers to this door:
    # keep both. Only the event list is brought up to date, in place.
    local args=()
    while IFS= read -r a; do args+=("$a"); done < <(event_args)
    stripe_api POST "/webhook_endpoints/$id" "${args[@]}" >/dev/null
    ENDPOINT_ACTION=updated
    WEBHOOK_ID="$id"
    WHSEC="$STORED_WHSEC"
    return 0
  fi

  # Missing secret, or one that no longer verifies, or an endpoint Stripe has disabled: the
  # only way to hold a secret Stripe also holds is a new endpoint.
  stripe_api DELETE "/webhook_endpoints/$id" >/dev/null || true
  ENDPOINT_ACTION=recreated
  create_endpoint
}
