'use strict';

const assert = require('assert');

const {
  MAX_RETRIES,
  circuit,
  circuitAllow,
  circuitSuccess,
  circuitFailure,
  forwardRequest,
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

function makeRequest() {
  return {
    path: '/v1/messages',
    url: '/v1/messages',
    method: 'POST',
    headers: {},
  };
}

async function withTimeout(promise) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('forwardRequest did not resolve')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function retryDependencies(result, overrides = {}) {
  return {
    getAccessToken: async () => 'old-access-token',
    refreshAuth: async () => 'fresh-access-token',
    makeRequest: async () => result,
    sleep: async () => {},
    ...overrides,
  };
}

(async () => {
  console.log('\nCircuit breaker');

  await test('closed circuit allows requests', () => {
    resetCircuit();
    assert.deepStrictEqual(circuitAllow(), { ok: true });
  });

  await test('open circuit blocks requests before cooldown elapses', () => {
    resetCircuit();
    circuit.state = 'open';
    circuit.openedAt = Date.now();
    const result = circuitAllow();
    assert.strictEqual(result.ok, false);
    assert.ok(result.retryAfter > 0);
  });

  await test('half-open circuit admits exactly one probe', () => {
    resetCircuit();
    circuit.state = 'open';
    circuit.openedAt = Date.now() - circuit.COOLDOWN_MS;
    assert.deepStrictEqual(circuitAllow(), { ok: true });
    assert.strictEqual(circuit.state, 'half-open');
    assert.strictEqual(circuit.probeInFlight, true);
    assert.deepStrictEqual(circuitAllow(), { ok: false, retryAfter: 5 });
  });

  await test('circuitSuccess closes the circuit and clears the probe gate', () => {
    circuitSuccess();
    assert.strictEqual(circuit.state, 'closed');
    assert.strictEqual(circuit.failures, 0);
    assert.strictEqual(circuit.openedAt, null);
    assert.strictEqual(circuit.probeInFlight, false);
  });

  await test('failed half-open probe reopens the circuit and clears the probe gate', () => {
    resetCircuit();
    circuit.state = 'half-open';
    circuit.failures = circuit.THRESHOLD - 1;
    circuit.probeInFlight = true;
    circuitFailure();
    assert.strictEqual(circuit.state, 'open');
    assert.strictEqual(circuit.probeInFlight, false);
    assert.ok(circuit.openedAt <= Date.now());
  });

  console.log('\n401 retry handling');

  await test('persistent 401 reaches the terminal response after all attempts', async () => {
    resetCircuit();
    const res = makeResponse();
    const delays = [];
    let attempts = 0;
    const dependencies = retryDependencies(null, {
      makeRequest: async () => {
        attempts++;
        return { retry401: true, body: '{"error":"x"}' };
      },
      sleep: async delayMs => delays.push(delayMs),
    });

    await withTimeout(forwardRequest(makeRequest(), res, {}, dependencies));

    assert.strictEqual(attempts, MAX_RETRIES + 1);
    assert.deepStrictEqual(delays, [2000, 4000]);
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(res.body, { error: 'x' });
    assert.strictEqual(circuit.failures, 1);
  });

  await test('malformed terminal 401 body returns a structured error', async () => {
    resetCircuit();
    const res = makeResponse();
    await withTimeout(forwardRequest(
      makeRequest(),
      res,
      {},
      retryDependencies({ retry401: true, body: 'not-json' })
    ));
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.type, 'error');
    assert.strictEqual(res.body.error.type, 'upstream_error');
  });

  await test('malformed 401 body remains structured when token refresh fails', async () => {
    resetCircuit();
    const res = makeResponse();
    await withTimeout(forwardRequest(
      makeRequest(),
      res,
      {},
      retryDependencies({ retry401: true, body: 'not-json' }, {
        refreshAuth: async () => { throw new Error('refresh failed'); },
      })
    ));
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.error.type, 'upstream_error');
  });

  await test('malformed exhausted 429 body returns a structured error', async () => {
    resetCircuit();
    const res = makeResponse();
    await withTimeout(forwardRequest(
      makeRequest(),
      res,
      {},
      retryDependencies({ retry: true, retryAfterMs: 1, body: 'not-json' })
    ));
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.body.error.type, 'upstream_error');
  });

  resetCircuit();
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
