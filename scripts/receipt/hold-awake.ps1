# THE DISPLAY HOLD (receipt runs 59 and 60, 2026-10-01; committed under R125, 2026-10-03).
# Holds a display-required power request (what a video player does) until the run's log ends with an
# "exit" line, then releases it by exiting. It changes no power setting. Started by the run-*.sh helpers
# beside it; on a Modern Standby laptop the idle screen-off sends the machine to standby even while the
# system is held awake, and only a display-required request keeps a 50-minute receipt running.
param([Parameter(Mandatory = $true)][string]$Log)
Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
$ES = 0x80000000 -bor 0x00000001 -bor 0x00000002   # CONTINUOUS | SYSTEM_REQUIRED | DISPLAY_REQUIRED
[void][W.P]::SetThreadExecutionState($ES)
while (-not (Select-String -Path $Log -Pattern '^exit' -Quiet -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 30 }
[void][W.P]::SetThreadExecutionState(0x80000000)
