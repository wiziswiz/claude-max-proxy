#!/bin/bash
# setup.sh — install claude-max-proxy as a background service + watchdog cron

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
USER_HOME="$HOME"
NODE_BIN="$(which node 2>/dev/null || echo '')"
INSTALL_TELEGRAM_TRIGGER="${INSTALL_TELEGRAM_TRIGGER:-0}"

echo "claude-max-proxy setup"
echo "======================"
echo ""

is_enabled() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

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
echo "Telegram watchdog trigger..."

TRIGGER_SRC="$REPO_DIR/telegram-watchdog-trigger.js"
TRIGGER_LABEL="com.claude-max-proxy.telegram-trigger"
TRIGGER_PLIST="$USER_HOME/Library/LaunchAgents/$TRIGGER_LABEL.plist"
TRIGGER_SERVICE="$USER_HOME/.config/systemd/user/claude-max-proxy-telegram-trigger.service"
HAS_TELEGRAM_ENV=0
HAS_TELEGRAM_FILES=0

if [ -n "${BOT_TOKEN:-}" ] && [ -n "${ALLOWED_CHAT_ID:-}" ]; then
  HAS_TELEGRAM_ENV=1
fi

if [ -f "$USER_HOME/.openclaw/clawdbot.json" ] && [ -f "$USER_HOME/.openclaw/credentials/telegram-allowFrom.json" ]; then
  HAS_TELEGRAM_FILES=1
fi

if [ ! -f "$TRIGGER_SRC" ]; then
  echo "WARNING: telegram-watchdog-trigger.js not found in repo, skipping."
elif ! is_enabled "$INSTALL_TELEGRAM_TRIGGER"; then
  echo "Skipped. This optional direct Telegram repair trigger is opt-in."
  echo "Set INSTALL_TELEGRAM_TRIGGER=1 to install it."

  if [ "$(uname)" = "Darwin" ]; then
    if launchctl print "gui/$UID/$TRIGGER_LABEL" >/dev/null 2>&1 || [ -f "$TRIGGER_PLIST" ]; then
      launchctl bootout "gui/$UID/$TRIGGER_LABEL" 2>/dev/null || true
      launchctl bootout "gui/$UID" "$TRIGGER_PLIST" 2>/dev/null || true
      rm -f "$TRIGGER_PLIST"
      echo "Removed old Telegram trigger LaunchAgent."
    fi
  elif [ "$(uname)" = "Linux" ]; then
    if systemctl --user list-unit-files 2>/dev/null | grep -q '^claude-max-proxy-telegram-trigger.service' || [ -f "$TRIGGER_SERVICE" ]; then
      systemctl --user disable --now claude-max-proxy-telegram-trigger 2>/dev/null || true
      rm -f "$TRIGGER_SERVICE"
      systemctl --user daemon-reload 2>/dev/null || true
      echo "Removed old Telegram trigger systemd service."
    fi
  fi
elif [ "$HAS_TELEGRAM_ENV" -ne 1 ] && [ "$HAS_TELEGRAM_FILES" -ne 1 ]; then
  echo "WARNING: INSTALL_TELEGRAM_TRIGGER=1 was set, but Telegram config was not found."
  echo "Skipping trigger install to avoid a crash loop."
  echo "Provide BOT_TOKEN and ALLOWED_CHAT_ID, or create:"
  echo "  $USER_HOME/.openclaw/clawdbot.json"
  echo "  $USER_HOME/.openclaw/credentials/telegram-allowFrom.json"
elif [ "$(uname)" = "Darwin" ]; then
  cat > "$TRIGGER_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$TRIGGER_LABEL</string>
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
EOF

  if [ "$HAS_TELEGRAM_ENV" -eq 1 ]; then
    cat >> "$TRIGGER_PLIST" <<EOF
        <key>BOT_TOKEN</key>
        <string>$BOT_TOKEN</string>
        <key>ALLOWED_CHAT_ID</key>
        <string>$ALLOWED_CHAT_ID</string>
EOF
  fi

  cat >> "$TRIGGER_PLIST" <<EOF
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

  launchctl bootout "gui/$UID/$TRIGGER_LABEL" 2>/dev/null || true
  sleep 1
  launchctl bootstrap "gui/$UID" "$TRIGGER_PLIST"
  sleep 2

  if tail -3 /tmp/telegram-watchdog-trigger.log 2>/dev/null | grep -q "Bot ready"; then
    echo "Telegram trigger running — send /watchdog to your bot to trigger a repair"
  else
    echo "Telegram trigger started (check /tmp/telegram-watchdog-trigger.log)"
    echo "Requires openclaw Telegram bot to be configured (clawdbot.json)"
  fi
elif [ "$(uname)" = "Linux" ]; then
  mkdir -p "$(dirname "$TRIGGER_SERVICE")"
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
EOF

  if [ "$HAS_TELEGRAM_ENV" -eq 1 ]; then
    cat >> "$TRIGGER_SERVICE" <<EOF
Environment=BOT_TOKEN=$BOT_TOKEN
Environment=ALLOWED_CHAT_ID=$ALLOWED_CHAT_ID
EOF
  fi

  cat >> "$TRIGGER_SERVICE" <<EOF
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
echo "  4. Optional: rerun with INSTALL_TELEGRAM_TRIGGER=1 for direct Telegram repair commands"
echo ""
echo "Logs:"
echo "  Proxy:    tail -f /tmp/claude-max-proxy.log"
echo "  Watchdog: tail -f /tmp/openclaw-auth-watchdog.log"
