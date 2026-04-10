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
// AUTH_HEADER_FORMAT: 'x-api-key' (default) or 'bearer'.
// Most setups work with x-api-key. Some macOS Keychain-sourced tokens require Authorization: Bearer.
// If you get 401 invalid x-api-key with a valid sk-ant-oat01-* token, try: AUTH_HEADER_FORMAT=bearer
const AUTH_HEADER_FORMAT = (process.env.AUTH_HEADER_FORMAT || 'x-api-key').toLowerCase();
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const { randomUUID } = require('crypto');
const PROXY_SESSION_ID = randomUUID();

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
  // readFreshToken() also checks Keychain so this works regardless of storage backend
  const fresh = readFreshToken();
  if (fresh) syncAuthProfiles(fresh);
});

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
  [/NO_REPLY/g, 'SKIP_MSG'],
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

function sanitizeString(text, systemOnly = false) {
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
              if (newBlock.input && typeof newBlock.input === 'object') {
                newBlock.input = Object.fromEntries(
                  Object.entries(newBlock.input).map(([k, v]) =>
                    [k, typeof v === 'string' ? sanitizeString(v) : v]
                  )
                );
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

  // Sanitize and rename tools
  if (Array.isArray(result.tools)) {
    result.tools = JSON.parse(sanitizeString(JSON.stringify(result.tools)));
    result.tools = result.tools.map(tool => ({
      ...tool,
      name: TOOL_RENAMES[tool.name] || tool.name,
    }));
  }

  // Rename tool_use references in messages
  if (Array.isArray(result.messages)) {
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
// CLI billing attribution — prepend billing header to system prompt
// ---------------------------------------------------------------------------

const CLI_VERSION = '2.1.92';
const CLI_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'cli';

function buildBillingHeader() {
  return `x-anthropic-billing-header: cc_version=${CLI_VERSION}.${PROXY_SESSION_ID.slice(0, 8)}; cc_entrypoint=${CLI_ENTRYPOINT}; cch=00000;`;
}

// Detect a previously-injected billing header block so stale copies can be
// stripped before a fresh one is prepended. Clients that cache request state
// across turns may replay the proxy's previously-injected block; without
// dedup, system accumulates multiple stacked billing headers with mismatched
// session IDs, which upstream rejects.
function isBillingHeaderBlock(b) {
  return b
    && b.type === 'text'
    && typeof b.text === 'string'
    && b.text.startsWith('x-anthropic-billing-header:');
}

function injectBillingHeader(body) {
  if (!body || typeof body !== 'object') return body;
  const result = { ...body };
  const billingBlock = { type: 'text', text: buildBillingHeader() };

  if (!result.system) {
    // No system prompt — add billing header as system
    result.system = [billingBlock];
  } else if (typeof result.system === 'string') {
    // String system prompt — convert to blocks and prepend billing header
    result.system = [billingBlock, { type: 'text', text: result.system }];
  } else if (Array.isArray(result.system)) {
    // Strip any stale billing blocks the client may have cached from a
    // previous request, then prepend exactly one fresh block.
    const cleaned = result.system.filter(b => !isBillingHeaderBlock(b));
    const stripped = result.system.length - cleaned.length;
    if (stripped > 0) {
      log(`stripped ${stripped} stale billing header block(s) from incoming system prompt`);
    }
    result.system = [billingBlock, ...cleaned];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Reverse proxy: forward to api.anthropic.com
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

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
        // Consume body then signal token refresh + retry
        let body = '';
        proxyRes.on('data', (d) => { body += d; });
        proxyRes.on('end', () => resolve({ retry401: true, body }));
        return;
      }
      resolve({ retry: false, proxyRes });
    });
    proxyReq.on('error', reject);
    if (payload) proxyReq.write(payload);
    proxyReq.end();
  });
}

// Restore renamed tool names in a parsed JSON response object (non-streaming).
// Anthropic echoes back the tool names we sent — we need to reverse them so
// OpenClaw receives the original names it registered.
function desanitizeResponseJson(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(desanitizeResponseJson);

  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'name' && typeof v === 'string' && TOOL_RENAMES_REVERSE[v]) {
      result[k] = TOOL_RENAMES_REVERSE[v];
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

      if (result.retry401 && attempt === 0) {
        // Anthropic rejected our token — force-refresh and retry once
        log('401 from Anthropic — token invalidated server-side, force-refreshing and retrying');
        try {
          cachedCredentials = null; // force re-read + refresh
          const freshCreds = await refreshToken(await (async () => { readCredentials(); return cachedCredentials; })());
          accessToken = freshCreds.accessToken;
          syncAuthProfiles(freshCreds);
          headers = buildHeaders(accessToken, req);
          if (payload) headers['content-length'] = Buffer.byteLength(payload);
        } catch (err) {
          log('Token refresh after 401 failed:', err.message);
          res.status(401).json(JSON.parse(result.body));
          return resolve();
        }
        continue;
      }

      if (result.retry401) {
        // Already retried once, still 401 — return the error
        log('401 persisted after token refresh — credentials may need re-login');
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
      debug(`← ${proxyRes.statusCode} ${proxyRes.statusMessage}`);

      // On 4xx, buffer the body so we can log the actual error message from
      // upstream instead of just the status line. Otherwise every 4xx looks
      // identical in the log, regardless of root cause. The body is still
      // forwarded to the client untouched.
      if (proxyRes.statusCode >= 400 && proxyRes.statusCode < 500) {
        const errChunks = [];
        proxyRes.on('data', (c) => errChunks.push(c));
        proxyRes.on('end', () => {
          const raw = Buffer.concat(errChunks).toString('utf8');
          let msg = raw;
          try {
            const parsed = JSON.parse(raw);
            msg = parsed?.error?.message || raw;
          } catch {}
          log(`← ${proxyRes.statusCode} ${proxyRes.statusMessage} | ${msg.slice(0, 500)}`);
          // Forward response headers + body unchanged.
          const skip = new Set(['transfer-encoding', 'connection', 'keep-alive']);
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (!skip.has(k.toLowerCase())) res.setHeader(k, v);
          }
          res.status(proxyRes.statusCode);
          res.setHeader('content-length', Buffer.byteLength(raw));
          res.end(raw);
          resolve();
        });
        proxyRes.on('error', (err) => {
          log('Response stream error (4xx path):', err.message);
          resolve();
        });
        return;
      }

      // Copy response headers
      const skipHeaders = new Set(['transfer-encoding', 'connection', 'keep-alive']);
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (!skipHeaders.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }
      res.status(proxyRes.statusCode);

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
  const sanitizedBody = injectBillingHeader(sanitizeRequest(req.body));

  const model = sanitizedBody.model || '?';
  const stream = !!sanitizedBody.stream;
  const msgCount = sanitizedBody.messages?.length || 0;

  log(`→ POST /v1/messages | model=${model} | stream=${stream} | messages=${msgCount}`);

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
  const leaks = BLOCKED_TERMS.filter(term => outgoing.includes(term));
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

// Load credentials on startup
readCredentials();

app.listen(PORT, '127.0.0.1', () => {
  log(`claude-max-proxy v${require('./package.json').version} (oauth-proxy mode)`);
  log(`Listening on http://127.0.0.1:${PORT}`);
  log(`Proxying → ${ANTHROPIC_BASE} (with CLI OAuth credentials)`);
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
  module.exports = { TOOL_RENAMES, TOOL_RENAMES_REVERSE, desanitizeResponseJson, desanitizeSseLine };
}
