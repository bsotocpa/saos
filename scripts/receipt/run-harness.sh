#!/bin/bash
# THE HARNESS ON SOME WALKS, DETACHED (R125, 2026-10-03), with the display held awake for its length.
#
#   run-harness.sh <log> <run-harness.mjs arguments...>
#   e.g. run-harness.sh C:/Users/brian/saos-shots/walks.log tests/portal-invoices.spec.ts webkit-1440
#
# Not a receipt: it proves the walks named, in the checkout this script sits in. The log ends "exit <code>".
log="$1"; shift
[ -n "$log" ] || { echo "usage: run-harness.sh <log> <run-harness.mjs arguments...>" >&2; exit 2; }
. "$(dirname "$0")/_lib.sh"
root="$(receipt_root)"
cd "$root/apps/e2e" || { echo "exit 99 (no apps/e2e under $root)" >> "$log"; exit 99; }
echo "start $(date '+%Y-%m-%d %H:%M:%S %Z')" > "$log"
start_hold "$root" "$log"
node run-harness.mjs "$@" >> "$log" 2>&1
echo "exit $?" >> "$log"
