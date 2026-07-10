#!/usr/bin/env bash
# PerNav launcher (macOS / Linux) — starts the local bridge (if needed) and opens
# a Chromium-based browser with the PerNav extension loaded in an isolated profile.
#
#   ./launch.sh                          # picks the first browser it finds
#   ./launch.sh brave                    # chrome | edge | brave | vivaldi | opera | chromium
#   ./launch.sh /path/to/any/chromium-based-browser
#   URL=https://example.com ./launch.sh
#   PROFILE=/path/to/profile ./launch.sh # use a specific profile directory
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
ext="$root/extension"
url="${URL:-https://example.com}"

# Start the bridge only if nothing is already listening on 8765.
if ! (exec 3<>/dev/tcp/127.0.0.1/8765) 2>/dev/null; then
  echo "[pernav] starting bridge..."
  (cd "$root/bridge" && nohup node bridge.mjs >bridge-run.log 2>bridge-run.err.log &)
  sleep 2
fi

# Candidate binaries per browser: macOS app-bundle paths + Linux command names.
candidates() {
  case "$1" in
    chrome)   echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
google-chrome
google-chrome-stable" ;;
    edge)     echo "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge
microsoft-edge
microsoft-edge-stable" ;;
    brave)    echo "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser
brave-browser
brave" ;;
    vivaldi)  echo "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi
vivaldi
vivaldi-stable" ;;
    opera)    echo "/Applications/Opera.app/Contents/MacOS/Opera
opera" ;;
    chromium) echo "/Applications/Chromium.app/Contents/MacOS/Chromium
chromium
chromium-browser" ;;
  esac
}
order="chrome edge brave vivaldi opera chromium"

resolve() { # prints the first existing binary for a browser name, if any
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    if [ -x "$cand" ]; then echo "$cand"; return 0; fi
    if command -v "$cand" >/dev/null 2>&1; then command -v "$cand"; return 0; fi
  done <<< "$(candidates "$1")"
  return 1
}

sel="${1:-}"
exe="" name=""
if [ -n "$sel" ] && [ -x "$sel" ]; then
  exe="$sel"; name="$(basename "$sel" | tr ' ' '-' | tr '[:upper:]' '[:lower:]')"
elif [ -n "$sel" ]; then
  exe="$(resolve "$sel")" || { echo "[pernav] '$sel' not found — use one of: $order, or a full path"; exit 1; }
  name="$sel"
else
  for k in $order; do
    if exe="$(resolve "$k")"; then name="$k"; break; fi
  done
  [ -n "$exe" ] || { echo "[pernav] no Chromium-based browser found — pass one: ./launch.sh <name-or-path>"; exit 1; }
fi

# One isolated profile per browser — sharing a profile dir across forks corrupts it.
prof="${PROFILE:-$root/.profiles/$name}"
mkdir -p "$prof"

echo "[pernav] launching $name ($exe)"
"$exe" \
  --user-data-dir="$prof" \
  --load-extension="$ext" \
  --disable-features=DisableLoadExtensionCommandLineSwitch \
  --no-first-run --no-default-browser-check \
  "$url" >/dev/null 2>&1 &
disown
