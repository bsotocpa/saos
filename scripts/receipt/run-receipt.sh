#!/bin/bash
# ONE RECEIPT RUN (R125, 2026-10-03): the root `npm test` of the checkout this script sits in, detached
# from the session's tool limits, with the display held awake for its length.
#
#   run-receipt.sh <log>
#
# The receipt is run from the receipt worktree's own copy (C:/Users/brian/saos-receipt/scripts/receipt/),
# checked out at the commit under test. The root suite refuses to run any other way
# (scripts/check-receipt-runner.mjs): this script names itself and its own hash to that check, and the
# check holds both against the committed copy in the same checkout.
# The log's first line is "start <time> on <commit>", its last two are "wall <seconds>s" and "exit <code>".
log="$1"
[ -n "$log" ] || { echo "usage: run-receipt.sh <log>" >&2; exit 2; }
. "$(dirname "$0")/_lib.sh"
root="$(receipt_root)"
cd "$root" || { echo "exit 99 (no checkout at $root)" >> "$log"; exit 99; }
echo "start $(date '+%Y-%m-%d %H:%M:%S %Z') on $(git log --oneline -1)" > "$log"
start_hold "$root" "$log"
export SAOS_RECEIPT_RUNNER="$root/scripts/receipt/run-receipt.sh"
export SAOS_RECEIPT_RUNNER_SHA="$(sha256sum "$root/scripts/receipt/run-receipt.sh" | cut -d' ' -f1)"
s=$(date +%s)
npm test >> "$log" 2>&1
c=$?
echo "wall $(( $(date +%s) - s ))s" >> "$log"
echo "exit $c" >> "$log"
