'use strict';

// Verifies openclaw-auth-watchdog Check 1 (plist env repair) against real
// plists using the same native tools the watchdog uses (PlistBuddy/plutil).
// The watchdog exposes repair_plist_env() when sourced (its source-guard stops
// before any live check runs), so each scenario sources the script and calls
// the function against a throwaway fixture plist.
//
// Layouts covered: xml1 pretty, EnvironmentVariables NOT last with a nested
// dict after it, CRLF line endings, self-closing <string/> value, binary1.
// Behaviors covered: insert, sync (legacy placeholder), idempotent rerun,
// verify-failure reporting (write blocked -> ERROR, never CHANGED), and the
// no-secret paths (existing key -> stale warning; absent key -> NOSECRET skip).

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLISTBUDDY = '/usr/libexec/PlistBuddy';

if (process.platform !== 'darwin' || !fs.existsSync(PLISTBUDDY)) {
  console.log('watchdog-plist: skipped (requires macOS PlistBuddy/plutil)');
  process.exit(0);
}

const WATCHDOG = path.join(__dirname, '..', 'openclaw-auth-watchdog');
const SECRET = 'fake_test_secret_0123456789abcdef'; // fake; charset-valid [A-Za-z0-9_-]
const BASE_URL = 'http://127.0.0.1:4523';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-plist-'));

function plistXml({ apiKey = null, envNotLast = false, selfClosingKey = false } = {}) {
  const keyEntry = selfClosingKey
    ? '\t\t<key>ANTHROPIC_API_KEY</key>\n\t\t<string/>\n'
    : apiKey !== null
      ? `\t\t<key>ANTHROPIC_API_KEY</key>\n\t\t<string>${apiKey}</string>\n`
      : '';
  const envDict =
    '\t<key>EnvironmentVariables</key>\n' +
    '\t<dict>\n' +
    `\t\t<key>ANTHROPIC_BASE_URL</key>\n\t\t<string>${BASE_URL}</string>\n` +
    keyEntry +
    '\t</dict>\n';
  const trailing =
    '\t<key>KeepAlive</key>\n' +
    '\t<dict>\n' +
    '\t\t<key>SuccessfulExit</key>\n' +
    '\t\t<false/>\n' +
    '\t</dict>\n' +
    '\t<key>RunAtLoad</key>\n' +
    '\t<true/>\n';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '<dict>\n' +
    '\t<key>Label</key>\n\t<string>ai.openclaw.gateway</string>\n' +
    '\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/usr/bin/true</string>\n\t</array>\n' +
    (envNotLast ? envDict + trailing : trailing + envDict) +
    '</dict>\n' +
    '</plist>\n'
  );
}

let fixtureCount = 0;
function writeFixture(xml, { crlf = false, binary = false } = {}) {
  const p = path.join(tmpDir, `fixture-${fixtureCount++}.plist`);
  fs.writeFileSync(p, crlf ? xml.replace(/\n/g, '\r\n') : xml);
  if (binary) {
    const conv = spawnSync('plutil', ['-convert', 'binary1', p], { encoding: 'utf8' });
    assert.strictEqual(conv.status, 0, `plutil -convert binary1 failed: ${conv.stderr}`);
  }
  return p;
}

// Source the watchdog (stops at its source-guard) and call repair_plist_env.
function runRepair(plist, secret) {
  const script = [
    'source "$WATCHDOG_PATH"',
    'LOG="$TEST_LOG"',
    'repair_plist_env "$FIXTURE_PLIST"',
    'rc=$?',
    'echo "RC=$rc"',
    'echo "REPAIRED=$REPAIRED"',
  ].join('\n');
  const res = spawnSync('/bin/bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WATCHDOG_PATH: WATCHDOG,
      TEST_LOG: path.join(tmpDir, 'watchdog.log'),
      FIXTURE_PLIST: plist,
      PROXY_SECRET: secret,
    },
  });
  assert.strictEqual(res.status, 0, `bash harness failed: ${res.stderr}`);
  return res.stdout;
}

function readKey(plist, keyPath) {
  const res = spawnSync(PLISTBUDDY, ['-c', `Print :${keyPath}`, plist], { encoding: 'utf8' });
  return { ok: res.status === 0, value: res.stdout.replace(/\n$/, '') };
}

function lint(plist) {
  return spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' }).status === 0;
}

const outputs = [];
function repair(plist, secret) {
  const out = runRepair(plist, secret);
  outputs.push(out);
  return out;
}

// ── 1. xml1 pretty, key absent → insert, verify, 0600, REPAIRED=1 ────────────
{
  const p = writeFixture(plistXml());
  const out = repair(p, SECRET);
  assert.ok(out.includes('Added ANTHROPIC_API_KEY'), `insert not reported:\n${out}`);
  assert.ok(out.includes('plist env vars repaired'), `repaired not reported:\n${out}`);
  assert.ok(out.includes('RC=0') && out.includes('REPAIRED=1'), `bad rc/repaired:\n${out}`);
  assert.strictEqual(readKey(p, 'EnvironmentVariables:ANTHROPIC_API_KEY').value, SECRET);
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600, 'plist must be chmod 0600 after modification');

  // ── 2. idempotent rerun → OK/in-sync, no repair claimed ────────────────────
  const rerun = repair(p, SECRET);
  assert.ok(rerun.includes('OK: plist env vars present and in sync'), `rerun not OK:\n${rerun}`);
  assert.ok(!rerun.includes('repaired'), `rerun must not claim a repair:\n${rerun}`);
  assert.ok(rerun.includes('REPAIRED=0'), `rerun must not set REPAIRED:\n${rerun}`);
}

// ── 3. xml1 pretty, legacy placeholder → synchronized ────────────────────────
{
  const p = writeFixture(plistXml({ apiKey: 'claude-max-proxy' }));
  const out = repair(p, SECRET);
  assert.ok(out.includes('Synchronized ANTHROPIC_API_KEY'), `sync not reported:\n${out}`);
  assert.ok(out.includes('REPAIRED=1'), `sync must set REPAIRED:\n${out}`);
  assert.strictEqual(readKey(p, 'EnvironmentVariables:ANTHROPIC_API_KEY').value, SECRET);
}

// ── 4. EnvironmentVariables NOT last + nested dict after it ──────────────────
// The old regex surgery keyed off the closing "</dict>\n</dict>" sequence;
// assert the key lands under EnvironmentVariables, never in the nested dict.
{
  const p = writeFixture(plistXml({ envNotLast: true }));
  const out = repair(p, SECRET);
  assert.ok(out.includes('Added ANTHROPIC_API_KEY'), `env-not-last insert failed:\n${out}`);
  assert.strictEqual(readKey(p, 'EnvironmentVariables:ANTHROPIC_API_KEY').value, SECRET);
  assert.ok(!readKey(p, 'KeepAlive:ANTHROPIC_API_KEY').ok, 'nested KeepAlive dict must not receive the key');
  assert.ok(lint(p), 'plist must stay valid');
}

// ── 5. CRLF line endings → sync still lands (old code silently no-opped) ─────
{
  const p = writeFixture(plistXml({ apiKey: 'claude-max-proxy' }), { crlf: true });
  const out = repair(p, SECRET);
  assert.ok(out.includes('Synchronized ANTHROPIC_API_KEY'), `CRLF sync failed:\n${out}`);
  assert.strictEqual(readKey(p, 'EnvironmentVariables:ANTHROPIC_API_KEY').value, SECRET);
}

// ── 6. self-closing <string/> value → sync, no duplicate keys ────────────────
{
  const p = writeFixture(plistXml({ selfClosingKey: true }));
  const out = repair(p, SECRET);
  assert.ok(out.includes('Synchronized ANTHROPIC_API_KEY'), `self-closing sync failed:\n${out}`);
  assert.strictEqual(readKey(p, 'EnvironmentVariables:ANTHROPIC_API_KEY').value, SECRET);
  const xml = spawnSync('plutil', ['-convert', 'xml1', '-o', '-', p], { encoding: 'utf8' }).stdout;
  const occurrences = xml.split('ANTHROPIC_API_KEY').length - 1;
  assert.strictEqual(occurrences, 1, `duplicate ANTHROPIC_API_KEY entries:\n${xml}`);
}

// ── 7. BINARY plist → insert and sync both work, file stays valid ────────────
{
  const p = writeFixture(plistXml(), { binary: true });
  const out = repair(p, SECRET);
  assert.ok(out.includes('Added ANTHROPIC_API_KEY'), `binary insert failed:\n${out}`);
  assert.strictEqual(readKey(p, 'EnvironmentVariables:ANTHROPIC_API_KEY').value, SECRET);
  assert.ok(lint(p), 'binary plist must stay valid');

  const p2 = writeFixture(plistXml({ apiKey: 'claude-max-proxy' }), { binary: true });
  const out2 = repair(p2, SECRET);
  assert.ok(out2.includes('Synchronized ANTHROPIC_API_KEY'), `binary sync failed:\n${out2}`);
  assert.strictEqual(readKey(p2, 'EnvironmentVariables:ANTHROPIC_API_KEY').value, SECRET);
}

// ── 8. verify-failure → ERROR reported, never a false CHANGED ────────────────
// Block the write (read-only file in a read-only dir covers both in-place and
// atomic-rename save strategies). Root ignores modes, so skip under root.
if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
  const roDir = path.join(tmpDir, 'ro');
  fs.mkdirSync(roDir);
  const p = path.join(roDir, 'fixture-ro.plist');
  fs.writeFileSync(p, plistXml({ apiKey: 'claude-max-proxy' }));
  fs.chmodSync(p, 0o444);
  fs.chmodSync(roDir, 0o555);
  try {
    const out = repair(p, SECRET);
    assert.ok(
      out.includes('ERROR: plist write for ANTHROPIC_API_KEY did not verify'),
      `verify failure not reported:\n${out}`
    );
    assert.ok(!out.includes('plist env vars repaired'), `must not claim a repair on verify failure:\n${out}`);
    assert.ok(out.includes('RC=1') && out.includes('REPAIRED=0'), `bad rc/repaired on verify failure:\n${out}`);
    assert.strictEqual(
      readKey(p, 'EnvironmentVariables:ANTHROPIC_API_KEY').value,
      'claude-max-proxy',
      'blocked write must leave the plist untouched'
    );
  } finally {
    fs.chmodSync(roDir, 0o755);
    fs.chmodSync(p, 0o644);
  }
} else {
  console.log('watchdog-plist: verify-failure scenario skipped (running as root)');
}

// ── 9. no secret + key EXISTS → stale warning, never "in sync" ───────────────
{
  const p = writeFixture(plistXml({ apiKey: 'claude-max-proxy' }));
  const out = repair(p, '');
  assert.ok(
    out.includes('cannot verify/sync ANTHROPIC_API_KEY') && out.includes('may be stale'),
    `stale warning missing:\n${out}`
  );
  assert.ok(!out.includes('in sync'), `must not claim in-sync without a secret:\n${out}`);
  assert.ok(out.includes('REPAIRED=0'), `no-secret path must not repair:\n${out}`);
  assert.strictEqual(readKey(p, 'EnvironmentVariables:ANTHROPIC_API_KEY').value, 'claude-max-proxy');
}

// ── 10. no secret + key ABSENT → NOSECRET skip warning, no write ─────────────
{
  const p = writeFixture(plistXml());
  const out = repair(p, '');
  assert.ok(
    out.includes('missing ANTHROPIC_API_KEY but no proxy secret is resolvable'),
    `NOSECRET warning missing:\n${out}`
  );
  assert.ok(!out.includes('in sync'), `must not claim in-sync without a secret:\n${out}`);
  assert.ok(!readKey(p, 'EnvironmentVariables:ANTHROPIC_API_KEY').ok, 'no-secret path must not write a key');
}

// ── Hygiene: the secret value must never appear in watchdog output ───────────
for (const out of outputs) {
  assert.ok(!out.includes(SECRET), `watchdog output leaked the secret:\n${out}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('watchdog-plist: all assertions passed');
