# Shared by the receipt helpers (R125, 2026-10-03). Sourced, never run.
#
# WHY THESE EXIST. A receipt runs about 50 minutes. A command the session's tools start is stopped at about
# 30 (receipt run 62), and this laptop goes to Modern Standby when its screen idles off even while the
# system is held awake (receipt runs 59 and 60). So a long run is started DETACHED from one of these
# scripts, and each holds the display awake for exactly its own length (hold-awake.ps1 ends when the log
# ends with an "exit" line; no power setting is changed).
#
# HOW TO START ONE (PowerShell; a script file, never a quoted -c string, which Start-Process splits):
#   Start-Process 'C:\Program Files\Git\bin\bash.exe' -WindowStyle Hidden -ArgumentList `
#     @('C:/Users/brian/saos-receipt/scripts/receipt/run-receipt.sh', 'C:/Users/brian/saos-shots/receipt-NN.log')
# and watch the log for its last line, "exit <code>".

# The checkout these scripts sit in (Windows form with forward slashes under Git Bash, so Node agrees).
receipt_root() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[1]}")" && (pwd -W 2>/dev/null || pwd))"
  (cd "$here/../.." && (pwd -W 2>/dev/null || pwd))
}

# Hold the display awake until <log> ends with an "exit" line. Windows only; elsewhere it does nothing.
start_hold() {
  local root="$1" log="$2"
  command -v powershell.exe >/dev/null 2>&1 || return 0
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$root/scripts/receipt/hold-awake.ps1" -Log "$log" >/dev/null 2>&1 &
  disown 2>/dev/null || true
}
