#!/bin/sh
# Installs the Orbital daemon (docs/DAEMON.md) as the LaunchAgent com.dreetje.orbital-daemon, running from the checkout this
# script is in, and starts it. Run it from the main checkout: a worktree is removed when its pull request merges.
# The daemon has to be signed in (node daemon/main.js login) and have its setup key (node daemon/main.js key) first.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LABEL=com.dreetje.orbital-daemon
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=$(command -v node)
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/daemon/main.js</string><string>run</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$NODE")</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/orbital-daemon.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/orbital-daemon.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Started $LABEL from $ROOT (logs: ~/Library/Logs/orbital-daemon.log)"
