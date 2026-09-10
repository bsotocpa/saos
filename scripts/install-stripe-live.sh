#!/usr/bin/env bash
#
# Install Stripe LIVE keys and prove they work — WITHOUT moving any money.
#
# The companion to install-stripe-test.sh, with the same handling properties: the key is read
# silently, never echoed, never written to shell history, and never passed as a command-line
# argument — curl reads its auth from stdin via --config so the secret cannot be seen in `ps`.
# Only a masked form is ever printed.
#
# Three things are DIFFERENT, and each is deliberate:
#
#   1. It refuses an sk_test_ key, which is the mirror image of the other script's refusal.
#   2. It asks you to type a confirmation phrase before writing anything. The test installer
#      does not, and should not — the worst case there is a rehearsal charge on a fake card.
#      Here the worst case is a real client's card being charged by a system nobody meant to arm.
#   3. It NEVER creates a charge. verify-stripe.mjs proves the payment path by confirming a
#      PaymentIntent on Stripe's 4242 card; with a live key that is a real charge on a real
#      account. verify-stripe-live.mjs asks the account whether it CAN take money
#      (charges_enabled) instead, which is what the 4242 charge was really testing.
#
# Usage:  bash /opt/saos/scripts/install-stripe-live.sh
#
# Rollback at any point: your .env is backed up to .env.bak.* before anything is written, and
# setting STRIPE_MODE=stub restores the previous behaviour without touching the keys.
#
set -euo pipefail

ENV_FILE=/opt/saos/.env
COMPOSE_DIR=/opt/saos
WEBHOOK_URL="https://api.sotoaccounting.com/webhooks/stripe"
FAILED=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
info() { printf '        %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Never let the key reach the shell history file of an interactive parent.
export HISTFILE=/dev/null

printf '\n\033[1m\033[31m  ARMING REAL PAYMENTS\033[0m\n'
printf '  After this, a client card entered on a Soto checkout page is charged for real.\n'
printf '  Nothing is written until you confirm at the prompt below.\n'

step "1. Your Stripe LIVE secret key"
echo "   Stripe dashboard → make sure the TEST MODE toggle is OFF → Developers → API keys"
echo "   → Secret key. It starts with sk_live_."
echo "   Paste it and press Enter. It will not be shown."
echo
read -rs STRIPE_KEY || true
echo

if [ -z "${STRIPE_KEY:-}" ]; then
  fail "no key entered — nothing was changed"
  exit 1
fi

# HARD REFUSAL on a test key, the mirror of the other script's refusal on a live one. A test key
# here would leave the system looking armed while every real client's card silently declined.
case "$STRIPE_KEY" in
  rk_*)
    fail "that is a RESTRICTED key (rk_…)"
    echo "        Use the standard secret key (sk_live_) from Developers → API keys."
    exit 1
    ;;
  sk_test_*)
    fail "that is a TEST key (sk_test_…), not a live one"
    echo "        This script arms real payments. A test key here would look installed and"
    echo "        decline every real card. If you meant to install test keys, the script is"
    echo "        install-stripe-test.sh."
    exit 1
    ;;
  sk_live_*)
    : # the one we want
    ;;
  *)
    fail "that does not look like a Stripe secret key (expected sk_live_…)"
    exit 1
    ;;
esac
info "key accepted: sk_live_…${STRIPE_KEY: -4}  (only the last 4 are ever shown)"

# curl auth via stdin config — keeps the secret out of the process list.
stripe_api() { # stripe_api METHOD PATH [data...]
  local method="$1" path="$2"; shift 2
  local args=()
  for d in "$@"; do args+=(--data-urlencode "$d"); done
  curl -sS -X "$method" "https://api.stripe.com/v1$path" \
    --config <(printf 'header = "Authorization: Bearer %s"\n' "$STRIPE_KEY") \
    "${args[@]}"
}

step "2. Check the key works, and that it is really LIVE mode"
ACCOUNT_JSON="$(stripe_api GET /balance || true)"
if printf '%s' "$ACCOUNT_JSON" | grep -q '"livemode"[[:space:]]*:[[:space:]]*true'; then
  pass "Stripe accepted the key and reports livemode=true"
elif printf '%s' "$ACCOUNT_JSON" | grep -q '"livemode"[[:space:]]*:[[:space:]]*false'; then
  fail "Stripe reports livemode=false — this key is a test key despite its prefix"
  exit 1
else
  fail "Stripe did not accept the key"
  printf '%s' "$ACCOUNT_JSON" | head -c 300
  echo
  exit 1
fi

# Can this account actually take money? A live key on an account that has not finished
# onboarding looks completely configured and declines the first real client.
#
# /v1/account — SINGULAR. The first version called /v1/accounts, which is the Connect endpoint
# that LISTS connected accounts; for a normal account it returns an empty list with no
# charges_enabled field anywhere in it. The grep below then failed for every account on earth,
# and the script told Brian his Stripe onboarding was incomplete when the truth was that it had
# asked the wrong question. Read-only either way, so nothing was harmed — but a check that cannot
# tell "the field is false" from "the field is not there" reports the same thing for a broken
# account and a broken script. Now it distinguishes them.
ACCT="$(stripe_api GET /account || true)"
if ! printf '%s' "$ACCT" | grep -q '"charges_enabled"'; then
  fail "the account response did not contain charges_enabled at all — that is a SCRIPT or API problem, not your account"
  printf '%s' "$ACCT" | head -c 300
  echo
  info "nothing has been written — your .env is untouched"
  exit 1
fi
if printf '%s' "$ACCT" | grep -q '"charges_enabled"[[:space:]]*:[[:space:]]*true'; then
  pass "the account is able to accept charges (charges_enabled=true)"
else
  fail "charges_enabled=false — Stripe has the key but this account cannot take a payment yet"
  info "this is a real answer from Stripe about the LIVE account, not a script error:"
  info "onboarding or identity/bank verification is incomplete. The Stripe dashboard home"
  info "page will say exactly what is outstanding."
  info "nothing has been written — your .env is untouched"
  exit 1
fi

step "3. Confirm, in words"
printf '  This will arm live card payments on %s\n' "$WEBHOOK_URL"
printf '  Type exactly:  ARM LIVE PAYMENTS\n'
printf '  Anything else cancels and changes nothing.\n\n'
read -r CONFIRM || true
if [ "${CONFIRM:-}" != "ARM LIVE PAYMENTS" ]; then
  fail "not confirmed — nothing was changed"
  exit 1
fi
pass "confirmed"

step "4. Webhook endpoint and signing secret"
# Stripe only reveals a signing secret at CREATION, so an existing endpoint has an unreadable
# one. Deleting a LIVE endpoint is more consequential than deleting a test one — it can drop
# events in flight — so this asks rather than assuming.
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
  info "a LIVE endpoint for this URL already exists ($OLD_ID)"
  info "Stripe will not reveal its signing secret again, so it must be replaced to capture one."
  printf '        Replace it? Events arriving during the swap could be missed. [type: yes] '
  read -r REPLACE || true
  if [ "${REPLACE:-}" != "yes" ]; then
    fail "not replacing — nothing was written"
    info "if you already hold that endpoint's whsec_, set STRIPE_WEBHOOK_SECRET by hand instead"
    exit 1
  fi
  stripe_api DELETE "/webhook_endpoints/$OLD_ID" >/dev/null || true
  info "deleted $OLD_ID"
fi

CREATED="$(stripe_api POST /webhook_endpoints \
  "url=$WEBHOOK_URL" \
  "enabled_events[]=checkout.session.completed" \
  "enabled_events[]=payment_intent.payment_failed" \
  "enabled_events[]=charge.refunded" \
  "enabled_events[]=charge.dispute.created" \
  "enabled_events[]=charge.dispute.closed" \
  "description=SAOS deposit checkout (installed by install-stripe-live.sh)")"

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
  echo "        If this says the key lacks permission, use the standard sk_live_ key"
  echo "        rather than a restricted one. Nothing has been written to .env."
  exit 1
fi
pass "endpoint ${WEBHOOK_ID} created; signing secret captured (whsec_…${WHSEC: -4})"
info "you never had to find or paste that value — it came from Stripe's own response"

step "5. Write /opt/saos/.env"
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
# Item 10 (2026-09-09): every signature failure names this endpoint, so the log says which
# door the event knocked on. Server-only key: the deploy merge preserves it.
set_env STRIPE_WEBHOOK_ENDPOINT_ID "$WEBHOOK_ID"
chmod 600 "$ENV_FILE"
pass "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET written (values not shown)"

# 2026-09-09: register these as SERVER-MANAGED so a deploy can never merge a stale laptop
# value over them again. That is exactly what happened to the first live key: installed
# here at 01:25, verified, and overwritten by the 02:29 deploy from .env.production.
# scripts/merge-env.sh keeps the server's value for every key named in this file.
MANAGED="$ENV_FILE.server-managed"
touch "$MANAGED" && chmod 600 "$MANAGED"
# Decision 4 (2026-09-09): the endpoint id is server-managed too, so a re-run with the same key
# leaves every one of these four owned by the box. The loop is idempotent (grep -qx before append).
for k in STRIPE_MODE STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_WEBHOOK_ENDPOINT_ID; do
  grep -qx "$k" "$MANAGED" || echo "$k" >> "$MANAGED"
done
pass "registered as server-managed in $MANAGED — deploys keep the server's value from now on"
info "STRIPE_MODE was already 'live' — that selects the real adapter rather than the stub,"
info "and it is the KEY that decides test versus production. That is why the mode alone"
info "never told you which one you were on."

step "6. Restart the API"
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
  info "your previous .env is at $ENV_FILE.bak.*"
  exit 1
fi

step "7. Verification (no charge is created)"
docker cp /opt/saos/scripts/verify-stripe-live.mjs saos-api-1:/app/verify-stripe-live.mjs >/dev/null
if docker exec saos-api-1 node /app/verify-stripe-live.mjs; then
  pass "adapter, live mode, charge capability and webhook signature all verified"
else
  fail "verification did not pass — see the output above"
fi
docker exec saos-api-1 rm -f /app/verify-stripe-live.mjs >/dev/null 2>&1 || true

step "RESULT"
if [ "$FAILED" = "0" ]; then
  printf '  \033[32mALL CHECKS PASSED\033[0m — live payments are ARMED.\n'
  printf '  A client card on a Soto checkout page is now charged for real.\n\n'
  printf '  Two things worth doing tonight:\n'
  printf '    · take ONE real card payment yourself for a small amount and refund it in the\n'
  printf '      Stripe dashboard — the only end-to-end proof that does not exist until a\n'
  printf '      real card is used, and the cheapest time to find a problem\n'
  printf '    · confirm the payment lands on the invoice in SAOS, not just in Stripe\n\n'
  printf '  Rollback: STRIPE_MODE=stub in %s restores the previous behaviour,\n' "$ENV_FILE"
  printf '  and your prior file is at %s.bak.*\n\n' "$ENV_FILE"
else
  printf '  \033[31mSOMETHING FAILED\033[0m — read the FAIL lines above. Your .env backup is at\n'
  printf '  %s.bak.*  and STRIPE_MODE=stub restores the previous behaviour.\n\n' "$ENV_FILE"
  exit 1
fi
