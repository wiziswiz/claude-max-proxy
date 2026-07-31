'use strict';

const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

const source = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');

assert.ok(
  !source.includes('accessToken.slice(0, 15)'),
  'index.js must not include an OAuth access-token prefix in logs'
);

const tokenLogLines = source
  .split('\n')
  .filter(line => /\b(?:log|debug)\s*\(/.test(line) && line.includes('accessToken'));

assert.deepStrictEqual(
  tokenLogLines,
  [],
  `index.js must not log OAuth access tokens:\n${tokenLogLines.join('\n')}`
);

assert.ok(
  source.includes('log(`[401] attempt=1 — refreshing + rotating session`);'),
  'the first 401 log must describe the refresh without exposing the token'
);

assert.ok(
  source.includes('log(`[401] retry: refreshed — new_session=${PROXY_SESSION_ID.slice(0, 8)}`);'),
  'the 401 retry log must retain the non-secret session ID fragment'
);

console.log('no-token-logging: all assertions passed');
