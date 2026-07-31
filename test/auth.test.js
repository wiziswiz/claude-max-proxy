/**
 * Regression tests for local bearer-secret authentication.
 */

'use strict';

const assert = require('assert');

const TEST_SECRET = 'test-proxy-secret';
process.env.PROXY_SECRET = TEST_SECRET;

const { requireSecret } = require('../index.js');

function makeResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

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

function authenticate(authorization, apiKey) {
  const req = { headers: {} };
  if (authorization !== undefined) req.headers.authorization = authorization;
  if (apiKey !== undefined) req.headers['x-api-key'] = apiKey;
  const res = makeResponse();
  let nextCalled = false;

  requireSecret(req, res, () => {
    nextCalled = true;
  });

  return { res, nextCalled };
}

console.log('\nBearer secret authentication');

test('passes with a matching Authorization bearer token', () => {
  const { res, nextCalled } = authenticate(`Bearer ${TEST_SECRET}`);
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test('rejects an absent Authorization header with 401', () => {
  const { res, nextCalled } = authenticate();
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.error.type, 'unauthorized');
});

test('rejects an incorrect bearer secret with 401', () => {
  const { res, nextCalled } = authenticate('Bearer wrong-proxy-secret');
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
});

test('rejects differing token lengths without throwing', () => {
  let result;
  assert.doesNotThrow(() => {
    result = authenticate('Bearer x');
  });
  assert.strictEqual(result.nextCalled, false);
  assert.strictEqual(result.res.statusCode, 401);
});

test('passes with a matching x-api-key header', () => {
  const { res, nextCalled } = authenticate(undefined, TEST_SECRET);
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test('rejects an incorrect x-api-key with 401', () => {
  const { res, nextCalled } = authenticate(undefined, 'wrong-proxy-secret');
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
});

test('rejects an empty x-api-key with 401', () => {
  const { res, nextCalled } = authenticate(undefined, '');
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
});

test('accepts a correct x-api-key even when Authorization is malformed', () => {
  const { res, nextCalled } = authenticate('Bearer wrong', TEST_SECRET);
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test('rejects a non-string (repeated) x-api-key header without throwing', () => {
  let result;
  assert.doesNotThrow(() => {
    result = authenticate(undefined, [TEST_SECRET, TEST_SECRET]);
  });
  assert.strictEqual(result.nextCalled, false);
  assert.strictEqual(result.res.statusCode, 401);
});

test('rejects a non-string (repeated) Authorization header with 401, not a TypeError', () => {
  // Array-shaped Authorization (e.g. repeated header lines) must fail auth
  // cleanly — before the guard, .startsWith on the array threw a TypeError.
  let result;
  assert.doesNotThrow(() => {
    result = authenticate([`Bearer ${TEST_SECRET}`, `Bearer ${TEST_SECRET}`]);
  });
  assert.strictEqual(result.nextCalled, false);
  assert.strictEqual(result.res.statusCode, 401);
  assert.strictEqual(result.res.body.error.type, 'unauthorized');
});

console.log('\nProxy secret charset validation at startup');

test('refuses to start when the proxy secret contains characters outside [A-Za-z0-9_-]', () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [require.resolve('../index.js')], {
    env: { ...process.env, PROXY_TEST: '1', PROXY_SECRET: 'bad secret with spaces & <xml>' },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}`);
  assert.match(r.stderr, /outside \[A-Za-z0-9_-\]/);
  // Never echo the secret value back in the error output
  assert.ok(!r.stderr.includes('bad secret with spaces'), 'error output must not contain the secret value');
});

test('starts cleanly with a valid [A-Za-z0-9_-] secret', () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [require.resolve('../index.js')], {
    env: { ...process.env, PROXY_TEST: '1', PROXY_SECRET: 'valid_secret-123' },
    encoding: 'utf8',
    timeout: 15000,
  });
  // Under PROXY_TEST the module loads, skips listen, and exits 0 — proving
  // the charset gate admits a valid secret.
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
