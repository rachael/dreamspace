#!/usr/bin/env sh
# Start the Vibe XR server and publish it to the headset.
#   ./serve/serve.sh          tailnet HTTPS via `tailscale serve --bg --https=<port>` (prints the https://<machine>.<tailnet>.ts.net URL)
#   ./serve/serve.sh --usb    adb reverse tcp:5173 tcp:5173, then open http://localhost:5173 in the PICO browser
# All logic lives in start.mjs so macOS, Linux and Windows behave the same.
set -e
cd "$(dirname "$0")/.."
command -v node >/dev/null 2>&1 || { echo "Node 20+ is required: https://nodejs.org"; exit 1; }
exec node serve/start.mjs "$@"
