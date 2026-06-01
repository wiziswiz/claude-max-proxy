# claude-max-proxy

A local OAuth proxy that lets any Anthropic-compatible app use your Claude Max subscription via the same credentials Claude Code CLI uses.

## How it works

When you authenticate with `claude auth login`, the CLI stores an OAuth token locally. Every request Claude Code makes to Anthropic is attributed to your subscription using that token plus a billing header. This proxy does the same thing — it reads your local token and forwards requests from other apps with the same attribution, so they count against your Max plan rather than requiring separate API credits.

```
Your App  →  claude-max-proxy :4523  →  api.anthropic.com
              (injects your OAuth token + billing attribution)
```

**What the proxy does on each request:**
1. Reads your OAuth token from `~/.claude/.credentials.json` (or macOS Keychain)
2. Rewrites the system prompt to match the exact structure Anthropic's billing classifier expects for first-party Claude Code sessions: only `[CC-preamble, billing-header]`. Any extra app context blocks are moved into the first user message as `<system>…</system>` so the model still receives them.
3. Compacts verbose tool schemas and normalizes selected OpenClaw tool names in transit
4. Forwards to Anthropic with your credentials
5. Streams the response back after restoring normalized tool names

No separate API key needed. No extra billing. Uses your existing Max subscription.

## Prerequisites

- **Node.js** 18+
- **Claude Code CLI** installed and authenticated (`claude auth login`)
- Active **Claude Max** subscription

## Quick start

```bash
git clone https://github.com/wiziswiz/claude-max-proxy.git
cd claude-max-proxy
npm install
node index.js
```

Or run the setup script to install as a background service with auto-recovery:

```bash
./setup.sh
```

### Verify

```bash
curl http://localhost:4523/health
```

```json
{
  "status": "ok",
  "version": "2.0.0",
  "mode": "oauth-proxy",
  "token": "valid",
  "subscription": "max",
  "rateLimitTier": "default_claude_max_20x"
}
```

## App configuration

Point your app's Anthropic base URL at `http://127.0.0.1:4523`. Use any non-empty string as the API key — auth is handled by the proxy using your local credentials.

| App | Setting | Value |
|-----|---------|-------|
| OpenClaw | See full config below | `http://127.0.0.1:4523` |
| SillyTavern | API URL (Claude) | `http://127.0.0.1:4523` |
| TypingMind | Custom Endpoint | `http://127.0.0.1:4523` |
| Custom apps | `ANTHROPIC_BASE_URL` | `http://127.0.0.1:4523` |

**After changing config:** restart your app's gateway so it picks up the new base URL.

### OpenClaw: `openclaw.json` config

OpenClaw v2026.4.5+ requires a `models` array alongside `baseUrl`. Without it, validation fails and `baseUrl` is silently removed, causing requests to go directly to Anthropic without your credentials — you'll see "You're out of extra usage" errors.

Add this to `~/.openclaw/openclaw.json` under `models.providers`:

```json
"models": {
  "providers": {
    "anthropic": {
      "baseUrl": "http://127.0.0.1:4523",
      "apiKey": "claude-max-proxy",
      "models": [
        { "id": "claude-opus-4-7",   "name": "Claude Opus 4.7",   "api": "anthropic-messages" },
        { "id": "claude-opus-4-6",   "name": "Claude Opus 4.6",   "api": "anthropic-messages" },
        { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "api": "anthropic-messages" },
        { "id": "claude-haiku-4-5",  "name": "Claude Haiku 4.5",  "api": "anthropic-messages" }
      ]
    }
  }
}
```

The proxy is model-agnostic — it forwards whatever model ID your client requests. Any Claude model your account has access to will work, including new models released after this README was last updated. To set your default, edit `agents.defaults.model` in `openclaw.json`:

```json
"agents": {
  "defaults": {
    "model": {
      "primary": "anthropic/claude-opus-4-7",
      "fallbacks": [
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-opus-4-6"
      ]
    }
  }
}
```

Also confirm `auth.profiles` contains:

```json
"auth": {
  "profiles": {
    "anthropic:claude-cli": { "provider": "anthropic", "mode": "oauth" }
  }
}
```

### OpenClaw: optional path aliases

By default, the proxy leaves OpenClaw text and filesystem paths intact. That is the recommended mode and avoids the path/personality/memory drift caused by rewriting local labels.

If you explicitly enable legacy text/path sanitization with `SANITIZE_OPENCLAW=1`, create symlinks so your system can resolve both the original and normalized versions:

```bash
ln -sf ~/.openclaw ~/.clawdata
ln -sf $(which openclaw) ~/.local/bin/myapp
ln -sf $(which openclaw) ~/.local/bin/openclaw  # if not already in PATH
ln -sf ~/clawd/SOUL.md ~/clawd/PERSONA.md
ln -sf ~/clawd/HEARTBEAT.md ~/clawd/STATUSCHECK.md
```

Leave `SANITIZE_OPENCLAW=0` or unset for normal use.

## Tool names and schemas

The proxy compacts verbose tool descriptions and nested schema descriptions before forwarding requests. It also normalizes selected OpenClaw tool names upstream and restores them on inbound responses.

This is intentionally targeted: live testing showed that preserving raw OpenClaw tool names still triggers Anthropic's non-first-party billing classifier, even with compact schemas. OpenClaw still registers tools under their original names and receives tool calls under those same names.

| Original | Normalized (in transit) |
|----------|------------------------|
| `sessions_spawn` | `sess_spawn` |
| `sessions_send` | `sess_send` |
| `sessions_list` | `sess_list` |
| `sessions_history` | `sess_history` |
| `sessions_yield` | `sess_yield` |
| `session_status` | `sess_status` |
| `memory_search` | `mem_search` |
| `memory_get` | `mem_get` |
| `subagents` | `sub_agents` |
| `cron` | `scheduler` |

Both streaming (SSE) and non-streaming responses are handled. Tool references inside `tool_use` blocks in message history are also normalized outbound.

## What passes through

Everything. The proxy modifies auth headers, the billing-compatible system shape, tool schema verbosity, and selected tool names. Full support for:

- **Tool use** — `tool_use` / `tool_result` blocks pass through with full fidelity; tool names are normalized outbound and restored inbound so OpenClaw always sees original names
- **Streaming** — SSE events pass through; `data:` payloads containing tool names are rewritten to restore original names before the client receives them
- **Images / vision** — base64 image blocks
- **Extended thinking** — thinking blocks pass through
- **Cache control** — prompt caching headers and stats
- **All models** — claude-opus-4-7, claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5, etc. The proxy forwards any model ID verbatim, so new Anthropic models work automatically as long as your subscription has access.

## Token management

The proxy reads OAuth credentials from `~/.claude/.credentials.json` (written by Claude CLI) or macOS Keychain. Tokens are managed automatically:

- Checked for validity on each request
- Refreshed 5 minutes before expiry (same behavior as Claude CLI)
- Refresh token is used to get a new access token without re-authenticating
- Updated credentials written back to disk
- File watched for external changes (e.g., CLI refreshes the token independently)

If credentials are missing: `Run "claude auth login" to re-authenticate`

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4523` | Port the proxy listens on |
| `DEBUG` | `false` | Set to `1` for verbose logging (saves requests to `/tmp/`) |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Upstream Anthropic endpoint |
| `CREDENTIALS_PATH` | `~/.claude/.credentials.json` | Path to Claude CLI credentials file |
| `ANTHROPIC_TOKEN` | *(unset)* | Use this token directly, bypassing credentials file and Keychain |
| `AUTH_HEADER_FORMAT` | `bearer` | Auth header: `bearer` for Claude Code OAuth tokens. Use `x-api-key` only for legacy API keys |
| `SANITIZE_OPENCLAW` | `0` | Set to `1` to enable legacy OpenClaw text/path rewriting |
| `TOOL_NAME_MODE` | `normalize` | `normalize` maps selected OpenClaw tool names upstream and restores them inbound. `preserve` keeps raw tool names for diagnostics |
| `TOOL_SCHEMA_MODE` | `compact` | `compact` strips verbose tool/schema descriptions while preserving tool names and input shapes. Use `full` for diagnostics |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API (streaming and non-streaming) |
| `GET` | `/v1/models` | Forwards to Anthropic's model list |
| `GET` | `/health` | Health check with token status and subscription validation |
| `POST` | `/force-refresh` | Force immediate OAuth token refresh |

## Running as a service

### Automated (recommended)

```bash
./setup.sh
```

This installs the proxy as a background service, sets up auto-start on login, and installs the watchdog cron that monitors and auto-repairs the configuration every 15 minutes.

The setup script does **not** install the optional direct Telegram repair trigger by default. That trigger is separate from your normal OpenClaw Telegram bot and is only useful if you want to DM `/watchdog` or `/fix` directly to a tiny standalone repair poller.

### macOS (manual)

Create `~/Library/LaunchAgents/com.claude-max-proxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-max-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/YOUR_USER/claude-max-proxy/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USER/claude-max-proxy</string>
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
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
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
```

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claude-max-proxy.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-max-proxy.plist
```

### Linux (manual)

Create `/etc/systemd/system/claude-max-proxy.service`:

```ini
[Unit]
Description=claude-max-proxy
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/claude-max-proxy
ExecStart=/usr/bin/node /home/YOUR_USER/claude-max-proxy/index.js
Restart=on-failure
RestartSec=5
Environment=PORT=4523
Environment=AUTH_HEADER_FORMAT=bearer
Environment=SANITIZE_OPENCLAW=0
Environment=TOOL_NAME_MODE=normalize
Environment=TOOL_SCHEMA_MODE=compact

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claude-max-proxy
```

## Watchdog

The included `openclaw-auth-watchdog` script runs periodically and automatically repairs common configuration issues before they cause downtime:

1. Verifies `anthropic:claude-cli` profile is present in `openclaw.json`
2. Verifies `ANTHROPIC_BASE_URL` is set in the gateway LaunchAgent plist
3. Verifies `auth-profiles.json` order puts `anthropic:claude-cli` first
4. Extends the profile's `expires` field if it has lapsed
5. Makes a live test request to confirm the token is accepted, force-refreshes if not

Install manually:

```bash
cp openclaw-auth-watchdog ~/bin/openclaw-auth-watchdog
chmod +x ~/bin/openclaw-auth-watchdog
(crontab -l 2>/dev/null; echo "*/15 * * * * $HOME/bin/openclaw-auth-watchdog >> /tmp/openclaw-auth-watchdog.log 2>&1") | crontab -
```

Or just run `./setup.sh` which does this automatically.

### Optional Telegram repair trigger

The repo includes `telegram-watchdog-trigger.js`, a small standalone Telegram poller that can run `~/bin/openclaw-auth-watchdog` when an allowed chat sends `/watchdog` or `/fix`.

This is disabled by default because most OpenClaw installs do not have the extra allowlist file it needs. Installing it without Telegram config would create a crash loop.

To install it intentionally:

```bash
INSTALL_TELEGRAM_TRIGGER=1 ./setup.sh
```

It needs either both environment variables:

```bash
BOT_TOKEN=123:abc ALLOWED_CHAT_ID=123456 INSTALL_TELEGRAM_TRIGGER=1 ./setup.sh
```

or these OpenClaw files:

```text
~/.openclaw/clawdbot.json
~/.openclaw/credentials/telegram-allowFrom.json
```

If you previously installed the trigger by accident, rerun plain `./setup.sh`. The installer will remove the old trigger service unless `INSTALL_TELEGRAM_TRIGGER=1` is set.

## Troubleshooting

### HTTP 400 "You're out of extra usage"

Anthropic's billing classifier rejected the request as a third-party app rather than a first-party Claude Code session. There are two possible causes:

**Proxy not routing correctly** — requests bypass the proxy entirely:
1. Confirm the proxy is running: `curl http://127.0.0.1:4523/health`
2. Watch proxy logs while sending a request — you should see `POST /v1/messages`: `tail -f ~/.openclaw/logs/claude-max-proxy.log`
3. For OpenClaw: verify `openclaw.json` has both `baseUrl` and the `models` array (see App Configuration above)

**Billing classifier detecting third-party identity** — requests go through the proxy but Anthropic still rejects them. First confirm the proxy startup log says it is using Claude Code OAuth credentials and `AUTH_HEADER_FORMAT=bearer`. If that is correct and the error persists, try the legacy fallback `SANITIZE_OPENCLAW=1 node index.js`; this rewrites OpenClaw text/paths, but it is not the recommended default because it can confuse local path, memory, and personality references.

### HTTP 401 with a valid token

Try `AUTH_HEADER_FORMAT=bearer node index.js` — some macOS Keychain-sourced tokens require `Authorization: Bearer` instead of `x-api-key`.

If that doesn't help, force a token refresh:

```bash
curl -X POST http://127.0.0.1:4523/force-refresh
```

### OpenClaw: auth config wiped after `openclaw configure`

Running `openclaw configure` rewrites your auth config and removes the OAuth profile. **Don't run it after initial setup.**

If it runs anyway, restore two files:

**`~/.openclaw/openclaw.json`** — add back to `auth.profiles`:
```json
"anthropic:claude-cli": { "provider": "anthropic", "mode": "oauth" }
```
Remove any `anthropic:default` or `anthropic:manual` entries.

**`~/.openclaw/agents/main/agent/auth-profiles.json`** — set:
```json
{
  "order": { "anthropic": ["anthropic:claude-cli"] },
  "lastGood": { "anthropic": "anthropic:claude-cli" },
  "profiles": {
    "anthropic:claude-cli": {
      "type": "oauth",
      "provider": "anthropic",
      "access": "<accessToken from ~/.claude/.credentials.json>",
      "refresh": "<refreshToken from ~/.claude/.credentials.json>",
      "expires": 1807039170812
    }
  }
}
```

The `expires` value should be a future timestamp in milliseconds. Generate one: `node -e "console.log(Date.now() + 365*24*60*60*1000)"`

The watchdog auto-repairs both files if you have it installed.

### Subagents and cron jobs getting 401

Spawned subprocesses don't inherit the proxy routing. Add to your orchestrator's LaunchAgent plist:

```xml
<key>ANTHROPIC_BASE_URL</key>
<string>http://127.0.0.1:4523</string>
```

Reload: `launchctl bootout gui/$UID/ai.openclaw.gateway && launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist`

### Restarts not taking effect

If you've run `node index.js` manually, that process holds port 4523 even after you restart via LaunchAgent. Check and clear it first:

```bash
lsof -i :4523
pkill -f "node.*claude-max-proxy"
pkill -f "node index.js"
```

Then restart the LaunchAgent.

### Subagent spawn stuck in a retry loop ("Tool sess_spawn not found")

This was a proxy bug in the `TOOL_NAME_MODE=normalize` path. The proxy normalized tool names outbound but wasn't restoring them on inbound responses, so OpenClaw received `sess_spawn` instead of `sessions_spawn`, rejected it, and the model kept retrying the same spawn plan.

`git pull` the latest version and restart the proxy. The fix reverses tool renames on all inbound JSON and SSE responses.

**Sessions already stuck in the loop won't recover** — the model has already built a broken recovery plan into the conversation context. Start a fresh session (`/new`) after upgrading the proxy.

### Still seeing 401s after fixing the root cause

OpenClaw caches auth failures and won't retry a profile until the cooldown expires. Start a fresh session (`/new`) to clear the cached state.

## Security

- Binds to `127.0.0.1` only — not accessible from the network
- Credentials file accessed with owner-only permissions
- No tokens are logged, even in debug mode
- Do not expose this proxy on a public interface

## License

MIT — see [LICENSE](LICENSE).
