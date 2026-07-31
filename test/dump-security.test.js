/**
 * Regression tests for secure debug conversation dumps.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEBUG_DUMP_MODE,
  shouldWriteLargeSessionDump,
  createDebugDumpPath,
  writeDump,
  createDebugDumpRegistry,
} = require('../index.js');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log('\nDebug dump gate');

test('large sessions do not dump when DEBUG is disabled', () => {
  assert.strictEqual(shouldWriteLargeSessionDump(false, 20), false);
});

test('DEBUG alone does not dump sessions below 15 messages', () => {
  assert.strictEqual(shouldWriteLargeSessionDump(true, 14), false);
});

test('DEBUG dumps sessions with 15 or more messages', () => {
  assert.strictEqual(shouldWriteLargeSessionDump(true, 15), true);
  assert.strictEqual(shouldWriteLargeSessionDump(true, 20), true);
});

console.log('\nDebug dump file security');

test('dump files are created with mode 0600', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-test-'));
  const dumpPath = path.join(directory, 'dump.json');
  try {
    writeDump(dumpPath, { secret: 'test-only' }, DEBUG_DUMP_MODE);
    assert.strictEqual(fs.statSync(dumpPath).mode & 0o777, 0o600);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(dumpPath, 'utf8')), { secret: 'test-only' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('dump filenames contain an eight-character random hex component', () => {
  const first = createDebugDumpPath('dump');
  const second = createDebugDumpPath('dump');
  assert.match(path.basename(first), /^claude-proxy-dump-\d+-[0-9a-f]{8}\.json$/);
  assert.match(path.basename(second), /^claude-proxy-dump-\d+-[0-9a-f]{8}\.json$/);
  assert.notStrictEqual(first, second);
  assert.strictEqual(path.dirname(first), os.tmpdir());
});

console.log('\nConcurrent dump cleanup');

test('a later request cleans completed dumps but preserves in-flight dumps', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-test-'));
  const firstPath = path.join(directory, 'first.json');
  const secondPath = path.join(directory, 'second.json');
  const registry = createDebugDumpRegistry();

  try {
    const firstRequest = registry.beginRequest();
    writeDump(firstPath, { request: 1 });
    firstRequest.add(firstPath);

    const secondRequest = registry.beginRequest();
    assert.strictEqual(fs.existsSync(firstPath), true, 'active first-request dump was removed');
    writeDump(secondPath, { request: 2 });
    secondRequest.add(secondPath);
    secondRequest.complete();

    registry.beginRequest();
    assert.strictEqual(fs.existsSync(secondPath), false, 'completed second-request dump was retained');
    assert.strictEqual(fs.existsSync(firstPath), true, 'in-flight first-request dump was removed');

    firstRequest.complete();
    registry.beginRequest();
    assert.strictEqual(fs.existsSync(firstPath), false, 'completed first-request dump was retained');
  } finally {
    registry.cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
