#!/usr/bin/env node
'use strict';
// Tests for the in-memory recent-requests ring buffer + GET /c-thru/recent.
//
// The ring is populated from the response-finalize hook (fires once per
// request: finish OR premature close), NOT from recordUsage — so it must see
// what the aggregates skip: error responses, zero-token responses, and
// fallback attribution. CLAUDE_PROXY_RECENT_MAX caps the ring (default 256,
// 0 disables). Zero persistence by design: restart = empty ring.
//
// Run: node test/proxy-recent-requests.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  stubBackend, streamingStubBackend, writeConfig, httpJson, httpStream,
  spawnProxy, waitForPing,
} = require('./helpers');

console.log('proxy-recent-requests tests\n');

const CONCRETE_MODEL = 'recent-test-model';

function buildConfig(stubPort) {
  return {
    backends: {
      stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    model_routes: { [CONCRETE_MODEL]: 'stub' },
  };
}

function msgBody(extra = {}) {
  return Object.assign({
    model: CONCRETE_MODEL,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 10,
  }, extra);
}

const AUTH_HEADERS = { 'x-api-key': 'test', 'anthropic-version': '2023-06-01' };

function killAndWait(child, signal = 'SIGTERM') {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.on('exit', finish);
    try { child.kill(signal); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(); }, 3000);
  });
}

function cleanup(tmpHome) {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
}

async function spawnRecentProxy(config, extraEnv = {}) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-recent-'));
  const statsFile = path.join(tmpHome, 'usage-stats.json');
  const configPath = writeConfig(tmpHome, config);
  const { child, port } = await spawnProxy({
    configPath, tmpHome,
    env: Object.assign({ CLAUDE_PROXY_USAGE_STATS_FILE: statsFile }, extraEnv),
  });
  await waitForPing(port, 5000);
  return { child, port, tmpHome, statsFile, configPath };
}

async function teardown(state, stub) {
  if (state) {
    try { state.child.kill('SIGKILL'); } catch {}
    cleanup(state.tmpHome);
  }
  if (stub) { try { await stub.close(); } catch {} }
}

// ── Test 1: ordering + fields + control/count_tokens exclusion ────────────

async function testOrderingAndFields() {
  console.log('Test 1: newest-first ordering, per-entry fields, control-endpoint exclusion');
  let state, stub;
  try {
    stub = await stubBackend();
    state = await spawnRecentProxy(buildConfig(stub.port));
    const { port } = state;

    for (const uid of ['session_a', 'session_b', 'session_c']) {
      const { status } = await httpJson(port, 'POST', '/v1/messages',
        msgBody({ metadata: { user_id: uid } }), AUTH_HEADERS);
      assertEq(status, 200, `Test 1: request for ${uid} returned 200`);
    }

    // Control endpoints + count_tokens must NOT enter the ring.
    await httpJson(port, 'GET', '/c-thru/status', null, {}, 3000);
    await httpJson(port, 'POST', '/v1/messages/count_tokens', msgBody(), AUTH_HEADERS);

    const r = await httpJson(port, 'GET', '/c-thru/recent', null, {}, 3000);
    assertEq(r.status, 200, 'Test 1: GET /c-thru/recent returned 200');
    assert(r.json && r.json.ok === true, 'Test 1: response has ok:true');
    assertEq(r.json.buffered, 3, 'Test 1: buffered === 3 (control + count_tokens excluded)');
    assertEq(r.json.cap, 256, 'Test 1: cap reflects default RECENT_MAX (256)');
    assertEq(r.json.requests.length, 3, 'Test 1: 3 entries returned');

    // Newest first: last-sent user_id appears first.
    assertEq(r.json.requests[0].user_id, 'session_c', 'Test 1: newest entry first (session_c)');
    assertEq(r.json.requests[2].user_id, 'session_a', 'Test 1: oldest entry last (session_a)');

    const e = r.json.requests[0];
    assertEq(e.model, CONCRETE_MODEL, 'Test 1: entry.model is the requested model');
    assertEq(e.served_by, CONCRETE_MODEL, 'Test 1: entry.served_by is the dispatched model');
    assertEq(e.backend, 'stub', 'Test 1: entry.backend is the backend id');
    assertEq(e.status, 200, 'Test 1: entry.status === 200');
    assertEq(e.ok, true, 'Test 1: entry.ok === true');
    assertEq(e.aborted, false, 'Test 1: entry.aborted === false');
    assertEq(e.stream, false, 'Test 1: entry.stream === false');
    assertEq(e.input_tokens, 1, 'Test 1: entry.input_tokens from stub usage');
    assertEq(e.output_tokens, 1, 'Test 1: entry.output_tokens from stub usage');
    assert(typeof e.duration_ms === 'number' && e.duration_ms >= 0, 'Test 1: entry.duration_ms is a number');
    assert(typeof e.ts === 'string' && e.ts.includes('T'), 'Test 1: entry.ts is ISO timestamp');
    assert(typeof e.req_id === 'string' && e.req_id.length > 0, 'Test 1: entry.req_id present');
    assertEq(e.endpoint, '/v1/messages', 'Test 1: entry.endpoint is /v1/messages');
    assertEq(e.fallback_from, null, 'Test 1: no fallback — fallback_from null');

    await killAndWait(state.child); await stub.close(); cleanup(state.tmpHome);
  } catch (e) {
    await teardown(state, stub);
    throw e;
  }
}

// ── Test 2: ?n clamp ───────────────────────────────────────────────────────

async function testNClamp() {
  console.log('\nTest 2: ?n= subset, clamped to [1, RECENT_MAX]');
  let state, stub;
  try {
    stub = await stubBackend();
    state = await spawnRecentProxy(buildConfig(stub.port));
    const { port } = state;

    for (let i = 0; i < 4; i++) {
      await httpJson(port, 'POST', '/v1/messages', msgBody(), AUTH_HEADERS);
    }

    const r2 = await httpJson(port, 'GET', '/c-thru/recent?n=2', null, {}, 3000);
    assertEq(r2.json.requests.length, 2, 'Test 2: n=2 returns 2 entries');
    assertEq(r2.json.buffered, 4, 'Test 2: buffered still reports 4');

    const r0 = await httpJson(port, 'GET', '/c-thru/recent?n=0', null, {}, 3000);
    assertEq(r0.json.requests.length, 1, 'Test 2: n=0 clamps to 1');

    const rBig = await httpJson(port, 'GET', '/c-thru/recent?n=99999', null, {}, 3000);
    assertEq(rBig.json.requests.length, 4, 'Test 2: n=99999 clamps to cap, returns all 4');

    const rDefault = await httpJson(port, 'GET', '/c-thru/recent/', null, {}, 3000);
    assertEq(rDefault.status, 200, 'Test 2: trailing-slash variant returns 200');
    assertEq(rDefault.json.requests.length, 4, 'Test 2: default n=50 returns all 4');

    await killAndWait(state.child); await stub.close(); cleanup(state.tmpHome);
  } catch (e) {
    await teardown(state, stub);
    throw e;
  }
}

// ── Test 3: cap eviction ───────────────────────────────────────────────────

async function testCapEviction() {
  console.log('\nTest 3: CLAUDE_PROXY_RECENT_MAX=5 — 8 requests keep only the newest 5');
  let state, stub;
  try {
    stub = await stubBackend();
    state = await spawnRecentProxy(buildConfig(stub.port), { CLAUDE_PROXY_RECENT_MAX: '5' });
    const { port } = state;

    for (let i = 1; i <= 8; i++) {
      await httpJson(port, 'POST', '/v1/messages',
        msgBody({ metadata: { user_id: `req_${i}` } }), AUTH_HEADERS);
    }

    const r = await httpJson(port, 'GET', '/c-thru/recent?n=10', null, {}, 3000);
    assertEq(r.json.cap, 5, 'Test 3: cap === 5');
    assertEq(r.json.buffered, 5, 'Test 3: buffered === 5 (3 oldest evicted)');
    assertEq(r.json.requests.length, 5, 'Test 3: 5 entries returned');
    assertEq(r.json.requests[0].user_id, 'req_8', 'Test 3: newest (req_8) retained first');
    assertEq(r.json.requests[4].user_id, 'req_4', 'Test 3: oldest survivor is req_4');

    await killAndWait(state.child); await stub.close(); cleanup(state.tmpHome);
  } catch (e) {
    await teardown(state, stub);
    throw e;
  }
}

// ── Test 4: error capture — ring sees what recordUsage skips ──────────────

async function testErrorCapture() {
  console.log('\nTest 4: 502 upstream — ring entry ok:false while usage stats stay empty');
  let state, stub;
  try {
    stub = await stubBackend({ failWith: 502 });
    state = await spawnRecentProxy(buildConfig(stub.port));
    const { port, statsFile } = state;

    const { status } = await httpJson(port, 'POST', '/v1/messages', msgBody(), AUTH_HEADERS);
    assertEq(status, 502, 'Test 4: proxy surfaced the upstream 502');

    const r = await httpJson(port, 'GET', '/c-thru/recent', null, {}, 3000);
    assertEq(r.json.buffered, 1, 'Test 4: error request entered the ring');
    const e = r.json.requests[0];
    assertEq(e.status, 502, 'Test 4: entry.status === 502');
    assertEq(e.ok, false, 'Test 4: entry.ok === false');
    assertEq(e.backend, 'stub', 'Test 4: entry.backend attributed');
    assertEq(e.input_tokens, null, 'Test 4: no tokens recorded for the error');

    // recordUsage never fired (no tokens) — SIGTERM flush writes nothing.
    await killAndWait(state.child, 'SIGTERM');
    assert(!fs.existsSync(statsFile),
      'Test 4: stats file not created — ring captured what aggregates skip');

    await stub.close(); cleanup(state.tmpHome);
  } catch (e) {
    await teardown(state, stub);
    throw e;
  }
}

// ── Test 5: fallback attribution ───────────────────────────────────────────

async function testFallbackAttribution() {
  console.log('\nTest 5: primary 500 -> fallback serves; entry has fallback_from + final served_by');
  let state, primary, secondary;
  try {
    primary = await stubBackend({ failWith: 500 });
    secondary = await stubBackend();
    const cfg = {
      backends: {
        primary_be:   { kind: 'anthropic', url: `http://127.0.0.1:${primary.port}`, fallback_to: 'secondary-target' },
        secondary_be: { kind: 'anthropic', url: `http://127.0.0.1:${secondary.port}` },
      },
      model_routes: {
        'primary-model':    'primary_be',
        'secondary-target': 'secondary_be',
      },
    };
    state = await spawnRecentProxy(cfg);
    const { port } = state;

    const { status } = await httpJson(port, 'POST', '/v1/messages', msgBody({ model: 'primary-model' }), AUTH_HEADERS);
    assertEq(status, 200, 'Test 5: request served via fallback (200)');

    const r = await httpJson(port, 'GET', '/c-thru/recent', null, {}, 3000);
    assertEq(r.json.buffered, 1, 'Test 5: one ring entry for the whole fallback chain');
    const e = r.json.requests[0];
    assertEq(e.model, 'primary-model', 'Test 5: entry.model is the original request');
    assertEq(e.fallback_from, 'primary_be', 'Test 5: entry.fallback_from names the failed backend');
    assertEq(e.backend, 'secondary_be', 'Test 5: entry.backend is the serving backend');
    assertEq(e.served_by, 'secondary-target', 'Test 5: entry.served_by is the final dispatched model');
    assertEq(e.ok, true, 'Test 5: entry.ok === true (fallback succeeded)');

    await killAndWait(state.child);
    await primary.close(); await secondary.close(); cleanup(state.tmpHome);
  } catch (e) {
    await teardown(state, primary);
    if (secondary) { try { await secondary.close(); } catch {} }
    throw e;
  }
}

// ── Test 6: streaming tokens ───────────────────────────────────────────────

async function testStreamingTokens() {
  console.log('\nTest 6: streaming response — ring entry carries SSE-extracted tokens, stream:true');
  let state, stub;
  try {
    stub = await streamingStubBackend([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_s', usage: { input_tokens: 7, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    state = await spawnRecentProxy(buildConfig(stub.port));
    const { port } = state;

    const r1 = await httpStream(port, 'POST', '/v1/messages', msgBody({ stream: true }), AUTH_HEADERS);
    assertEq(r1.status, 200, 'Test 6: streaming request returned 200');

    const r = await httpJson(port, 'GET', '/c-thru/recent', null, {}, 3000);
    const e = r.json.requests[0];
    assertEq(e.stream, true, 'Test 6: entry.stream === true');
    assertEq(e.input_tokens, 7, 'Test 6: input_tokens from message_start frame');
    assertEq(e.output_tokens, 9, 'Test 6: output_tokens from message_delta frame');

    await killAndWait(state.child); await stub.close(); cleanup(state.tmpHome);
  } catch (e) {
    await teardown(state, stub);
    throw e;
  }
}

// ── Test 7: zero persistence across restart ────────────────────────────────

async function testZeroPersistence() {
  console.log('\nTest 7: ring does not survive a restart (in-memory by design)');
  let state, state2, stub;
  try {
    stub = await stubBackend();
    state = await spawnRecentProxy(buildConfig(stub.port));
    await httpJson(state.port, 'POST', '/v1/messages', msgBody(), AUTH_HEADERS);
    const before = await httpJson(state.port, 'GET', '/c-thru/recent', null, {}, 3000);
    assertEq(before.json.buffered, 1, 'Test 7: entry buffered before restart');
    await killAndWait(state.child, 'SIGTERM');

    state2 = await spawnRecentProxy(buildConfig(stub.port));
    const after = await httpJson(state2.port, 'GET', '/c-thru/recent', null, {}, 3000);
    assertEq(after.json.buffered, 0, 'Test 7: ring empty after restart');
    assertEq(after.json.requests.length, 0, 'Test 7: no entries returned after restart');

    await killAndWait(state2.child); await stub.close();
    cleanup(state.tmpHome); cleanup(state2.tmpHome);
  } catch (e) {
    await teardown(state, stub);
    if (state2) { try { state2.child.kill('SIGKILL'); } catch {} cleanup(state2.tmpHome); }
    throw e;
  }
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  await testOrderingAndFields();
  await testNClamp();
  await testCapEviction();
  await testErrorCapture();
  await testFallbackAttribution();
  await testStreamingTokens();
  await testZeroPersistence();

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

process.on('unhandledRejection', err => {
  console.error('unhandledRejection:', err);
  process.exit(1);
});

main().catch(err => {
  console.error(err);
  process.exit(1);
});
