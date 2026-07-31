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

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
