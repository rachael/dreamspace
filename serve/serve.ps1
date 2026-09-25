# Start the Vibe XR server and publish it to the headset (Windows PowerShell).
#   .\serve\serve.ps1          tailnet HTTPS via `tailscale serve --bg --https=<port>` (prints the https://<machine>.<tailnet>.ts.net URL)
#   .\serve\serve.ps1 --usb    adb reverse tcp:5173 tcp:5173, then open http://localhost:5173 in the PICO browser
# All logic lives in start.mjs so macOS, Linux and Windows behave the same.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Node 20+ is required: https://nodejs.org'; exit 1 }
node serve/start.mjs @args
exit $LASTEXITCODE
