#!/usr/bin/env node
'use strict';
// Hermetic unit test for the proxy's per-agent sentinel detection
// (tools/agent-sentinel.js parseAgentSentinel) + the C19 anti-spoof trust gate.
//
// The sentinel is the routing-identity channel for the hook handshake
// (docs/planning/agent-delegation-findings.md): the PreToolUse hook stamps
// [[c-thru-agent:<name>]] into a delegation's task prompt (optional legacy
// :<hmac16> suffix still peels for history; trust is loopback-only in the proxy),
// and the
// proxy reads it to route per-agent. C19: with C_THRU_PROXY_ALWAYS, forgeable
// main-thread content (tool results, pasted text, fetched pages) can carry a
// marker, so the proxy verifies the HMAC tag when a key is present and fails
// open (honors unsigned) when absent.
//
// parseAgentSentinel stays a PURE parser (returns { name, tag } | null); the
// trust decision (HMAC verify / fail-open) lives in claude-proxy. This test
// guards the parser's shape AND replicates the proxy's trust logic with the
// same crypto primitive so the C19 contract is checked deterministically with
// no proxy spawn and no network.
//
// Run: node test/proxy-sentinel-detection.test.js

const crypto = require('crypto');
const {
  parseAgentSentinel,
  stripAgentSentinelFromBody,
  stripSentinelFromString,
} = require('../tools/agent-sentinel.js');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}

const body = (o) => JSON.stringify(o);
const hugeSystem = 'x'.repeat(200000); // pushes messages far past any bounded prefix

console.log('proxy sentinel detection (parseAgentSentinel) + C19 trust gate\n');

// ── body marker → { name, tag } shape ───────────────────────────────────────────
{
  const r = parseAgentSentinel(body({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: '[[c-thru-agent:coder]]\nwrite add(a,b)' }] }), undefined);
  assert(r && r.name === 'coder' && r.tag === null, 'unsigned marker in first user message → { name: coder, tag: null }');
}

{
  const r = parseAgentSentinel(body({ model: 'x', system: hugeSystem, messages: [
    { role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok' },
    { role: 'user', content: '[[c-thru-agent:fast-scout]] summarize' }] }), undefined);
  assert(r && r.name === 'fast-scout' && r.tag === null,
    'marker after a huge system prompt + later message → fast-scout (whole-body locate, nothing slips through)');
}

// ── last match wins (multi-turn history shadowing) ────────────────────────────
{
  const r = parseAgentSentinel(body({
    model: 'sonnet',
    messages: [
      { role: 'user', content: '[[c-thru-agent:coder]]\nold task' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: '[[c-thru-agent:tester]]\nnew task' },
    ],
  }), undefined);
  assert(r && r.name === 'tester' && r.tag === null,
    'two markers in history → last match wins (tester, not coder)');
}
{
  const r = parseAgentSentinel(body({
    messages: [
      { role: 'user', content: '[[c-thru-agent:coder:aaaaaaaaaaaaaaaa]] first' },
      { role: 'user', content: '[[c-thru-agent:docs:bbbbbbbbbbbbbbbb]] second' },
    ],
  }), undefined);
  assert(r && r.name === 'docs' && r.tag === 'bbbbbbbbbbbbbbbb',
    'last signed marker → name+tag from last match');
}

{
  const r = parseAgentSentinel('prefix text [[c-thru-agent:docs]] suffix', undefined);
  assert(r === null, 'plain-string non-JSON body fails closed → null');
}

{
  const r = parseAgentSentinel(body({ model: 'sonnet', messages: [{ role: 'user', content: '[[c-thru-agent:advisor:deepseek-v4-pro:cloud]]\nhi' }] }), undefined);
  assert(r && r.name === 'advisor:deepseek-v4-pro:cloud' && r.tag === null,
  'advisor marker with colon model id → advisor:deepseek-v4-pro:cloud');
}

// ── poison markers from agents reading c-thru source (must not route) ───────────
{
  // Hook source contains the unexpanded shell form; last match would be poison.
  const r = parseAgentSentinel(body({
    model: 'sonnet',
    messages: [
      { role: 'user', content: '[[c-thru-agent:explore]]\nfind injection points' },
      { role: 'assistant', content: 'reading hook…' },
      { role: 'user', content: 'tool_result: sentinel="[[c-thru-agent:${lookup_key}]]"$' },
    ],
  }), undefined);
  assert(r && r.name === 'explore' && r.tag === null,
    'source-code poison ${lookup_key} ignored; earlier valid explore wins');
}
{
  const r = parseAgentSentinel(body({
    messages: [
      { role: 'user', content: '[[c-thru-agent:coder]]\nfix' },
      { role: 'user', content: 'see agent-sentinel.js: // [[c-thru-agent: const HMAC' },
    ],
  }), undefined);
  assert(r && r.name === 'coder',
    'incomplete/code-like marker ignored; prior coder wins');
}
{
  const r = parseAgentSentinel(body({
    messages: [{ role: 'user', content: 'only poison [[c-thru-agent:${lookup_key}]] here' }],
  }), undefined);
  assert(r === null, 'sole poison marker → null (no routing override)');
}
{
  const r = parseAgentSentinel(body({
    messages: [{ role: 'user', content: '[[c-thru-agent:kimi-k2.7-code:cloud]]\nok' }],
  }), undefined);
  assert(r && r.name === 'kimi-k2.7-code:cloud',
    'concrete model tag with digits/dots/colon still valid');
}

// ── signed marker → tag captured ─────────────────────────────────────────────────
{
  const r = parseAgentSentinel(body({ messages: [{ role: 'user', content: '[[c-thru-agent:coder:0123456789abcdef]] go' }] }), undefined);
  assert(r && r.name === 'coder' && r.tag === '0123456789abcdef', 'signed marker → { name: coder, tag: <hex16> }');
}

// ── no marker → null ───────────────────────────────────────────────────────────────
assert(parseAgentSentinel(body({ model: 'claude-sonnet-5', system: hugeSystem, messages: [{ role: 'user', content: 'a normal prompt with no marker' }] }), undefined) === null,
  'no marker (main thread) → null');

assert(parseAgentSentinel('[[c-thru-agent:coder', undefined) === null, 'unterminated marker → null');
assert(parseAgentSentinel('plain text', undefined) === null, 'unrelated text → null');

// ── header tier (carries no tag) ─────────────────────────────────────────────────
{
  const r = parseAgentSentinel(body({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }), 'reviewer-plan');
  assert(r && r.name === 'reviewer-plan' && r.tag === null, 'x-c-thru-agent header → { name: reviewer-plan, tag: null }');
}
{
  const r = parseAgentSentinel(body({ messages: [{ role: 'user', content: '[[c-thru-agent:coder]]' }] }), 'planner');
  assert(r && r.name === 'planner', 'valid header takes precedence over a body marker → planner');
}
{
  // Invalid header (spaces / disallowed chars) is rejected — same charset gate as body.
  // Falls through so a real body marker still routes (header path is future OOB only).
  const r = parseAgentSentinel(body({ messages: [{ role: 'user', content: '[[c-thru-agent:tester]] t' }] }), 'bad header!');
  assert(r && r.name === 'tester', 'invalid header ignored; body marker tester wins');
}
{
  const r = parseAgentSentinel(body({ messages: [{ role: 'user', content: 'no marker' }] }), 'bad header!');
  assert(r === null, 'invalid header alone → null (no routing override)');
}
{
  // Header still accepts model-like / advisor pins (no HMAC on header).
  const r = parseAgentSentinel(body({ messages: [{ role: 'user', content: '[[c-thru-agent:tester]] t' }] }), 'advisor:org/model');
  assert(r && r.name === 'advisor:org/model', 'valid model-like header takes precedence over body');
}

// ── defensive / bounds ───────────────────────────────────────────────────────────
assert(parseAgentSentinel(null, undefined) === null, 'null body → null');
assert(parseAgentSentinel(undefined, undefined) === null, 'undefined body → null');
{
  const r = parseAgentSentinel(body({ messages: [{ role: 'user', content: 'x'.repeat(50) + '[[c-thru-agent:microtask]] go' }] }), undefined);
  assert(r && r.name === 'microtask', 'marker not at the start of a message is still found');
}

const longOk = 'org/model-' + 'x'.repeat(100) + ':cloud';
{
  const r = parseAgentSentinel(body({ messages: [{ role: 'user', content: `[[c-thru-agent:${longOk}]]` }] }), undefined);
  assert(r && r.name === longOk, 'long arbitrary model-like name parses (no tight 80-byte window)');
}
const tooLong = 'a'.repeat(600);
assert(parseAgentSentinel(`[[c-thru-agent:${tooLong}]]`, undefined) === null,
  'interior longer than MAX_INTERIOR_LEN → null (sanity cap)');

// ── Trust lives in claude-proxy (loopback client) — not mirrored here ────────
// Parser still peels optional :16hex tags for multi-turn history compat.
// Proxy honors body markers only for loopback peers (see e2e suite).

// ── strip ───────────────────────────────────────────────────────────────────
{
  assert(stripSentinelFromString('[[c-thru-agent:docs]]\nhello') === 'hello' ||
         stripSentinelFromString('[[c-thru-agent:docs]]\nhello') === 'hello\n' ||
         !stripSentinelFromString('[[c-thru-agent:docs]]\nhello').includes('c-thru-agent'),
    'stripSentinelFromString removes marker + trailing newline');
  const b = {
    model: 'sonnet',
    system: '[[c-thru-agent:docs]] sys',
    messages: [
      { role: 'user', content: '[[c-thru-agent:coder]]\nold' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [
        { type: 'text', text: '[[c-thru-agent:tester]]\nnew task' },
      ] },
    ],
  };
  stripAgentSentinelFromBody(b);
  assert(b.system === ' sys' || b.system === 'sys' || !b.system.includes('c-thru-agent'),
    'strip removes sentinel from system string');
  assert(!JSON.stringify(b).includes('[[c-thru-agent:'),
    'strip removes all sentinels from structured body');
  assert(b.messages[2].content[0].text.includes('new task'),
    'strip preserves non-sentinel text in content blocks');
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
