#!/bin/sh
# Run the screenshot reader (ADR 0009) in the background on macOS: a launchd
# agent that starts at login and restarts if it stops. Undo with
# `scripts/install-reader.sh --uninstall`. Logs: ~/Library/Logs/offerdesk-reader.log
set -eu

LABEL=dev.offerdesk.reader
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO=$(cd "$(dirname "$0")/.." && pwd)

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

NODE=$(command -v node)
[ -f "$REPO/.env.mcp" ] || { echo "missing $REPO/.env.mcp (the hosted database's env file)" >&2; exit 1; }
[ -f "$REPO/apps/server/dist/cli.js" ] || { echo "run pnpm build first" >&2; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file=$REPO/.env.mcp</string>
    <string>$REPO/apps/server/dist/cli.js</string>
    <string>read-screenshots</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/offerdesk-reader.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/offerdesk-reader.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL; logs in ~/Library/Logs/offerdesk-reader.log"
