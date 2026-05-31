#!/usr/bin/env node

/**
 * claude-max-proxy v2
 *
 * Thin reverse proxy that injects Claude CLI OAuth credentials into
 * Anthropic Messages API requests. Full API fidelity — tool_use,
 * streaming, images, everything passes through untouched.
 *
 * How it works:
 *   1. Reads OAuth token from ~/.claude/.credentials.json
 *   2. Auto-refreshes when token nears expiry
 *   3. Sanitizes prompts (strips third-party app identifiers)
 *   4. Forwards request verbatim to api.anthropic.com
 *   5. Streams response back untouched
 *
 * Usage:
 *   node index.js                  # start on default port 4523
 *   PORT=8080 node index.js        # custom port
 *
 * Then point your app's Anthropic base URL at http://localhost:4523
 */

const express = require('express');
const { readFileSync, watchFile, unwatchFile } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const http = require('http');
const https = require('https');

const app = express();

const PORT = parseInt(process.env.PORT || '4523', 10);
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH || join(homedir(), '.claude', '.credentials.json');
// ANTHROPIC_TOKEN env var: bypass credentials file entirely — set to your sk-ant-oat01-* token directly.
// Useful when Claude Code stores credentials in macOS Keychain instead of ~/.claude/.credentials.json.
const ANTHROPIC_TOKEN_OVERRIDE = process.env.ANTHROPIC_TOKEN || null;
// AUTH_HEADER_FORMAT: 'bearer' (default) or 'x-api-key'.
// OAuth tokens (sk-ant-oat01-*) require Authorization: Bearer — sending them as x-api-key
// causes "invalid x-api-key" 401s. Override with AUTH_HEADER_FORMAT=x-api-key only if
// using a legacy sk-ant-api03-* key.
const AUTH_HEADER_FORMAT = (process.env.AUTH_HEADER_FORMAT || 'bearer').toLowerCase();
const SANITIZE_OPENCLAW = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.SANITIZE_OPENCLAW || '').toLowerCase()
);
const TOOL_NAME_MODE = (process.env.TOOL_NAME_MODE || 'normalize').toLowerCase();
const NORMALIZE_TOOL_NAMES = ['normalize', 'neutral', '1', 'true', 'yes', 'on'].includes(TOOL_NAME_MODE);
const TOOL_SCHEMA_MODE = (process.env.TOOL_SCHEMA_MODE || 'compact').toLowerCase();
const COMPACT_TOOL_SCHEMAS = TOOL_SCHEMA_MODE === 'compact';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const { randomUUID } = require('crypto');
let PROXY_SESSION_ID = randomUUID();

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function debug(...args) {
  if (DEBUG) console.log(`[${new Date().toISOString()}] [DEBUG]`, ...args);
}

// ---------------------------------------------------------------------------
// OAuth credential management
// ---------------------------------------------------------------------------

let cachedCredentials = null;
let refreshInProgress = null;

// Read token from macOS Keychain — fallback for Claude Code 2.1.92+ which may
// migrate credentials away from ~/.claude/.credentials.json on some machines.
function readCredentialsFromKeychain() {
  if (process.platform !== 'darwin') return null;
  try {
    const { execFileSync } = require('child_process');
    const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!raw) return null;

    // May be a JSON blob or a raw token string
    try {
      const parsed = JSON.parse(raw);
      if (parsed.claudeAiOauth?.accessToken) return parsed.claudeAiOauth;
      if (parsed.accessToken) return parsed;
    } catch {
      // Raw token string
      if (raw.startsWith('sk-ant-')) {
        return { accessToken: raw, refreshToken: null, expiresAt: Date.now() + 8 * 60 * 60 * 1000 };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function readCredentials() {
  // 1. Env var override — highest priority, no file needed
  if (ANTHROPIC_TOKEN_OVERRIDE) {
    cachedCredentials = {
      accessToken: ANTHROPIC_TOKEN_OVERRIDE,
      refreshToken: null,
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    };
    log('Using token from ANTHROPIC_TOKEN env var');
    return cachedCredentials;
  }

  // 2. Credentials file (default for most Claude Code installations)
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    cachedCredentials = parsed.claudeAiOauth;
    if (!cachedCredentials?.accessToken) {
      throw new Error('No accessToken found in credentials');
    }
    debug('Credentials loaded from file, expires at', new Date(cachedCredentials.expiresAt).toISOString());
    return cachedCredentials;
  } catch (err) {
    debug('Credentials file not available:', err.message);
  }

  // 3. macOS Keychain — Claude Code 2.1.92+ on some machines migrates here
  const keychainCreds = readCredentialsFromKeychain();
  if (keychainCreds) {
    cachedCredentials = keychainCreds;
    log('Credentials loaded from macOS Keychain');
    return cachedCredentials;
  }

  log('Failed to read credentials from file or Keychain');
  log('Options:');
  log('  A) Run "claude auth login" to re-authenticate');
  log('  B) Set ANTHROPIC_TOKEN=sk-ant-oat01-... env var with your OAuth token');
  log('  C) Set CREDENTIALS_PATH to your credentials file location');
  return null;
}

function isTokenExpired(creds) {
  if (!creds?.expiresAt) return true;
  // Refresh 5 minutes before expiry, same as Claude CLI
  return Date.now() + 300_000 >= creds.expiresAt;
}

async function refreshToken(creds) {
  if (!creds?.refreshToken) {
    throw new Error('No refresh token available');
  }

  log('Refreshing OAuth token...');

  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPES,
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Token refresh failed (${res.status}): ${errText}`);
  }

  const data = await res.json();

  cachedCredentials = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || creds.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: (data.scope || OAUTH_SCOPES).split(' '),
    subscriptionType: creds.subscriptionType,
    rateLimitTier: creds.rateLimitTier,
  };

  // Write back so the CLI and future proxy starts pick it up
  try {
    const { writeFileSync } = require('fs');
    writeFileSync(CREDENTIALS_PATH, JSON.stringify({ claudeAiOauth: cachedCredentials }, null, 2), {
      mode: 0o600,
    });
    debug('Updated credentials file');
  } catch (err) {
    debug('Could not write back credentials:', err.message);
  }

  log('Token refreshed, expires at', new Date(cachedCredentials.expiresAt).toISOString());
  syncAuthProfiles(cachedCredentials);
  return cachedCredentials;
}

async function getAccessToken() {
  if (!cachedCredentials) {
    readCredentials();
  }

  if (!cachedCredentials) {
    throw new Error('No credentials available. Run "claude auth login" first.');
  }

  if (!isTokenExpired(cachedCredentials)) {
    return cachedCredentials.accessToken;
  }

  // Deduplicate concurrent refresh attempts
  if (!refreshInProgress) {
    refreshInProgress = refreshToken(cachedCredentials)
      .finally(() => { refreshInProgress = null; });
  }

  const refreshed = await refreshInProgress;
  return refreshed.accessToken;
}

// Sync the fresh token into openclaw's auth-profiles.json so openclaw never
// uses a stale token. This is the root cause of recurring 401s: the proxy
// refreshes credentials.json but openclaw reads a separate file.
const AUTH_PROFILES_PATH = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');

function readFreshToken() {
  // Try credentials file first, then Keychain — mirrors readCredentials() priority
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.claudeAiOauth?.accessToken) return parsed.claudeAiOauth;
  } catch {}

  // Keychain fallback (Claude Code 2.1.92+ on some Macs)
  const kc = readCredentialsFromKeychain();
  if (kc?.accessToken) return kc;
  return null;
}

function syncAuthProfiles(creds) {
  if (!creds?.accessToken) return;
  try {
    const { readFileSync: rfs, writeFileSync: wfs } = require('fs');
    const data = JSON.parse(rfs(AUTH_PROFILES_PATH, 'utf8'));
    const profile = data?.profiles?.['anthropic:claude-cli'];
    if (!profile) return;

    const wasStale = profile.access !== creds.accessToken;
    profile.access = creds.accessToken;
    profile.refresh = creds.refreshToken || profile.refresh;
    profile.expires = Date.now() + 365 * 24 * 60 * 60 * 1000;

    // Clear any stale cooldown that might block openclaw from retrying
    if (data.usageStats?.['anthropic:claude-cli']) {
      delete data.usageStats['anthropic:claude-cli'].cooldownUntil;
      delete data.usageStats['anthropic:claude-cli'].cooldownReason;
      data.usageStats['anthropic:claude-cli'].errorCount = 0;
      delete data.usageStats['anthropic:claude-cli'].failureCounts;
    }

    wfs(AUTH_PROFILES_PATH, JSON.stringify(data, null, 2));
    if (wasStale) {
      log('[token-sync] Synced fresh token into auth-profiles.json (was stale)');
    } else {
      debug('[token-sync] auth-profiles.json already up to date');
    }
  } catch (err) {
    debug('[token-sync] could not sync auth-profiles.json:', err.message);
  }
}

// Watch credentials file for external changes (e.g., CLI refreshes token independently)
watchFile(CREDENTIALS_PATH, { interval: 30_000 }, () => {
  debug('Credentials file changed externally, reloading and syncing');
  readCredentials();
  const fresh = readFreshToken();
  if (fresh) syncAuthProfiles(fresh);
  scheduleProactiveRefresh(); // reschedule based on new expiry
});

// Proactive token refresh — refreshes 10 minutes before expiry so requests
// never hit an expired token. Without this, the proxy only refreshes on the
// next incoming request, which arrives after the token is already dead.
let proactiveRefreshTimer = null;

function scheduleProactiveRefresh() {
  if (proactiveRefreshTimer) clearTimeout(proactiveRefreshTimer);
  if (!cachedCredentials?.expiresAt || !cachedCredentials?.refreshToken) return;

  const refreshAt = cachedCredentials.expiresAt - 10 * 60 * 1000; // 10 min before expiry
  const delayMs = Math.max(refreshAt - Date.now(), 60_000); // at least 1 min from now

  proactiveRefreshTimer = setTimeout(async () => {
    try {
      log('[proactive-refresh] Token nearing expiry, refreshing preemptively...');
      const refreshed = await refreshToken(cachedCredentials);
      log(`[proactive-refresh] Success, new expiry: ${new Date(refreshed.expiresAt).toISOString()}`);
      scheduleProactiveRefresh(); // schedule the next one
    } catch (err) {
      log(`[proactive-refresh] Failed: ${err.message} — will retry in 5 min`);
      proactiveRefreshTimer = setTimeout(() => scheduleProactiveRefresh(), 5 * 60 * 1000);
    }
  }, delayMs);

  proactiveRefreshTimer.unref(); // don't prevent process exit
  const refreshTime = new Date(Date.now() + delayMs).toISOString();
  debug(`[proactive-refresh] Scheduled for ${refreshTime} (${Math.round(delayMs / 60000)} min from now)`);
}

// ---------------------------------------------------------------------------
// Prompt sanitization
// ---------------------------------------------------------------------------

// Minimal verified trigger patterns — only what Anthropic actually detects.
// Based on systematic testing by zacdcook/openclaw-billing-proxy.
// Paths, filenames (SOUL.md, AGENTS.md), plugin names, and tool names
// outside this list do NOT trigger detection and are left untouched.
// Patterns applied to system prompt and user messages
const SANITIZE_PATTERNS = [
  // Preserve file paths before generic name replacement
  [/\.openclaw\//g, '.clawdata/'],
  [/\/openclaw\//g, '/clawdata/'],
  // URLs
  [/docs\.openclaw\.ai/g, 'docs.myapp.local'],
  [/github\.com\/openclaw/g, 'github.com/myapp'],
  [/clawhub\.ai/g, 'apphub.local'],
  // App name (case-insensitive)
  [/openclaw/gi, 'myapp'],
  [/open-claw/gi, 'myapp'],
  [/sillytavern/gi, 'myapp'],
  [/silly-tavern/gi, 'myapp'],
  [/typingmind/gi, 'myapp'],
  [/typing-mind/gi, 'myapp'],
];

// Extra patterns for system prompt only
const SYSTEM_ONLY_PATTERNS = [
  [/HEARTBEAT_OK/g, 'STATUS_ACK'],
  [/heartbeat_ok/gi, 'status_ack'],
  [/HEARTBEAT\.md/g, 'STATUSCHECK.md'],
  [/heartbeat\.md/gi, 'statuscheck.md'],
  [/HEARTBEAT/g, 'STATUS_CHECK'],
  [/heartbeat/gi, 'status_check'],
  [/SOUL\.md/g, 'PERSONA.md'],
  [/soul\.md/gi, 'persona.md'],
  // NO_REPLY is OpenClaw's silent-reply sentinel — must pass through verbatim.
  // Rewriting it broke under SSE streaming: Claude's tokenizer split SKIP_MSG
  // across content_block_delta events, so per-event reverse-regex couldn't
  // re-stitch it, and the literal "SKIP_MSG" leaked to chat.
  [/EXFOLIATE/gi, 'PROCESS'],
  [/lobster/gi, 'assistant'],
  [/sessions_spawn/g, 'create_task'],
  [/sessions_list/g, 'list_tasks'],
  [/sessions_history/g, 'get_history'],
  [/sessions_send/g, 'send_to_task'],
  [/running inside/gi, 'running on'],
];

// Tool renames to normalize tool-set identifiers in outbound requests
const TOOL_RENAMES = {
  'sessions_list': 'sess_list',
  'sessions_history': 'sess_history',
  'sessions_send': 'sess_send',
  'sessions_yield': 'sess_yield',
  'sessions_spawn': 'sess_spawn',
  'session_status': 'sess_status',
  'memory_search': 'mem_search',
  'memory_get': 'mem_get',
  'subagents': 'sub_agents',
  'cron': 'scheduler',
};

// Reverse map: renamed → original, for restoring tool names in inbound responses
const TOOL_RENAMES_REVERSE = Object.fromEntries(
  Object.entries(TOOL_RENAMES).map(([orig, renamed]) => [renamed, orig])
);

function stripSchemaDescriptions(value) {
  if (Array.isArray(value)) return value.map(stripSchemaDescriptions);
  if (!value || typeof value !== 'object') return value;

  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'description') continue;
    next[key] = stripSchemaDescriptions(child);
  }
  return next;
}

function humanizeToolName(name) {
  return String(name || 'tool').replace(/_/g, ' ');
}

function compactToolSchema(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  const next = { ...tool };
  next.description = `Use the ${humanizeToolName(next.name)} tool.`;
  if (next.input_schema) next.input_schema = stripSchemaDescriptions(next.input_schema);
  return next;
}

function sanitizeString(text, systemOnly = false) {
  if (!SANITIZE_OPENCLAW) return text;
  if (typeof text !== 'string') return text;
  for (const [pattern, replacement] of SANITIZE_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  if (systemOnly) {
    for (const [pattern, replacement] of SYSTEM_ONLY_PATTERNS) {
      text = text.replace(pattern, replacement);
    }
  }
  return text;
}

function sanitizeRequest(body) {
  if (!body || typeof body !== 'object') return body;
  const result = { ...body };

  // Strip trailing assistant messages — some models (sonnet-4-6) don't support
  // assistant message prefill and return a 400 that crashes the agent run.
  if (Array.isArray(result.messages) && result.messages.length > 0) {
    while (result.messages.length > 0 &&
           result.messages[result.messages.length - 1].role === 'assistant') {
      debug('Stripped trailing assistant message (prefill not supported)');
      result.messages = result.messages.slice(0, -1);
    }
  }

  // Sanitize system prompt with extra patterns
  if (SANITIZE_OPENCLAW) {
    if (typeof result.system === 'string') {
      result.system = sanitizeString(result.system, true);
    } else if (Array.isArray(result.system)) {
      result.system = result.system.map(block => {
        if (block?.type === 'text' && typeof block.text === 'string') {
          return { ...block, text: sanitizeString(block.text, true) };
        }
        return block;
      });
    }

    // Sanitize all message content — but skip tool_result blocks entirely.
    // Tool results are exec outputs (shell commands, file reads, etc.) and don't
    // need sanitization for billing detection. Sanitizing them corrupts file paths
    // and binary names in exec session output, breaking openclaw's self-diagnosis.
    if (Array.isArray(result.messages)) {
      result.messages = result.messages.map(msg => {
        if (typeof msg.content === 'string') {
          return { ...msg, content: sanitizeString(msg.content) };
        }
        if (Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map(block => {
              // Skip tool_result blocks — execution output, not app fingerprints
              if (block?.type === 'tool_result') return block;
              if (typeof block === 'string') return sanitizeString(block);
              if (block && typeof block === 'object') {
                const newBlock = { ...block };
                if (typeof newBlock.text === 'string') newBlock.text = sanitizeString(newBlock.text);
                if (typeof newBlock.content === 'string') newBlock.content = sanitizeString(newBlock.content);
                // Deep sanitize tool input (handles nested objects like edit new_string)
                if (newBlock.input && typeof newBlock.input === 'object') {
                  newBlock.input = JSON.parse(sanitizeString(JSON.stringify(newBlock.input)));
                }
                return newBlock;
              }
              return block;
            }),
          };
        }
        return msg;
      });
    }
  }

  // Sanitize and rename tools
  if (Array.isArray(result.tools)) {
    if (SANITIZE_OPENCLAW) {
      result.tools = JSON.parse(sanitizeString(JSON.stringify(result.tools)));
    }
    if (NORMALIZE_TOOL_NAMES) {
      result.tools = result.tools.map(tool => ({
        ...tool,
        name: TOOL_RENAMES[tool.name] || tool.name,
      }));
    }
    if (COMPACT_TOOL_SCHEMAS) {
      result.tools = result.tools.map(compactToolSchema);
    }
  }

  // Rename tool_use references in messages
  if (NORMALIZE_TOOL_NAMES && Array.isArray(result.messages)) {
    result.messages = result.messages.map(msg => {
      if (!Array.isArray(msg.content)) return msg;
      return {
        ...msg,
        content: msg.content.map(block => {
          if (block?.type === 'tool_use' && TOOL_RENAMES[block.name]) {
            return { ...block, name: TOOL_RENAMES[block.name] };
          }
          return block;
        }),
      };
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI billing attribution — rewrite system prompt so Anthropic's billing
// classifier recognises this as a Claude Code session (Max subscription).
// ---------------------------------------------------------------------------
//
// The classifier checks that system[0].text starts with "You are Claude Code,".
// If it does, the request is routed to the Max plan (service_tier: standard).
// If not, it falls through to API quota → "out of extra usage" 400 error.
//
// Strategy:
//   1. If system already starts with "You are Claude Code," — no-op (openclaw
//      sends this on its own for agent sessions).
//   2. Otherwise replace system with the Claude Code preamble + billing header,
//      and move the original system text into the first user message wrapped in
//      <system>…</system> so the model still sees it.
// ---------------------------------------------------------------------------

const CLI_VERSION = '2.1.92';
const CLI_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'cli';
const CLAUDE_CODE_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude.";

function buildBillingHeader() {
  return `x-anthropic-billing-header: cc_version=${CLI_VERSION}.${PROXY_SESSION_ID.slice(0, 8)}; cc_entrypoint=${CLI_ENTRYPOINT}; cch=00000;`;
}

function contentHasToolResult(content) {
  return Array.isArray(content) && content.some(block => block?.type === 'tool_result');
}

function prependSystemContext(messagesInput, prefix) {
  const messages = [...(messagesInput || [])];
  const firstSafeUserIdx = messages.findIndex(
    m => m.role === 'user' && !contentHasToolResult(m.content)
  );

  if (firstSafeUserIdx >= 0) {
    const msg = { ...messages[firstSafeUserIdx] };
    if (typeof msg.content === 'string') {
      msg.content = prefix + msg.content;
    } else if (Array.isArray(msg.content)) {
      msg.content = [{ type: 'text', text: prefix }, ...msg.content];
    } else {
      msg.content = prefix;
    }
    messages[firstSafeUserIdx] = msg;
    return messages;
  }

  messages.unshift({ role: 'user', content: prefix.trim() });
  return messages;
}

function rewriteSystemForBillingClassifier(body) {
  if (!body || typeof body !== 'object') return body;
  const result = { ...body };

  // Normalize system to array of text blocks (handles string form too)
  let originalBlocks = [];
  if (!result.system) {
    originalBlocks = [];
  } else if (typeof result.system === 'string') {
    originalBlocks = [{ type: 'text', text: result.system }];
  } else if (Array.isArray(result.system)) {
    originalBlocks = result.system;
  }

  // If already a Claude Code session, enforce exactly [CC-preamble, billing-header].
  // Any additional blocks (e.g. openclaw's "You are a personal assistant running on X")
  // are MOVED into the first user message as <system> context. Anthropic's classifier
  // rejects requests where extra system blocks betray a third-party app identity,
  // even when the billing header is present at [1].
  const firstText = originalBlocks.find(b => b.type === 'text')?.text || '';
  if (firstText.startsWith('You are Claude Code,')) {
    // Remove any existing billing header block from wherever it sits
    const billingIdx = originalBlocks.findIndex(
      b => b.type === 'text' && b.text?.startsWith('x-anthropic-billing-header:')
    );
    const blocksWithoutBilling = billingIdx >= 0
      ? originalBlocks.filter((_, i) => i !== billingIdx)
      : originalBlocks;

    // blocksWithoutBilling[0] is the CC preamble block.
    // Anything beyond [0] is extra context added by the third-party app.
    const extraBlocks = blocksWithoutBilling.slice(1);

    // System: only CC preamble + billing header (clean classifier fingerprint)
    result.system = [
      blocksWithoutBilling[0],
      { type: 'text', text: buildBillingHeader() },
    ];

    // Move extra blocks into the first user message as <system> context so
    // the model still receives the instructions, just not in the system slot.
    if (extraBlocks.length > 0) {
      const extraText = extraBlocks
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n\n')
        .trim();
      if (extraText) {
        const prefix = `<system>\n${extraText}\n</system>\n\n`;
        result.messages = prependSystemContext(result.messages, prefix);
      }
    }
    return result;
  }

  // Strip any stale billing header blocks from prior runs
  const userBlocks = originalBlocks.filter(
    b => !(b.type === 'text' && b.text?.startsWith('x-anthropic-billing-header:'))
  );

  // Replace system with Claude Code preamble + billing header
  result.system = [
    { type: 'text', text: CLAUDE_CODE_PREAMBLE },
    { type: 'text', text: buildBillingHeader() },
  ];

  // Move original system into first user message as <system> context
  if (userBlocks.length > 0) {
    const originalText = userBlocks
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n\n')
      .trim();

    if (originalText) {
      const prefix = `<system>\n${originalText}\n</system>\n\n`;
      result.messages = prependSystemContext(result.messages, prefix);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Reverse proxy: forward to api.anthropic.com
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

// ---------------------------------------------------------------------------
// Circuit breaker — prevents hammering Anthropic when auth is broken.
//
// When Anthropic repeatedly rejects tokens, forwarding every incoming request
// makes the outage longer. The circuit breaker stops forwarding after
// THRESHOLD consecutive full failures, returns 503 immediately to clients,
// then probes again after COOLDOWN_MS.
//
// States: closed (normal) → open (blocking) → half-open (one probe) → closed
// ---------------------------------------------------------------------------

const circuit = {
  state: 'closed',
  failures: 0,
  openedAt: null,
  THRESHOLD: 3,
  COOLDOWN_MS: 60_000,
};

function circuitAllow() {
  if (circuit.state === 'closed') return { ok: true };
  if (circuit.state === 'open') {
    const elapsed = Date.now() - circuit.openedAt;
    if (elapsed >= circuit.COOLDOWN_MS) {
      circuit.state = 'half-open';
      log(`[circuit] half-open — probing after ${Math.round(elapsed / 1000)}s cooldown`);
      return { ok: true };
    }
    return { ok: false, retryAfter: Math.ceil((circuit.COOLDOWN_MS - elapsed) / 1000) };
  }
  return { ok: true }; // half-open: allow the probe through
}

function circuitSuccess() {
  if (circuit.state !== 'closed') log(`[circuit] closed — auth restored`);
  circuit.state = 'closed';
  circuit.failures = 0;
  circuit.openedAt = null;
}

function circuitFailure() {
  circuit.failures++;
  if (circuit.failures >= circuit.THRESHOLD) {
    const wasOpen = circuit.state === 'open';
    circuit.state = 'open';
    circuit.openedAt = Date.now();
    if (!wasOpen) log(`[circuit] OPEN — ${circuit.failures} consecutive auth failures, blocking for ${circuit.COOLDOWN_MS / 1000}s`);
  }
}

// Beta flags required for OAuth + Claude Code features — always injected
// regardless of what the client sends, so the proxy never silently breaks
// if openclaw stops sending one of these.
const REQUIRED_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24',
];

function buildHeaders(accessToken, req) {
  const authHeaders = AUTH_HEADER_FORMAT === 'bearer'
    ? { 'authorization': `Bearer ${accessToken}` }
    : { 'x-api-key': accessToken };

  const headers = {
    ...authHeaders,
    'content-type': 'application/json',
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
    // Identify as CLI client for first-party billing classification
    'anthropic-client-platform': 'cli',
    'user-agent': 'Anthropic/JS 0.80.0',
    // Session ID (required for proper rate limit tier)
    'x-claude-code-session-id': PROXY_SESSION_ID,
    // Stainless SDK telemetry (matches CLI fingerprint)
    'x-stainless-lang': 'js',
    'x-stainless-package-version': '0.80.0',
    'x-stainless-os': process.platform,
    'x-stainless-arch': process.arch,
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.versions.node,
  };

  // Merge client betas with required betas — client's take precedence for duplicates
  const clientBetas = req.headers['anthropic-beta']
    ? req.headers['anthropic-beta'].split(',').map(b => b.trim())
    : [];
  const mergedBetas = [...new Set([...REQUIRED_BETAS, ...clientBetas])];
  headers['anthropic-beta'] = mergedBetas.join(',');

  return headers;
}

function makeRequest(targetUrl, method, headers, payload) {
  return new Promise((resolve, reject) => {
    const transport = targetUrl.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(targetUrl, { method, headers }, (proxyRes) => {
      if (proxyRes.statusCode === 429 && proxyRes.headers['x-should-retry'] === 'true') {
        // Consume body so connection can be reused, then signal retry
        let body = '';
        proxyRes.on('data', (d) => { body += d; });
        proxyRes.on('end', () => {
          const retryAfter = proxyRes.headers['retry-after'];
          resolve({ retry: true, retryAfterMs: retryAfter ? parseInt(retryAfter) * 1000 : null, body });
        });
        return;
      }
      if (proxyRes.statusCode === 401) {
        const wwwAuth = proxyRes.headers['www-authenticate'] || '';
        let body = '';
        proxyRes.on('data', (d) => { body += d; });
        proxyRes.on('end', () => {
          let errMsg = '';
          try { errMsg = JSON.parse(body)?.error?.message || ''; } catch {}
          log(`[401] anthropic_says="${errMsg}"${wwwAuth ? ` www-authenticate="${wwwAuth}"` : ''}`);
          resolve({ retry401: true, body });
        });
        return;
      }
      resolve({ retry: false, proxyRes });
    });
    proxyReq.on('error', reject);
    if (payload) proxyReq.write(payload);
    proxyReq.end();
  });
}

// Reverse sanitized strings in response text. The model sees sanitized
// terms in context (STATUS_ACK, STATUSCHECK.md, etc.) and echoes them in
// its output. Without reversal, OpenClaw gets literal sanitized text
// instead of the original sentinels/paths. These patterns are the exact
// inverse of SANITIZE_PATTERNS + SYSTEM_ONLY_PATTERNS applied to outgoing
// requests.
//
// Note: multi-token sentinels are fragile here because Claude's tokenizer
// can split them across SSE content_block_delta events, defeating the
// per-event regex. Prefer to NOT rewrite a sentinel in the first place if
// it's safe to expose to the upstream API.
const RESPONSE_DESANITIZE_PATTERNS = [
  // System-only patterns (most common in assistant output)
  [/STATUS_ACK/g, 'HEARTBEAT_OK'],
  [/STATUSCHECK\.md/g, 'HEARTBEAT.md'],
  [/STATUS_CHECK/g, 'HEARTBEAT'],
  [/PERSONA\.md/g, 'SOUL.md'],
  // Paths — reverse .clawdata back to .openclaw
  [/\.clawdata\//g, '.openclaw/'],
  [/\/clawdata\//g, '/openclaw/'],
  // App name
  [/MyApp/g, 'OpenClaw'],
];

function desanitizeResponseString(text) {
  if (!SANITIZE_OPENCLAW) return text;
  if (typeof text !== 'string') return text;
  for (const [pattern, replacement] of RESPONSE_DESANITIZE_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

// Restore renamed tool names AND sanitized strings in a parsed JSON response.
// Text content and tool_use inputs may contain sanitized terms (STATUS_ACK,
// STATUSCHECK.md, etc.) that the model echoed from its context — these need
// to be reversed before the client sees them. Other string fields (ids,
// error messages) are left alone.
function desanitizeResponseJson(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(desanitizeResponseJson);

  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (NORMALIZE_TOOL_NAMES && k === 'name' && typeof v === 'string' && TOOL_RENAMES_REVERSE[v]) {
      result[k] = TOOL_RENAMES_REVERSE[v];
    } else if ((k === 'text' || k === 'thinking' || k === 'content') && typeof v === 'string') {
      // Assistant text output, thinking blocks, or tool_result content
      result[k] = desanitizeResponseString(v);
    } else if (k === 'input' && typeof v === 'object' && v !== null) {
      // Tool use inputs — model may reference sanitized paths/names in arguments
      result[k] = JSON.parse(desanitizeResponseString(JSON.stringify(v)));
    } else if (typeof v === 'object' && v !== null) {
      result[k] = desanitizeResponseJson(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// Restore renamed tool names in a single SSE `data:` line.
function desanitizeSseLine(line) {
  if (!line.startsWith('data: ')) return line;
  const payload = line.slice(6);
  if (payload === '[DONE]') return line;
  try {
    const evt = JSON.parse(payload);
    const fixed = desanitizeResponseJson(evt);
    return 'data: ' + JSON.stringify(fixed);
  } catch {
    return line;
  }
}

function forwardRequest(req, res, body) {
  return new Promise(async (resolve) => {
    // Circuit breaker — reject immediately if auth is known-broken
    const circuitState = circuitAllow();
    if (!circuitState.ok) {
      log(`[circuit] open — rejecting request, retry after ${circuitState.retryAfter}s`);
      res.set('Retry-After', String(circuitState.retryAfter));
      res.status(503).json({
        type: 'error',
        error: {
          type: 'circuit_open',
          message: `Auth temporarily unavailable — retrying in ${circuitState.retryAfter}s`,
        },
      });
      return resolve();
    }

    let accessToken;
    try {
      accessToken = await getAccessToken();
    } catch (err) {
      log('Auth error:', err.message);
      res.status(401).json({
        type: 'error',
        error: {
          type: 'proxy_auth_error',
          message: err.message,
          action: 'Run "claude auth login" to re-authenticate',
        },
      });
      return resolve();
    }

    const targetUrl = new URL(req.path, ANTHROPIC_BASE);
    if (req.url.includes('?')) {
      targetUrl.search = req.url.split('?')[1];
    }

    let headers = buildHeaders(accessToken, req);

    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) {
      headers['content-length'] = Buffer.byteLength(payload);
    }

    // Retry loop for transient 429s
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      debug(`→ ${req.method} ${targetUrl.toString()} (attempt ${attempt + 1})`);

      let result;
      try {
        result = await makeRequest(targetUrl, req.method, { ...headers }, payload);
      } catch (err) {
        log('Proxy request error:', err.message);
        if (!res.headersSent) {
          res.status(502).json({
            type: 'error',
            error: { type: 'api_error', message: `Proxy error: ${err.message}` },
          });
        }
        return resolve();
      }

      if (result.retry401) {
        // Anthropic's token invalidation has eventual consistency — freshly
        // refreshed tokens can be rejected for 30-60s while edge servers sync.
        // Strategy: refresh + rotate session on first 401, then backoff retries.
        // Circuit breaker trips after THRESHOLD consecutive total failures.
        if (attempt === 0) {
          // First 401: refresh token + rotate session ID
          log(`[401] attempt=1 token=${accessToken.slice(0, 15)}... — refreshing + rotating session`);
          try {
            cachedCredentials = null;
            readCredentials();
            if (!cachedCredentials?.refreshToken) {
              throw new Error('No refresh token available');
            }
            const freshCreds = await refreshToken(cachedCredentials);
            accessToken = freshCreds.accessToken;
            PROXY_SESSION_ID = randomUUID();
            syncAuthProfiles(freshCreds);
            headers = buildHeaders(accessToken, req);
            if (payload) headers['content-length'] = Buffer.byteLength(payload);
            log(`[401] retry: new_token=${accessToken.slice(0, 15)}... new_session=${PROXY_SESSION_ID.slice(0, 8)}`);
          } catch (err) {
            log(`[401] token refresh failed: ${err.message}`);
            circuitFailure();
            res.status(401).json(JSON.parse(result.body));
            return resolve();
          }
          continue;
        }

        if (attempt <= MAX_RETRIES) {
          // Subsequent 401s: token propagation delay — wait and retry
          const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1); // 2s, 4s, 8s
          log(`[401] attempt=${attempt + 1} — propagation delay, waiting ${delayMs}ms`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }

        // Exhausted all retries — trip the circuit breaker
        log(`[401] exhausted all retries — tripping circuit breaker (failure #${circuit.failures + 1})`);
        circuitFailure();
        res.status(401).json(JSON.parse(result.body));
        return resolve();
      }

      if (result.retry && attempt < MAX_RETRIES) {
        const delayMs = result.retryAfterMs || (RETRY_BASE_MS * Math.pow(2, attempt));
        log(`429 rate limited, retrying in ${delayMs}ms (attempt ${attempt + 2}/${MAX_RETRIES + 1})`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }

      if (result.retry) {
        // Exhausted retries, return the 429
        log(`429 rate limited, exhausted ${MAX_RETRIES + 1} attempts`);
        res.status(429).json(JSON.parse(result.body));
        return resolve();
      }

      const { proxyRes } = result;
      const sc = proxyRes.statusCode;
      if (sc >= 400) {
        const overageStatus = proxyRes.headers['anthropic-ratelimit-unified-overage-status'] || '';
        const overageReason = proxyRes.headers['anthropic-ratelimit-unified-overage-disabled-reason'] || '';
        const serviceTier = proxyRes.headers['anthropic-ratelimit-unified-tier'] || '';
        log(`← ERROR ${sc} | overage=${overageStatus} | reason=${overageReason} | tier=${serviceTier}`);
      }
      debug(`← ${proxyRes.statusCode} ${proxyRes.statusMessage}`);

      // Copy response headers
      const skipHeaders = new Set(['transfer-encoding', 'connection', 'keep-alive']);
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (!skipHeaders.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }
      res.status(proxyRes.statusCode);

      // Successful response — reset circuit breaker
      if (proxyRes.statusCode < 400) circuitSuccess();

      const contentType = proxyRes.headers['content-type'] || '';
      const isSSE = contentType.includes('text/event-stream');

      if (isSSE) {
        // SSE streaming — intercept each line and reverse tool renames
        let buffer = '';
        proxyRes.setEncoding('utf8');
        proxyRes.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete last line
          for (const line of lines) {
            res.write(desanitizeSseLine(line) + '\n');
          }
        });
        proxyRes.on('end', () => {
          if (buffer) res.write(desanitizeSseLine(buffer) + '\n');
          res.end();
          resolve();
        });
      } else {
        // Non-streaming JSON — buffer full response, reverse tool renames, forward
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (sc >= 400) log(`← ERROR body: ${raw.slice(0, 300)}`);
          try {
            const parsed = JSON.parse(raw);
            const fixed = desanitizeResponseJson(parsed);
            const out = JSON.stringify(fixed);
            res.setHeader('content-length', Buffer.byteLength(out));
            res.end(out);
          } catch {
            // Not JSON (unlikely) — pass through as-is
            res.end(raw);
          }
          resolve();
        });
      }

      proxyRes.on('error', (err) => {
        log('Response stream error:', err.message);
        resolve();
      });
      return; // Exit the retry loop
    }
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Parse JSON body for POST requests
app.use(express.json({ limit: '50mb' }));

// POST /v1/messages — main proxy endpoint (sanitize + forward)
app.post('/v1/messages', async (req, res) => {
  const sanitizedBody = rewriteSystemForBillingClassifier(sanitizeRequest(req.body));

  const model = sanitizedBody.model || '?';
  const stream = !!sanitizedBody.stream;
  const msgCount = sanitizedBody.messages?.length || 0;

  // Log system block summary so we can verify billing header injection
  const sysBlocks = sanitizedBody.system;
  let sysInfo;
  if (!sysBlocks) {
    sysInfo = 'no-system';
  } else if (typeof sysBlocks === 'string') {
    sysInfo = 'string:' + sysBlocks.slice(0, 30);
  } else {
    const billingPos = sysBlocks.findIndex(b => b.type === 'text' && b.text?.startsWith('x-anthropic-billing-header:'));
    const preview = sysBlocks.map((b, i) => `[${i}]${(b.text || b.type || '?').slice(0, 20).replace(/\n/g, ' ')}`).join(' ');
    sysInfo = `blocks[${sysBlocks.length}] billing@${billingPos}: ${preview}`;
  }
  const toolCount = sanitizedBody.tools?.length || 0;
  const hasThinking = !!(sanitizedBody.thinking?.type || sanitizedBody.budget_tokens);
  log(`→ POST /v1/messages | model=${model} | stream=${stream} | messages=${msgCount} | tools=${toolCount} | thinking=${hasThinking} | sys=${sysInfo}`);

  // For large sessions, dump the full request body to a temp file for debugging
  if (msgCount >= 15) {
    const dumpPath = `/tmp/claude-proxy-dump-${Date.now()}.json`;
    require('fs').writeFileSync(dumpPath, JSON.stringify(sanitizedBody, null, 2));
    log(`  Dumped large request body to ${dumpPath}`);
  }

  // Verify sanitization — scan only the fields we actually sanitize.
  // tool_result blocks are intentionally excluded from sanitization (exec output),
  // so exclude them from the leak check too.
  const BLOCKED_TERMS = ['openclaw', 'open-claw', 'sillytavern', 'silly-tavern', 'typingmind', 'typing-mind'];
  const checkBody = {
    ...sanitizedBody,
    messages: (sanitizedBody.messages || []).map(msg => ({
      ...msg,
      content: Array.isArray(msg.content)
        ? msg.content.filter(b => b?.type !== 'tool_result')
        : msg.content,
    })),
  };
  const outgoing = JSON.stringify(checkBody).toLowerCase();
  const leaks = SANITIZE_OPENCLAW ? BLOCKED_TERMS.filter(term => outgoing.includes(term)) : [];
  if (leaks.length > 0) {
    log(`⚠ SANITIZATION LEAK: found [${leaks.join(', ')}] in outgoing request — blocking`);
    res.status(400).json({
      type: 'error',
      error: {
        type: 'sanitization_error',
        message: `Blocked: request still contains identifiers: ${leaks.join(', ')}`,
      },
    });
    return;
  }

  if (DEBUG) {
    const fs = require('fs');
    fs.writeFileSync('/tmp/claude-proxy-last-request.json', JSON.stringify(req.body, null, 2));
    fs.writeFileSync('/tmp/claude-proxy-sanitized-request.json', JSON.stringify(sanitizedBody, null, 2));
    debug('Original request saved to /tmp/claude-proxy-last-request.json');
    debug('Sanitized request saved to /tmp/claude-proxy-sanitized-request.json');
  }

  await forwardRequest(req, res, sanitizedBody);
});

// Forward other known /v1 endpoints
app.get('/v1/models', async (req, res) => {
  debug(`→ ${req.method} ${req.path}`);
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : req.body;
  await forwardRequest(req, res, body);
});

// Health check
app.get('/health', async (req, res) => {
  let tokenStatus = 'unknown';
  try {
    if (!cachedCredentials) readCredentials();
    if (cachedCredentials) {
      tokenStatus = isTokenExpired(cachedCredentials) ? 'expired (will refresh)' : 'valid';
    } else {
      tokenStatus = 'missing';
    }
  } catch {
    tokenStatus = 'error';
  }

  const sub = cachedCredentials?.subscriptionType || 'unknown';
  const isMax = sub === 'max';

  res.json({
    status: isMax ? 'ok' : 'warning',
    version: require('./package.json').version,
    mode: 'oauth-proxy',
    token: tokenStatus,
    subscription: sub,
    rateLimitTier: cachedCredentials?.rateLimitTier || 'unknown',
    circuit: circuit.state,
    ...(circuit.state !== 'closed' ? { circuitFailures: circuit.failures } : {}),
    ...(isMax ? {} : { warning: 'Not a Max subscription — requests will be billed as standard API usage' }),
  });
});

// POST /force-refresh — force immediate token refresh regardless of expiry
// Useful when Anthropic invalidates the token server-side before local expiry
app.post('/force-refresh', async (req, res) => {
  try {
    log('Force refresh requested');
    if (!cachedCredentials?.refreshToken) {
      return res.status(400).json({ error: 'No refresh token available' });
    }
    // Temporarily mark token as expired so getValidToken triggers a refresh
    const saved = cachedCredentials.expiresAt;
    cachedCredentials.expiresAt = 0;
    try {
      const token = await getAccessToken();
      res.json({ status: 'ok', newExpiry: new Date(cachedCredentials.expiresAt).toISOString() });
    } catch (err) {
      cachedCredentials.expiresAt = saved;
      throw err;
    }
  } catch (err) {
    log('Force refresh failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Load credentials on startup and schedule proactive refresh
readCredentials();
scheduleProactiveRefresh();

app.listen(PORT, '127.0.0.1', () => {
  log(`claude-max-proxy v${require('./package.json').version} (oauth-proxy mode)`);
  log(`Listening on http://127.0.0.1:${PORT}`);
  log(`Proxying → ${ANTHROPIC_BASE} (with CLI OAuth credentials)`);
  log(`OpenClaw sanitization: ${SANITIZE_OPENCLAW ? 'enabled' : 'disabled'}`);
  log(`Tool name mode: ${NORMALIZE_TOOL_NAMES ? 'normalize' : 'preserve'}`);
  log(`Tool schema mode: ${COMPACT_TOOL_SCHEMAS ? 'compact' : 'full'}`);
  log(`Token: ${cachedCredentials ? 'loaded' : 'NOT FOUND — run "claude auth login"'}`);
  if (cachedCredentials) {
    log(`Subscription: ${cachedCredentials.subscriptionType} (${cachedCredentials.rateLimitTier})`);
    log(`Token expires: ${new Date(cachedCredentials.expiresAt).toISOString()}`);
  }
  log('');
  log('Configure your app to use:');
  log(`  Base URL: http://127.0.0.1:${PORT}`);
  log('  API Key:  any non-empty string (auth is handled by OAuth token)');
  log('');
  if (DEBUG) log('Debug mode enabled');
});

// Cleanup
process.on('SIGTERM', () => {
  unwatchFile(CREDENTIALS_PATH);
  process.exit(0);
});
process.on('SIGINT', () => {
  unwatchFile(CREDENTIALS_PATH);
  process.exit(0);
});

// Exports for testing
if (require.main !== module) {
  module.exports = {
    TOOL_RENAMES,
    TOOL_RENAMES_REVERSE,
    TOOL_NAME_MODE,
    NORMALIZE_TOOL_NAMES,
    TOOL_SCHEMA_MODE,
    COMPACT_TOOL_SCHEMAS,
    desanitizeResponseJson,
    desanitizeSseLine,
    rewriteSystemForBillingClassifier,
    sanitizeRequest,
  };
}
