#!/usr/bin/env node
'use strict';
// Hermetic unit test for the proxy's per-agent sentinel detection
// (tools/agent-sentinel.js parseAgentSentinel) + the C19 anti-spoof trust gate.
//
// The sentinel is the routing-identity channel for the hook handshake
// (docs/planning/agent-delegation-findings.md): the PreToolUse hook stamps
// [[c-thru-agent:<name>]] — or, when the per-user HMAC key exists,
// [[c-thru-agent:<name>:<hmac16>]] — into a delegation's task prompt, and the
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
  assert(r && r.name === 'docs' && r.tag === null, 'plain-string body with marker → docs');
}

{
  const r = parseAgentSentinel(body({ model: 'sonnet', messages: [{ role: 'user', content: '[[c-thru-agent:advisor:deepseek-v4-pro:cloud]]\nhi' }] }), undefined);
  assert(r && r.name === 'advisor:deepseek-v4-pro:cloud' && r.tag === null,
  'advisor marker with colon model id → advisor:deepseek-v4-pro:cloud');
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
  // Header is opaque; non-empty wins even with punctuation (still no HMAC on header).
  const r = parseAgentSentinel(body({ messages: [{ role: 'user', content: '[[c-thru-agent:tester]] t' }] }), 'bad header!');
  assert(r && r.name === 'bad header!', 'non-empty header takes precedence (opaque name)');
}

// ── defensive / bounds ───────────────────────────────────────────────────────────
assert(parseAgentSentinel(null, undefined) === null, 'null body → null');
assert(parseAgentSentinel(undefined, undefined) === null, 'undefined body → null');
{
  const r = parseAgentSentinel(body({ messages: [{ role: 'user', content: 'x'.repeat(50) + '[[c-thru-agent:edge]] go' }] }), undefined);
  assert(r && r.name === 'edge', 'marker not at the start of a message is still found');
}

const longOk = 'org/model-' + 'x'.repeat(100) + ':cloud';
{
  const r = parseAgentSentinel(`[[c-thru-agent:${longOk}]]`, undefined);
  assert(r && r.name === longOk, 'long arbitrary model-like name parses (no tight 80-byte window)');
}
const tooLong = 'a'.repeat(600);
assert(parseAgentSentinel(`[[c-thru-agent:${tooLong}]]`, undefined) === null,
  'interior longer than MAX_INTERIOR_LEN → null (sanity cap)');

// ── C19 trust gate ────────────────────────────────────────────────────────────────
// Replicates claude-proxy's trust decision so the contract is checked here:
//   key present → honor ONLY if timingSafeEqual(HMAC16(name), tag); else reject
//   key absent  → fail-open: honor any marker
function expectedTag(key, name) {
  return crypto.createHmac('sha256', key).update(name).digest('hex').slice(0, 16);
}
function trustBodyMarker(key, parsed) {
  // mirrors the proxy: header path is trusted separately; this is the body path
  if (!parsed) return false;
  if (!key) return true; // fail-open
  if (typeof parsed.tag !== 'string' || !parsed.tag) return false; // unsigned + key present → reject
  const a = Buffer.from(expectedTag(key, parsed.name), 'utf8');
  const b = Buffer.from(parsed.tag.toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

const KEY = 'deadbeef'.repeat(8); // 64-hex stand-in for the per-user key
const validTag = expectedTag(KEY, 'coder');

// unsigned marker + key present → rejected
{
  const parsed = parseAgentSentinel(body({ messages: [{ role: 'user', content: '[[c-thru-agent:coder]] go' }] }), undefined);
  assert(trustBodyMarker(KEY, parsed) === false, 'C19: unsigned body marker + key present → REJECTED');
}

// valid HMAC → accepted
{
  const parsed = parseAgentSentinel(body({ messages: [{ role: 'user', content: `[[c-thru-agent:coder:${validTag}]] go` }] }), undefined);
  assert(parsed && parsed.tag === validTag, 'C19: valid-HMAC marker parses with the right tag');
  assert(trustBodyMarker(KEY, parsed) === true, 'C19: valid-HMAC body marker + key present → ACCEPTED');
}

// wrong/forged HMAC → rejected
{
  const parsed = parseAgentSentinel(body({ messages: [{ role: 'user', content: '[[c-thru-agent:coder:0000000000000000]] go' }] }), undefined);
  assert(trustBodyMarker(KEY, parsed) === false, 'C19: wrong-HMAC body marker + key present → REJECTED');
}

// forged name with a tag that is valid for a DIFFERENT name → rejected (tag bound to name)
{
  const tagForOther = expectedTag(KEY, 'docs');
  const parsed = parseAgentSentinel(body({ messages: [{ role: 'user', content: `[[c-thru-agent:coder:${tagForOther}]] go` }] }), undefined);
  assert(trustBodyMarker(KEY, parsed) === false, 'C19: tag valid for a different name → REJECTED (HMAC binds tag to name)');
}

// key absent → fail-open accept (unsigned)
{
  const parsed = parseAgentSentinel(body({ messages: [{ role: 'user', content: '[[c-thru-agent:coder]] go' }] }), undefined);
  assert(trustBodyMarker(null, parsed) === true, 'C19: unsigned body marker + key ABSENT → fail-open ACCEPT');
}

// key absent → fail-open accept (even if a tag happens to be present)
{
  const parsed = parseAgentSentinel(body({ messages: [{ role: 'user', content: '[[c-thru-agent:coder:0123456789abcdef]] go' }] }), undefined);
  assert(trustBodyMarker(null, parsed) === true, 'C19: signed body marker + key ABSENT → fail-open ACCEPT');
}

// ── arbitrary names (OpenRouter-style, advisor pins) ──────────────────────────
{
  const r = parseAgentSentinel('[[c-thru-agent:deepseek/deepseek-chat-v3-0324:free]]', undefined);
  assert(r && r.name === 'deepseek/deepseek-chat-v3-0324:free' && r.tag === null,
    'slash + free suffix model id → full name, no false HMAC');
}
{
  const r = parseAgentSentinel(body({ messages: [{ role: 'user', content: '[[c-thru-agent:advisor:deepseek-v4-pro:cloud]]\nhi' }] }), undefined);
  assert(r && r.name === 'advisor:deepseek-v4-pro:cloud' && r.tag === null,
    'advisor pin with colons → full name (HMAC only if last :hex16)');
}
{
  const name = 'provider/model-name-with-plus+v2';
  const r = parseAgentSentinel(`[[c-thru-agent:${name}]]`, undefined);
  assert(r && r.name === name, 'plus and slash in model name accepted');
}

// ── stripAgentSentinelFromBody ────────────────────────────────────────────────
{
  assert(stripSentinelFromString('[[c-thru-agent:coder]]\nwrite add') === 'write add',
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
