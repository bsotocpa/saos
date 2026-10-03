#!/bin/bash
# ONE SABOTAGE MANIFEST, DETACHED (R125, 2026-10-03), with the display held awake for its length.
#
#   run-sabotage.sh <log> <manifest> [--only <item substring>]
#   e.g. run-sabotage.sh C:/Users/brian/saos-shots/sabotage-x.log scripts/sabotages/2026-10-03-m-r120.mjs
#
# Runs in the checkout this script sits in (the manifest edits and restores files there). The log ends
# "exit <code>".
log="$1"; shift
[ -n "$log" ] && [ -n "$1" ] || { echo "usage: run-sabotage.sh <log> <manifest> [--only <substring>]" >&2; exit 2; }
. "$(dirname "$0")/_lib.sh"
root="$(receipt_root)"
cd "$root" || { echo "exit 99 (no checkout at $root)" >> "$log"; exit 99; }
echo "start $(date '+%Y-%m-%d %H:%M:%S %Z')" > "$log"
start_hold "$root" "$log"
node scripts/sabotage-run.mjs "$@" >> "$log" 2>&1
echo "exit $?" >> "$log"
