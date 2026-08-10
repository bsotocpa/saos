#!/usr/bin/env sh
# Merge the shipped .env.production over the server's existing .env WITHOUT
# destroying secrets that were set on the server.
#
# Why this exists: deploy.sh used to `scp .env.production -> /opt/saos/.env`
# outright. Any credential pasted directly on the server — the Docuseal API token,
# a Stripe webhook secret — was silently wiped by the next deploy, and the only
# symptom was a 401 from a service that had been working ten minutes earlier.
# Diagnosed 2026-08-10 after exactly that happened to the Docuseal token, twice.
#
# The rule, the same shape as the price-book confirmation fix:
#
#   local value non-empty            -> local wins (a deliberate rotation ships)
#   local value EMPTY, server has it -> KEEP THE SERVER'S (a human set it)
#   key only on the server           -> keep it
#
# So a blank in the shipped file can never overwrite a real secret, and rotating
# from .env.production still works exactly as before.
#
# awk, not node: the production host has no node runtime (only containers do).
# Values are never printed — the summary names keys only.
#
# Usage: sh merge-env.sh <incoming> <target>

set -eu

INCOMING="${1:?usage: merge-env.sh <incoming> <target>}"
TARGET="${2:?usage: merge-env.sh <incoming> <target>}"

[ -f "$INCOMING" ] || { echo "merge-env: no incoming file at $INCOMING" >&2; exit 1; }

# No existing target (first deploy): nothing to preserve.
if [ ! -f "$TARGET" ]; then
  cp "$INCOMING" "$TARGET"
  chmod 600 "$TARGET"
  echo "env merge: no existing .env on the server — shipped file used as-is"
  exit 0
fi

TMP="$TARGET.merged.$$"

awk '
  # Pass 1: the values already on the server.
  NR == FNR {
    if (match($0, /^[A-Za-z_][A-Za-z0-9_]*=/)) {
      k = substr($0, 1, RLENGTH - 1)
      v = substr($0, RLENGTH + 1)
      if (v ~ /[^ \t]/) srv[k] = v
    }
    next
  }
  # Pass 2: the shipped file, key order preserved.
  {
    if (match($0, /^[A-Za-z_][A-Za-z0-9_]*=/)) {
      k = substr($0, 1, RLENGTH - 1)
      v = substr($0, RLENGTH + 1)
      seen[k] = 1
      if (v !~ /[^ \t]/ && (k in srv)) {
        print k "=" srv[k]
        kept = kept (kept ? ", " : "") k
        next
      }
    }
    print
  }
  END {
    for (k in srv) {
      if (!(k in seen)) {
        extra_lines = extra_lines "\n" k "=" srv[k]
        extra = extra (extra ? ", " : "") k
      }
    }
    if (extra_lines != "") {
      print ""
      print "# Preserved from the server (not present in .env.production):"
      printf "%s\n", substr(extra_lines, 2)
    }
    summary = kept
    if (extra != "") summary = summary (summary ? ", " : "") extra
    if (summary != "") print "env merge: PRESERVED server-set value(s) for " summary " (blank in the shipped file)" > "/dev/stderr"
    else print "env merge: no server-set secrets to preserve" > "/dev/stderr"
  }
' "$TARGET" "$INCOMING" > "$TMP"

mv "$TMP" "$TARGET"
chmod 600 "$TARGET"
