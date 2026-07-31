/**
 * Route-level integration tests for proxy-secret authentication.
 *
 * Boots the real express app on an ephemeral port with a stub upstream
 * (also ephemeral, local-only) and verifies:
 *   - Authorization: Bearer <secret> is accepted end-to-end
 *   - x-api-key: <secret> is accepted end-to-end (SDK-style clients)
 *   - wrong or missing secrets get 401 and never reach the upstream
 *   - /health stays open (no auth required)
 *   - /force-refresh requires the secret (watchdog path)
 *
 * No real credentials or network are touched: ANTHROPIC_TOKEN is set to a
 * fake value (bypasses the credentials file and Keychain) and
 * ANTHROPIC_BASE_URL points at the local stub upstream.
 */

'use strict';

const assert = require('assert');
const http = require('http');

const TEST_SECRET = 'route-test-proxy-secret';

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

(async () => {
  // Stub upstream "Anthropic" — must be listening before index.js is
  // required, because ANTHROPIC_BASE_URL is read at module load.
  let upstreamHits = 0;
  const upstream = http.createServer((req, resp) => {
    upstreamHits++;
    resp.writeHead(200, { 'content-type': 'application/json' });
    resp.end('{"id":"msg_test","type":"message","content":[{"type":"text","text":"ok"}]}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

  process.env.PROXY_SECRET = TEST_SECRET;
  process.env.ANTHROPIC_TOKEN = 'test-token-not-real';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;

  const { app } = require('../index.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const MESSAGES_BODY = JSON.stringify({
    model: 'claude-test',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });

  function postMessages(headers) {
    return fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: MESSAGES_BODY,
    });
  }

  console.log('\nRoute-level proxy-secret auth');

  await test('GET /health is open (no auth required)', async () => {
    const res = await fetch(`${base}/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.status, 'health body has a status field');
  });

  await test('POST /v1/messages with Authorization: Bearer <secret> reaches upstream', async () => {
    const before = upstreamHits;
    const res = await postMessages({ authorization: `Bearer ${TEST_SECRET}` });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.id, 'msg_test');
    assert.strictEqual(upstreamHits, before + 1);
  });

  await test('POST /v1/messages with x-api-key: <secret> reaches upstream', async () => {
    const before = upstreamHits;
    const res = await postMessages({ 'x-api-key': TEST_SECRET });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.id, 'msg_test');
    assert.strictEqual(upstreamHits, before + 1);
  });

  await test('POST /v1/messages with a wrong bearer secret gets 401 and never hits upstream', async () => {
    const before = upstreamHits;
    const res = await postMessages({ authorization: 'Bearer wrong-secret' });
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.error.type, 'unauthorized');
    assert.strictEqual(upstreamHits, before);
  });

  await test('POST /v1/messages with a wrong x-api-key gets 401 and never hits upstream', async () => {
    const before = upstreamHits;
    const res = await postMessages({ 'x-api-key': 'wrong-secret' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(upstreamHits, before);
  });

  await test('POST /v1/messages with no auth gets 401 and never hits upstream', async () => {
    const before = upstreamHits;
    const res = await postMessages({});
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.error.type, 'unauthorized');
    assert.strictEqual(upstreamHits, before);
  });

  await test('GET /v1/models with no auth gets 401', async () => {
    const res = await fetch(`${base}/v1/models`);
    assert.strictEqual(res.status, 401);
  });

  await test('POST /force-refresh with x-api-key passes auth (400 = no refresh token, not 401)', async () => {
    const res = await fetch(`${base}/force-refresh`, {
      method: 'POST',
      headers: { 'x-api-key': TEST_SECRET },
    });
    // ANTHROPIC_TOKEN-based credentials have no refresh token, so passing
    // auth yields the handler's 400 — proving requireSecret admitted us.
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(String(body.error).includes('No refresh token'));
  });

  await test('POST /force-refresh with no auth gets 401', async () => {
    const res = await fetch(`${base}/force-refresh`, { method: 'POST' });
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.error.type, 'unauthorized');
  });

  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => upstream.close(resolve));

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
