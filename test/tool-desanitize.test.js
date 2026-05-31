/**
 * Regression tests for tool name normalization round-trip.
 *
 * The proxy renames OpenClaw tools outbound and must restore original
 * names on inbound Anthropic responses (both JSON and SSE).
 * If restoration breaks, OpenClaw receives unknown tool names and gets
 * stuck in a retry loop (e.g. "Tool sess_spawn not found").
 */

'use strict';

const assert = require('assert');

// ── Pull the maps directly from the proxy ────────────────────────────────────
const {
  TOOL_RENAMES,
  TOOL_RENAMES_REVERSE,
  COMPACT_TOOL_SCHEMAS,
  NORMALIZE_TOOL_NAMES,
  desanitizeResponseJson,
  desanitizeSseLine,
  rewriteSystemForBillingClassifier,
  sanitizeRequest,
} = require('../index.js');

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeToolUseJson(name) {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_test', name, input: {} }],
  };
}

function makeSseLine(name) {
  return 'data: ' + JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'tu_test', name, input: {} },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────
const TOOLS_TO_TEST = [
  ['sessions_spawn',   'sess_spawn'],
  ['sessions_send',    'sess_send'],
  ['sessions_list',    'sess_list'],
  ['sessions_history', 'sess_history'],
  ['sessions_yield',   'sess_yield'],
  ['session_status',   'sess_status'],
  ['memory_search',    'mem_search'],
  ['memory_get',       'mem_get'],
  ['subagents',        'sub_agents'],
  ['cron',             'scheduler'],
];

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

console.log('\nTool rename map integrity');
for (const [orig, renamed] of TOOLS_TO_TEST) {
  test(`TOOL_RENAMES: ${orig} → ${renamed}`, () => {
    assert.strictEqual(TOOL_RENAMES[orig], renamed, `Expected TOOL_RENAMES['${orig}'] = '${renamed}'`);
  });
  test(`TOOL_RENAMES_REVERSE: ${renamed} → ${orig}`, () => {
    assert.strictEqual(TOOL_RENAMES_REVERSE[renamed], orig, `Expected TOOL_RENAMES_REVERSE['${renamed}'] = '${orig}'`);
  });
}

console.log('\nJSON response desanitization');
for (const [orig, renamed] of TOOLS_TO_TEST) {
  test(`JSON: ${renamed} ${NORMALIZE_TOOL_NAMES ? '→ ' + orig : 'passes through'}`, () => {
    const response = makeToolUseJson(renamed);
    const fixed = desanitizeResponseJson(response);
    assert.strictEqual(
      fixed.content[0].name,
      NORMALIZE_TOOL_NAMES ? orig : renamed,
      `Expected '${NORMALIZE_TOOL_NAMES ? orig : renamed}', got '${fixed.content[0].name}'`
    );
  });
}

test('JSON: non-tool names are not modified', () => {
  const response = { type: 'message', content: [{ type: 'text', text: 'hello' }] };
  const fixed = desanitizeResponseJson(response);
  assert.deepStrictEqual(fixed, response);
});

test('JSON: response text desanitization follows SANITIZE_OPENCLAW', () => {
  const response = { type: 'message', content: [{ type: 'text', text: 'PERSONA.md' }] };
  const fixed = desanitizeResponseJson(response);
  const textSanitizationEnabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.SANITIZE_OPENCLAW || '').toLowerCase()
  );
  assert.strictEqual(fixed.content[0].text, textSanitizationEnabled ? 'SOUL.md' : 'PERSONA.md');
});

test('JSON: unknown tool names pass through unchanged', () => {
  const response = makeToolUseJson('some_other_tool');
  const fixed = desanitizeResponseJson(response);
  assert.strictEqual(fixed.content[0].name, 'some_other_tool');
});

test('JSON: nested tool_use in array', () => {
  const response = {
    content: [
      { type: 'text', text: 'ok' },
      { type: 'tool_use', name: 'sub_agents', input: {} },
    ],
  };
  const fixed = desanitizeResponseJson(response);
  assert.strictEqual(fixed.content[1].name, NORMALIZE_TOOL_NAMES ? 'subagents' : 'sub_agents');
  assert.strictEqual(fixed.content[0].text, 'ok');
});

console.log('\nSSE streaming desanitization');
for (const [orig, renamed] of TOOLS_TO_TEST) {
  test(`SSE: ${renamed} ${NORMALIZE_TOOL_NAMES ? '→ ' + orig : 'passes through'}`, () => {
    const line = makeSseLine(renamed);
    const fixed = desanitizeSseLine(line);
    const evt = JSON.parse(fixed.slice(6));
    assert.strictEqual(
      evt.content_block.name,
      NORMALIZE_TOOL_NAMES ? orig : renamed,
      `Expected '${NORMALIZE_TOOL_NAMES ? orig : renamed}', got '${evt.content_block.name}'`
    );
  });
}

test('SSE: non-data lines pass through unchanged', () => {
  const line = 'event: message_start';
  assert.strictEqual(desanitizeSseLine(line), line);
});

test('SSE: [DONE] sentinel passes through unchanged', () => {
  const line = 'data: [DONE]';
  assert.strictEqual(desanitizeSseLine(line), line);
});

test('SSE: invalid JSON passes through unchanged', () => {
  const line = 'data: not-json';
  assert.strictEqual(desanitizeSseLine(line), line);
});

test('SSE: unknown tool names pass through unchanged', () => {
  const line = makeSseLine('some_other_tool');
  const fixed = desanitizeSseLine(line);
  const evt = JSON.parse(fixed.slice(6));
  assert.strictEqual(evt.content_block.name, 'some_other_tool');
});

console.log('\nOpenClaw sanitization switch');

test('sanitizeRequest preserves text and obeys tool name mode', () => {
  const body = sanitizeRequest({
    system: [{ type: 'text', text: 'OpenClaw uses .openclaw/ and SOUL.md' }],
    messages: [
      { role: 'user', content: 'OpenClaw memory_search in .openclaw/' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'sessions_spawn', input: { path: '.openclaw/test' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
        ],
      },
    ],
    tools: [
      {
        name: 'sessions_spawn',
        description: 'OpenClaw spawn tool',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'OpenClaw path' },
          },
          required: ['path'],
        },
      },
    ],
  });

  const textSanitizationEnabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.SANITIZE_OPENCLAW || '').toLowerCase()
  );

  if (textSanitizationEnabled) {
    assert.notStrictEqual(body.system[0].text, 'OpenClaw uses .openclaw/ and SOUL.md');
    assert.notStrictEqual(body.messages[0].content, 'OpenClaw memory_search in .openclaw/');
  } else {
    assert.strictEqual(body.system[0].text, 'OpenClaw uses .openclaw/ and SOUL.md');
    assert.strictEqual(body.messages[0].content, 'OpenClaw memory_search in .openclaw/');
    assert.strictEqual(body.messages[1].content[0].input.path, '.openclaw/test');
    assert.strictEqual(
      body.tools[0].description,
      COMPACT_TOOL_SCHEMAS
        ? `Use the ${NORMALIZE_TOOL_NAMES ? 'sess spawn' : 'sessions spawn'} tool.`
        : 'OpenClaw spawn tool'
    );
  }

  assert.strictEqual(body.tools[0].name, NORMALIZE_TOOL_NAMES ? 'sess_spawn' : 'sessions_spawn');
  assert.strictEqual(body.messages[1].content[0].name, NORMALIZE_TOOL_NAMES ? 'sess_spawn' : 'sessions_spawn');
  assert.strictEqual(
    body.tools[0].input_schema.properties.path.description,
    COMPACT_TOOL_SCHEMAS ? undefined : (textSanitizationEnabled ? 'myapp path' : 'OpenClaw path')
  );
});

console.log('\nSystem rewrite');

test('rewriteSystemForBillingClassifier does not prepend system context before tool_result blocks', () => {
  const body = rewriteSystemForBillingClassifier({
    system: [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: 'text', text: 'x-anthropic-billing-header: old' },
      { type: 'text', text: 'extra app context' },
    ],
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_test', name: 'message', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_test', content: 'ok' },
        ],
      },
      {
        role: 'user',
        content: 'next real user message',
      },
    ],
  });

  assert.strictEqual(body.messages[1].content[0].type, 'tool_result');
  assert.match(body.messages[2].content, /^<system>/);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
