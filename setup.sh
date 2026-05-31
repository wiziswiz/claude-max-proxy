#!/bin/bash
# setup.sh — install claude-max-proxy as a background service + watchdog cron

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
USER_HOME="$HOME"
NODE_BIN="$(which node 2>/dev/null || echo '')"

echo "claude-max-proxy setup"
echo "======================"
echo ""

# ── Prerequisites ─────────────────────────────────────────────────────────────
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found. Install Node.js 18+ and re-run."
  exit 1
fi

NODE_VERSION=$("$NODE_BIN" -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required (found $NODE_VERSION). Please upgrade."
  exit 1
fi

echo "Node: $NODE_BIN (v$(node --version))"

# ── npm install ────────────────────────────────────────────────────────────────
echo ""
echo "Installing dependencies..."
cd "$REPO_DIR"
npm install --silent

# ── Check credentials ──────────────────────────────────────────────────────────
echo ""
CREDS_FILE="$USER_HOME/.claude/.credentials.json"
if [ -f "$CREDS_FILE" ]; then
  echo "Credentials: found at $CREDS_FILE"
elif [ "$(uname)" = "Darwin" ] && security find-generic-password -s "Claude Code-credentials" -w &>/dev/null; then
  echo "Credentials: found in macOS Keychain"
else
  echo "WARNING: No Claude credentials found."
  echo "  Run 'claude auth login' before starting the proxy."
  echo ""
fi

# ── macOS: LaunchAgent ─────────────────────────────────────────────────────────
if [ "$(uname)" = "Darwin" ]; then
  PLIST="$USER_HOME/Library/LaunchAgents/com.claude-max-proxy.plist"
  mkdir -p "$USER_HOME/Library/LaunchAgents"

  echo "Installing LaunchAgent: $PLIST"

  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-max-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$REPO_DIR/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>4523</string>
        <key>AUTH_HEADER_FORMAT</key>
        <string>bearer</string>
        <key>SANITIZE_OPENCLAW</key>
        <string>0</string>
        <key>TOOL_NAME_MODE</key>
        <string>normalize</string>
        <key>TOOL_SCHEMA_MODE</key>
        <string>compact</string>
        <key>HOME</key>
        <string>$USER_HOME</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:$USER_HOME/.nvm/versions/node/$(node -e "console.log(process.version.slice(1))" 2>/dev/null || echo "current")/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claude-max-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-max-proxy.err</string>
</dict>
</plist>
EOF

  # Stop any existing instance
  launchctl bootout gui/$UID/com.claude-max-proxy 2>/dev/null || true
  sleep 1

  # Kill any stale manual processes
  pkill -f "node.*claude-max-proxy" 2>/dev/null || true
  pkill -f "node $REPO_DIR/index.js" 2>/dev/null || true
  sleep 1

  launchctl bootstrap gui/$UID "$PLIST"
  launchctl kickstart -k gui/$UID/com.claude-max-proxy 2>/dev/null || true
  sleep 2

  # Verify
  if curl -s --max-time 5 http://127.0.0.1:4523/health | grep -q '"status"'; then
    echo "Proxy running at http://127.0.0.1:4523"
    curl -s http://127.0.0.1:4523/health
    echo ""
  else
    echo "WARNING: Proxy may not have started. Check /tmp/claude-max-proxy.err"
  fi

# ── Linux: systemd ─────────────────────────────────────────────────────────────
elif [ "$(uname)" = "Linux" ]; then
  SERVICE_FILE="$USER_HOME/.config/systemd/user/claude-max-proxy.service"
  mkdir -p "$(dirname "$SERVICE_FILE")"

  echo "Installing systemd user service: $SERVICE_FILE"

  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=claude-max-proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=$NODE_BIN $REPO_DIR/index.js
Restart=on-failure
RestartSec=5
Environment=PORT=4523
Environment=AUTH_HEADER_FORMAT=bearer
Environment=SANITIZE_OPENCLAW=0
Environment=TOOL_NAME_MODE=normalize
Environment=TOOL_SCHEMA_MODE=compact
Environment=HOME=$USER_HOME

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now claude-max-proxy
  sleep 2

  if curl -s --max-time 5 http://127.0.0.1:4523/health | grep -q '"status"'; then
    echo "Proxy running at http://127.0.0.1:4523"
  else
    echo "WARNING: Proxy may not have started. Check: journalctl --user -u claude-max-proxy"
  fi
fi

# ── Watchdog ───────────────────────────────────────────────────────────────────
echo ""
echo "Installing watchdog..."

WATCHDOG_SRC="$REPO_DIR/openclaw-auth-watchdog"
WATCHDOG_DST="$USER_HOME/bin/openclaw-auth-watchdog"

if [ ! -f "$WATCHDOG_SRC" ]; then
  echo "WARNING: openclaw-auth-watchdog not found in repo, skipping."
else
  mkdir -p "$USER_HOME/bin"
  cp "$WATCHDOG_SRC" "$WATCHDOG_DST"
  chmod +x "$WATCHDOG_DST"

  # Install or upgrade cron — ensure it runs every 15 min (not hourly)
  CRON_LINE="*/15 * * * * $WATCHDOG_DST >> /tmp/openclaw-auth-watchdog.log 2>&1"
  if crontab -l 2>/dev/null | grep -q "$CRON_LINE"; then
    echo "Watchdog cron already installed (every 15 min)."
  else
    # Remove any old hourly entry and install the 15-min one
    (crontab -l 2>/dev/null | grep -v "openclaw-auth-watchdog"; echo "$CRON_LINE") | crontab -
    echo "Watchdog cron installed (runs every 15 min)."
  fi
fi

# ── Telegram watchdog trigger ──────────────────────────────────────────────────
echo ""
echo "Installing Telegram watchdog trigger..."

TRIGGER_SRC="$REPO_DIR/telegram-watchdog-trigger.js"

if [ ! -f "$TRIGGER_SRC" ]; then
  echo "WARNING: telegram-watchdog-trigger.js not found in repo, skipping."
elif [ "$(uname)" = "Darwin" ]; then
  TRIGGER_PLIST="$USER_HOME/Library/LaunchAgents/com.claude-max-proxy.telegram-trigger.plist"

  cat > "$TRIGGER_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-max-proxy.telegram-trigger</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$REPO_DIR/telegram-watchdog-trigger.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>$USER_HOME</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:$(dirname "$NODE_BIN")</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/telegram-watchdog-trigger.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/telegram-watchdog-trigger.err</string>
</dict>
</plist>
EOF

  launchctl bootout gui/$UID/com.claude-max-proxy.telegram-trigger 2>/dev/null || true
  sleep 1
  launchctl bootstrap gui/$UID "$TRIGGER_PLIST"
  sleep 2

  if tail -3 /tmp/telegram-watchdog-trigger.log 2>/dev/null | grep -q "Bot ready"; then
    echo "Telegram trigger running — send /watchdog to your bot to trigger a repair"
  else
    echo "Telegram trigger started (check /tmp/telegram-watchdog-trigger.log)"
    echo "Requires openclaw Telegram bot to be configured (clawdbot.json)"
  fi
elif [ "$(uname)" = "Linux" ]; then
  TRIGGER_SERVICE="$USER_HOME/.config/systemd/user/claude-max-proxy-telegram-trigger.service"
  cat > "$TRIGGER_SERVICE" <<EOF
[Unit]
Description=claude-max-proxy Telegram watchdog trigger
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=$NODE_BIN $REPO_DIR/telegram-watchdog-trigger.js
Restart=on-failure
RestartSec=10
Environment=HOME=$USER_HOME

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now claude-max-proxy-telegram-trigger
  echo "Telegram trigger installed as systemd user service"
fi

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo "Setup complete."
echo ""
echo "Next steps:"
echo "  1. Point your app's Anthropic base URL to http://127.0.0.1:4523"
echo "  2. Use any string as the API key (e.g. 'claude-max-proxy')"
echo "  3. See README.md for app-specific config"
echo "  4. Send /watchdog to your Telegram bot to trigger repairs remotely"
echo ""
echo "Logs:"
echo "  Proxy:    tail -f /tmp/claude-max-proxy.log"
echo "  Telegram: tail -f /tmp/telegram-watchdog-trigger.log"
