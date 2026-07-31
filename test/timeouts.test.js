/**
 * Regression tests for upstream timeout handling and Retry-After capping.
 *
 * - Upstream timeout errors map to 504 gateway_timeout (not a generic 502).
 * - Non-timeout transport errors still map to 502 api_error.
 * - Retry-After values are capped at MAX_RETRY_AFTER_MS in both makeRequest
 *   (header parsing) and forwardRequest (429 retry delay).
 */

'use strict';

const assert = require('assert');
const http = require('http');

const {
  MAX_RETRY_AFTER_MS,
  forwardRequest,
  makeRequest,
  circuit,
} = require('../index.js');

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${err.stack || err.message}`);
    failed++;
  }
}

function resetCircuit() {
  circuit.state = 'closed';
  circuit.failures = 0;
  circuit.openedAt = null;
  circuit.probeInFlight = false;
}

function makeResponse() {
  return {
    headers: {},
    headersSent: false,
    statusCode: null,
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
  };
}

function makeReq() {
  return {
    path: '/v1/messages',
    url: '/v1/messages',
    method: 'POST',
    headers: {},
  };
}

function dependencies(overrides = {}) {
  return {
    getAccessToken: async () => 'test-access-token',
    refreshAuth: async () => 'fresh-access-token',
    sleep: async () => {},
    ...overrides,
  };
}

(async () => {
  console.log('\nTimeout error mapping');

  await test('upstream timeout error maps to 504 gateway_timeout', async () => {
    resetCircuit();
    const res = makeResponse();
    await forwardRequest(makeReq(), res, {}, dependencies({
      makeRequest: async () => { throw new Error('Connect timeout after 10000ms'); },
    }));
    assert.strictEqual(res.statusCode, 504);
    assert.strictEqual(res.body.type, 'error');
    assert.strictEqual(res.body.error.type, 'gateway_timeout');
    assert.ok(res.body.error.message.includes('timeout'));
  });

  await test('response timeout error also maps to 504 gateway_timeout', async () => {
    resetCircuit();
    const res = makeResponse();
    await forwardRequest(makeReq(), res, {}, dependencies({
      makeRequest: async () => { throw new Error('Response timeout after 600000ms'); },
    }));
    assert.strictEqual(res.statusCode, 504);
    assert.strictEqual(res.body.error.type, 'gateway_timeout');
  });

  await test('non-timeout upstream error maps to 502 api_error', async () => {
    resetCircuit();
    const res = makeResponse();
    await forwardRequest(makeReq(), res, {}, dependencies({
      makeRequest: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:443'); },
    }));
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.body.type, 'error');
    assert.strictEqual(res.body.error.type, 'api_error');
  });

  console.log('\nRetry-After capping');

  await test('forwardRequest caps oversized retryAfterMs at MAX_RETRY_AFTER_MS', async () => {
    resetCircuit();
    const res = makeResponse();
    const delays = [];
    let calls = 0;
    await forwardRequest(makeReq(), res, {}, dependencies({
      makeRequest: async () => {
        calls++;
        return { retry: true, retryAfterMs: MAX_RETRY_AFTER_MS * 100, body: '{"error":"rate_limited"}' };
      },
      sleep: async (delayMs) => delays.push(delayMs),
    }));
    assert.ok(calls > 1, 'expected at least one retry');
    assert.ok(delays.length > 0, 'expected retry delays to be recorded');
    for (const delayMs of delays) {
      assert.ok(
        delayMs <= MAX_RETRY_AFTER_MS,
        `retry delay ${delayMs}ms exceeds cap ${MAX_RETRY_AFTER_MS}ms`
      );
    }
    assert.strictEqual(res.statusCode, 429);
  });

  await test('makeRequest caps an oversized Retry-After header at MAX_RETRY_AFTER_MS', async () => {
    const server = http.createServer((req, resp) => {
      resp.writeHead(429, {
        'x-should-retry': 'true',
        'retry-after': String(Math.ceil((MAX_RETRY_AFTER_MS * 10) / 1000)),
        'content-type': 'application/json',
      });
      resp.end('{"error":"rate_limited"}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const result = await makeRequest(
        new URL(`http://127.0.0.1:${port}/v1/messages`),
        'POST',
        { 'content-type': 'application/json' },
        '{}'
      );
      assert.strictEqual(result.retry, true);
      assert.strictEqual(result.retryAfterMs, MAX_RETRY_AFTER_MS);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await test('makeRequest passes through a small Retry-After header uncapped', async () => {
    const server = http.createServer((req, resp) => {
      resp.writeHead(429, {
        'x-should-retry': 'true',
        'retry-after': '2',
        'content-type': 'application/json',
      });
      resp.end('{"error":"rate_limited"}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const result = await makeRequest(
        new URL(`http://127.0.0.1:${port}/v1/messages`),
        'POST',
        { 'content-type': 'application/json' },
        '{}'
      );
      assert.strictEqual(result.retry, true);
      assert.strictEqual(result.retryAfterMs, 2000);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  resetCircuit();
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
