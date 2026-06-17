#!/usr/bin/env node
'use strict';
// Hermetic unit test for the proxy's per-agent sentinel detection
// (tools/agent-sentinel.js parseAgentSentinel). This is the routing-identity channel
// for the hook handshake (docs/planning/agent-delegation-findings.md): the PreToolUse
// hook stamps [[c-thru-agent:<name>]] into a delegation's task prompt, and the proxy
// reads it to route per-agent. The live path is exercised by agent-scenarios-e2e
// (opt-in, non-deterministic); this guards the detection logic deterministically with
// no proxy spawn and no network, so a regression is caught in every `make test-fast`.
//
// Run: node test/proxy-sentinel-detection.test.js

const { parseAgentSentinel, READ_WINDOW } = require('../tools/agent-sentinel.js');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}

const body = (o) => JSON.stringify(o);
const hugeSystem = 'x'.repeat(200000); // pushes messages far past any bounded prefix

console.log('proxy sentinel detection (parseAgentSentinel)\n');

// ── body marker ────────────────────────────────────────────────────────────────
assert(parseAgentSentinel(body({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '[[c-thru-agent:coder]]\nwrite add(a,b)' }] }), undefined) === 'coder',
  'marker in the first user message → coder');

assert(parseAgentSentinel(body({ model: 'x', system: hugeSystem, messages: [
  { role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok' },
  { role: 'user', content: '[[c-thru-agent:fast-scout]] summarize' }] }), undefined) === 'fast-scout',
  'marker after a huge system prompt + later message → fast-scout (whole-body locate, nothing slips through)');

assert(parseAgentSentinel('prefix text [[c-thru-agent:docs]] suffix', undefined) === 'docs',
  'plain-string body with marker → docs');

// ── no marker ────────────────────────────────────────────────────────────────────
assert(parseAgentSentinel(body({ model: 'claude-sonnet-4-6', system: hugeSystem, messages: [{ role: 'user', content: 'a normal prompt with no marker' }] }), undefined) === null,
  'no marker (main thread) → null');

assert(parseAgentSentinel('[[c-thru-agent:coder', undefined) === null, 'unterminated marker → null');
assert(parseAgentSentinel('plain text', undefined) === null, 'unrelated text → null');

// ── header tier ────────────────────────────────────────────────────────────────
assert(parseAgentSentinel(body({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }), 'reviewer-plan') === 'reviewer-plan',
  'x-c-thru-agent header → reviewer-plan');

assert(parseAgentSentinel(body({ messages: [{ role: 'user', content: '[[c-thru-agent:coder]]' }] }), 'planner') === 'planner',
  'valid header takes precedence over a body marker → planner');

assert(parseAgentSentinel(body({ messages: [{ role: 'user', content: '[[c-thru-agent:tester]] t' }] }), 'bad header!') === 'tester',
  'malformed header ignored → falls back to body marker → tester');

// ── defensive / bounds ───────────────────────────────────────────────────────────
assert(parseAgentSentinel(null, undefined) === null, 'null body → null');
assert(parseAgentSentinel(undefined, undefined) === null, 'undefined body → null');
assert(parseAgentSentinel(body({ messages: [{ role: 'user', content: 'x'.repeat(50) + '[[c-thru-agent:edge]] go' }] }), undefined) === 'edge',
  'marker not at the start of a message is still found');

const longName = 'a'.repeat(60); // exceeds the READ_WINDOW once the prefix is counted
assert(parseAgentSentinel(`[[c-thru-agent:${longName}]]`, undefined) === null,
  `agent name longer than the ${READ_WINDOW}-byte read window → null (graceful, no false route)`);

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
