#!/usr/bin/env bash
#
# Install Stripe TEST keys and prove they work. One value from you: the sk_test_ key.
#
# Everything else is derived: this script uses that key to create the webhook endpoint
# through Stripe's own API and reads the whsec_ signing secret out of the response, so
# you never have to find it, copy it, or paste it anywhere.
#
# The key is read silently, never echoed, never written to shell history, and never
# passed as a command-line argument — curl reads its auth from stdin via --config so the
# secret cannot be seen in `ps`. Only a masked form is ever printed.
#
# Usage:  bash /opt/saos/scripts/install-stripe-test.sh
#
set -euo pipefail

ENV_FILE=/opt/saos/.env
COMPOSE_DIR=/opt/saos
API_BASE=https://api.sotoaccounting.com
WEBHOOK_URL="$API_BASE/webhooks/stripe"

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
info() { printf '        %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
FAILED=0

# Never let the key reach the shell history file of an interactive parent.
export HISTFILE=/dev/null

step "1. Your Stripe TEST secret key"
echo "   Stripe dashboard → make sure the TEST MODE toggle is on → Developers → API keys"
echo "   → Secret key. It starts with sk_test_."
echo
printf '   Paste it (input is hidden): '
# `|| true` matters: under `set -e`, a Ctrl-D at this prompt makes read return
# non-zero and the script would vanish with no explanation at all.
read -rs STRIPE_KEY || true
echo

if [ -z "${STRIPE_KEY}" ]; then
  fail "nothing pasted"
  exit 1
fi

# HARD REFUSAL on a live key. Pasting sk_live_ here would create REAL charges against
# real cards during a rehearsal. This check is the whole reason the script asks rather
# than accepting an argument.
case "$STRIPE_KEY" in
  sk_test_*) : ;;
  rk_test_*)
    fail "that is a RESTRICTED test key (rk_test_). It may lack webhook-write permission."
    echo "        Use the standard secret key (sk_test_) from Developers → API keys."
    exit 1
    ;;
  sk_live_*|rk_live_*)
    fail "THAT IS A LIVE KEY. Refusing."
    echo
    echo "        A live key here would take real money from real cards during the"
    echo "        rehearsal. Switch the dashboard to TEST MODE (toggle, top right) and"
    echo "        copy the key that starts with sk_test_."
    exit 1
    ;;
  *)
    fail "that does not look like a Stripe secret key (expected sk_test_…)"
    exit 1
    ;;
esac
info "key accepted: sk_test_…${STRIPE_KEY: -4}  (only the last 4 are ever shown)"

# curl auth via stdin config — keeps the secret out of the process list.
stripe_api() { # stripe_api METHOD PATH [data...]
  local method="$1" path="$2"; shift 2
  local args=()
  for d in "$@"; do args+=(--data-urlencode "$d"); done
  curl -sS -X "$method" "https://api.stripe.com/v1$path" \
    --config <(printf 'header = "Authorization: Bearer %s"\n' "$STRIPE_KEY") \
    "${args[@]}"
}

step "2. Check the key works, and that it is really test mode"
ACCOUNT_JSON="$(stripe_api GET /balance || true)"
if echo "$ACCOUNT_JSON" | grep -q '"livemode"[[:space:]]*:[[:space:]]*false'; then
  pass "Stripe accepted the key and reports livemode=false"
elif echo "$ACCOUNT_JSON" | grep -q '"livemode"[[:space:]]*:[[:space:]]*true'; then
  fail "Stripe reports LIVEMODE=TRUE for this key. Refusing to continue."
  exit 1
else
  fail "Stripe rejected the key"
  echo "$ACCOUNT_JSON" | head -c 300
  exit 1
fi

step "3. Create the test-mode webhook endpoint"
# Stripe only reveals a signing secret at CREATION. An endpoint that already exists has
# an unreadable secret, so reusing one would mean asking you to fetch it by hand —
# which is the paste this script exists to remove. Delete and recreate instead.
EXISTING="$(stripe_api GET /webhook_endpoints || true)"
OLD_ID="$(printf '%s' "$EXISTING" | python3 -c '
import json,sys
url = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for e in data.get("data", []):
    if e.get("url") == url:
        print(e.get("id", ""))
        break
' "$WEBHOOK_URL" 2>/dev/null || true)"

if [ -n "${OLD_ID:-}" ]; then
  info "an endpoint for this URL already exists ($OLD_ID)"
  info "deleting it so Stripe issues a FRESH signing secret we can capture"
  stripe_api DELETE "/webhook_endpoints/$OLD_ID" >/dev/null || true
fi

CREATED="$(stripe_api POST /webhook_endpoints \
  "url=$WEBHOOK_URL" \
  "enabled_events[]=checkout.session.completed" \
  "enabled_events[]=payment_intent.payment_failed" \
  "description=SAOS deposit checkout (installed by install-stripe-test.sh)")"

read -r WEBHOOK_ID WHSEC < <(printf '%s' "$CREATED" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("", ""); sys.exit(0)
print(d.get("id", "") or "", d.get("secret", "") or "")
' 2>/dev/null || echo " ")

if [ -z "${WHSEC:-}" ]; then
  fail "could not read a signing secret out of Stripe's response"
  printf '%s' "$CREATED" | head -c 400
  echo
  echo "        If this says the key lacks permission, use the standard sk_test_ key"
  echo "        rather than a restricted one."
  exit 1
fi
pass "endpoint ${WEBHOOK_ID} created; signing secret captured (whsec_…${WHSEC: -4})"
info "you never had to find or paste that value — it came from Stripe's own response"

step "4. Write /opt/saos/.env"
cp -a "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
info "backup taken: $ENV_FILE.bak.*"

set_env() { # set_env KEY VALUE — replace in place or append, without printing VALUE
  local k="$1" v="$2"
  if grep -q "^${k}=" "$ENV_FILE"; then
    # Value goes in via an env var, so it never appears in the sed script or in ps.
    K="$k" V="$v" python3 - "$ENV_FILE" <<'PY'
import os,sys
p=sys.argv[1]; k=os.environ["K"]; v=os.environ["V"]
lines=open(p).read().split("\n")
out=[(f"{k}={v}" if l.startswith(k+"=") else l) for l in lines]
open(p,"w").write("\n".join(out))
PY
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
}

set_env STRIPE_MODE live
set_env STRIPE_SECRET_KEY "$STRIPE_KEY"
set_env STRIPE_WEBHOOK_SECRET "$WHSEC"
chmod 600 "$ENV_FILE"
pass "STRIPE_MODE=live, STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET written (values not shown)"
info "STRIPE_MODE=live with sk_test_ keys is correct: 'live' selects the real Stripe"
info "adapter, and the test key points it at Stripe's test environment."

step "5. Restart the API"
cd "$COMPOSE_DIR"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d api >/dev/null 2>&1
for i in $(seq 1 30); do
  H="$(docker inspect saos-api-1 --format '{{.State.Health.Status}}' 2>/dev/null || echo starting)"
  [ "$H" = "healthy" ] && break
  sleep 3
done
if [ "${H:-}" = "healthy" ]; then
  pass "saos-api-1 is healthy (it refuses to boot if either value is missing)"
else
  fail "saos-api-1 did not become healthy — check: docker logs saos-api-1 --tail 40"
  exit 1
fi

step "6. Verification"
docker cp /opt/saos/scripts/verify-stripe.mjs saos-api-1:/app/verify-stripe.mjs >/dev/null
if docker exec saos-api-1 node /app/verify-stripe.mjs; then
  pass "adapter, 4242 charge and webhook signature all verified"
else
  fail "verification did not pass — see the output above"
fi
docker exec saos-api-1 rm -f /app/verify-stripe.mjs >/dev/null 2>&1 || true

step "RESULT"
if [ "$FAILED" = "0" ]; then
  printf '  \033[32mALL CHECKS PASSED\033[0m — GATE 3 is clear. Deposits can be paid with a test card.\n'
  printf '  Use 4242 4242 4242 4242, any future expiry, any CVC, in rehearsal step 6.\n\n'
else
  printf '  \033[31mSOMETHING FAILED\033[0m — read the FAIL lines above. Your .env backup is at\n'
  printf '  %s.bak.*  and STRIPE_MODE can be set back to stub to restore the old behaviour.\n\n' "$ENV_FILE"
  exit 1
fi
