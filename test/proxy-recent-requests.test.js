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
const http = require('http');
const net  = require('net');
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
  await waitForPing(port);
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
    await httpJson(port, 'GET', '/c-thru/status', null, {});
    await httpJson(port, 'POST', '/v1/messages/count_tokens', msgBody(), AUTH_HEADERS);

    const r = await httpJson(port, 'GET', '/c-thru/recent', null, {});
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
    assert(/^[0-9a-f]{32}$/.test(e.req_id),
      'Test 1: entry.req_id is a 128-bit lowercase-hex identifier');
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

    const r2 = await httpJson(port, 'GET', '/c-thru/recent?n=2', null, {});
    assertEq(r2.json.requests.length, 2, 'Test 2: n=2 returns 2 entries');
    assertEq(r2.json.buffered, 4, 'Test 2: buffered still reports 4');

    const r0 = await httpJson(port, 'GET', '/c-thru/recent?n=0', null, {});
    assertEq(r0.json.requests.length, 1, 'Test 2: n=0 clamps to 1');

    const rBig = await httpJson(port, 'GET', '/c-thru/recent?n=99999', null, {});
    assertEq(rBig.json.requests.length, 4, 'Test 2: n=99999 clamps to cap, returns all 4');

    const rDefault = await httpJson(port, 'GET', '/c-thru/recent/', null, {});
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

    const r = await httpJson(port, 'GET', '/c-thru/recent?n=10', null, {});
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

    const r = await httpJson(port, 'GET', '/c-thru/recent', null, {});
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

    const r = await httpJson(port, 'GET', '/c-thru/recent', null, {});
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

    const r = await httpJson(port, 'GET', '/c-thru/recent', null, {});
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
    const before = await httpJson(state.port, 'GET', '/c-thru/recent', null, {});
    assertEq(before.json.buffered, 1, 'Test 7: entry buffered before restart');
    await killAndWait(state.child, 'SIGTERM');

    state2 = await spawnRecentProxy(buildConfig(stub.port));
    const after = await httpJson(state2.port, 'GET', '/c-thru/recent', null, {});
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

// ── Test 8: universal request completion log ──────────────────────────────

function proxyLogEvents(logFile, eventName) {
  let text = '';
  try { text = fs.readFileSync(logFile, 'utf8'); } catch {}
  const events = [];
  for (const line of text.split('\n')) {
    const match = line.match(/ c-thru \[([^\]]+)\] (\{.*\})$/);
    if (!match || match[1] !== eventName) continue;
    try { events.push(JSON.parse(match[2])); } catch {}
  }
  return events;
}

async function waitForLogEvents(logFile, eventName, predicate, minimum, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = proxyLogEvents(logFile, eventName).filter(predicate);
    if (matches.length >= minimum) return matches;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return proxyLogEvents(logFile, eventName).filter(predicate);
}

function rawHttpStatus(port, requestTarget) {
  return new Promise((resolve, reject) => {
    let response = '';
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${requestTarget} HTTP/1.1\r\n` +
        'Host: 127.0.0.1\r\n' +
        'Connection: close\r\n\r\n',
      );
    });
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy(new Error('raw HTTP request timed out')));
    socket.on('data', chunk => { response += chunk; });
    socket.once('error', reject);
    socket.once('end', () => {
      const match = response.match(/^HTTP\/1\.1 (\d{3})\b/);
      resolve(match ? Number(match[1]) : null);
    });
  });
}

async function testRequestCompleteLog() {
  console.log('\nTest 8: request.complete is exact-once, normalized, and privacy-safe');
  let state, stub;
  let debugStderr = '';
  try {
    let markAbortSeen;
    const abortSeen = new Promise(resolve => { markAbortSeen = resolve; });
    stub = await stubBackend();
    stub.setHandler((req, res) => {
      const requestCase = new URL(req.url, 'http://stub').searchParams.get('case');
      if (requestCase === 'abort') {
        req.resume();
        markAbortSeen();
        return true;
      }
      req.once('end', () => {
        if (requestCase === 'failure') {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'RAW_UPSTREAM_ERROR_SHOULD_NOT_LOG' },
          }));
          return;
        }
        if (requestCase === 'redirect') {
          res.writeHead(302, { location: '/private/redirect-target' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_complete',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: CONCRETE_MODEL,
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
      });
      req.resume();
      return true;
    });

    state = await spawnRecentProxy(buildConfig(stub.port), {
      CLAUDE_PROXY_DEBUG: '2',
    });
    state.child.stderr.setEncoding('utf8');
    state.child.stderr.on('data', chunk => { debugStderr += chunk; });
    const { port } = state;
    const logFile = path.join(state.tmpHome, '.claude', 'proxy.log');
    const sessionPrefix = '/s/request-complete-test';
    const normalizedPaths = [
      '/v1/messages?case=success&access_token=QUERY_SECRET_SHOULD_NOT_LOG',
      '/v1/messages?case=failure&access_token=QUERY_SECRET_SHOULD_NOT_LOG',
      '/v1/messages?case=redirect&access_token=QUERY_SECRET_SHOULD_NOT_LOG',
      '/v1/messages?case=abort&access_token=QUERY_SECRET_SHOULD_NOT_LOG',
    ];
    const privateHeaders = {
      ...AUTH_HEADERS,
      authorization: 'Bearer HEADER_SECRET_SHOULD_NOT_LOG',
    };
    const privateBody = msgBody({
      messages: [{ role: 'user', content: 'BODY_SECRET_SHOULD_NOT_LOG' }],
    });
    const privateUnknownPath = '/private/SECRET_PATH_SEGMENT_SHOULD_NOT_LOG';

    const success = await httpJson(
      port, 'POST', sessionPrefix + normalizedPaths[0], privateBody, privateHeaders,
    );
    assertEq(success.status, 200, 'Test 8: provider success returned 200');

    const failure = await httpJson(
      port, 'POST', sessionPrefix + normalizedPaths[1], privateBody, privateHeaders,
    );
    assertEq(failure.status, 422, 'Test 8: provider HTTP failure returned 422');

    const redirect = await httpJson(
      port, 'POST', sessionPrefix + normalizedPaths[2], privateBody, privateHeaders,
    );
    assertEq(redirect.status, 302, 'Test 8: provider redirect returned 302');

    const unknownPath = await httpJson(
      port, 'GET', sessionPrefix + privateUnknownPath, null, privateHeaders,
    );
    assertEq(unknownPath.status, 404, 'Test 8: unknown private path returned 404');

    const malformedTarget = 'http://%';
    const malformedStatus = await rawHttpStatus(port, malformedTarget);
    assertEq(malformedStatus, 404, 'Test 8: malformed request target returned 404');

    const abortPayload = JSON.stringify(privateBody);
    const abortRequest = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: sessionPrefix + normalizedPaths[3],
      headers: {
        ...privateHeaders,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(abortPayload),
      },
    });
    const abortClosed = new Promise(resolve => {
      abortRequest.once('error', resolve);
      abortRequest.once('close', resolve);
    });
    abortRequest.end(abortPayload);
    await abortSeen;
    abortRequest.destroy();
    await abortClosed;

    const isTarget = event => event.path === '/v1/messages';
    const completions = await waitForLogEvents(
      logFile, 'request.complete', isTarget, normalizedPaths.length,
    );
    assertEq(completions.length, 4, 'Test 8: one completion event per finalized provider request');
    const requestEvents = proxyLogEvents(logFile, 'request');
    const starts = requestEvents
      .filter(event =>
        event.method === 'POST' &&
        event.url === '/v1/messages' &&
        event.session === 'request-complete-test');
    const unknownStart = requestEvents.find(event =>
      event.method === 'GET' &&
      event.url === '/[other]' &&
      event.session === 'request-complete-test');
    const malformedStart = requestEvents.find(event =>
      event.method === 'GET' &&
      event.url === '/[redacted]' &&
      event.session === null);
    const otherCompletions = await waitForLogEvents(
      logFile,
      'request.complete',
      event =>
        event.path === '/[other]' &&
        event.req_id === unknownStart?.req_id,
      1,
    );
    assertEq(otherCompletions.length, 1,
      'Test 8: arbitrary path is represented by one bounded route class');
    const redactedCompletions = await waitForLogEvents(
      logFile,
      'request.complete',
      event =>
        event.path === '/[redacted]' &&
        event.req_id === malformedStart?.req_id,
      1,
    );
    assertEq(redactedCompletions.length, 1,
      'Test 8: malformed request target is represented by one redacted route class');

    assertEq(starts.length, 4, 'Test 8: four matching request-start events');
    assert(
      starts.every(start =>
        start.url === '/v1/messages' &&
        !Object.hasOwn(start, 'raw_url')),
      'Test 8: request-start events omit query strings and raw session URLs',
    );
    for (const completion of completions) {
      const matchingStarts = starts.filter(start => start.req_id === completion.req_id);
      assertEq(matchingStarts.length, 1,
        `Test 8: completion ${completion.path} shares exactly one request req_id`);
      const stableKeys = Object.keys(completion)
        .filter(key => !['pid', 'req_id', 'elapsed_ms'].includes(key))
        .sort();
      assertEq(
        JSON.stringify(stableKeys),
        JSON.stringify(['aborted', 'method', 'path', 'status_code', 'success']),
        `Test 8: completion ${completion.path} has only stable completion fields`,
      );
      assertEq(completion.method, 'POST', `Test 8: completion ${completion.path} method`);
      assert(typeof completion.status_code === 'number',
        `Test 8: completion ${completion.path} status_code is numeric`);
      assert(typeof completion.aborted === 'boolean',
        `Test 8: completion ${completion.path} aborted is boolean`);
      assert(typeof completion.success === 'boolean',
        `Test 8: completion ${completion.path} success is boolean`);
      assertEq(completion.path, '/v1/messages',
        'Test 8: completion path strips the session prefix and query');
    }

    const completionForIndex = index =>
      completions.find(event => event.req_id === starts[index]?.req_id);
    const successfulCompletion = completionForIndex(0);
    const failedCompletion = completionForIndex(1);
    const redirectCompletion = completionForIndex(2);
    const abortedCompletion = completionForIndex(3);
    assertEq(successfulCompletion?.status_code, 200, 'Test 8: success status_code is 200');
    assertEq(successfulCompletion?.aborted, false, 'Test 8: success is not aborted');
    assertEq(successfulCompletion?.success, true, 'Test 8: 2xx completion is successful');
    assertEq(failedCompletion?.status_code, 422, 'Test 8: failure status_code is 422');
    assertEq(failedCompletion?.aborted, false, 'Test 8: HTTP failure is not aborted');
    assertEq(failedCompletion?.success, false, 'Test 8: 4xx completion is unsuccessful');
    assertEq(redirectCompletion?.status_code, 302, 'Test 8: redirect status_code is 302');
    assertEq(redirectCompletion?.aborted, false, 'Test 8: redirect is not aborted');
    assertEq(redirectCompletion?.success, false, 'Test 8: 3xx completion is unsuccessful');
    assertEq(abortedCompletion?.aborted, true, 'Test 8: disconnect is aborted');
    assertEq(abortedCompletion?.success, false, 'Test 8: aborted completion is unsuccessful');

    const recent = await httpJson(
      port,
      'GET',
      `${sessionPrefix}/c-thru/recent?n=10&access_token=QUERY_SECRET_SHOULD_NOT_LOG`,
      null,
      {},
    );
    assertEq(recent.status, 200, 'Test 8: session-scoped recent view returned 200');
    assert(
      recent.json?.requests?.length >= 3 &&
        recent.json.requests.every(entry => entry.endpoint === '/v1/messages'),
      'Test 8: every retained recent entry uses only the query-free Messages path',
    );
    assertEq(
      recent.json.requests.find(entry => entry.status === 302)?.ok,
      false,
      'Test 8: recent redirect entry is unsuccessful like request.complete',
    );
    const recentJson = JSON.stringify(recent.json);
    assert(!recentJson.includes('QUERY_SECRET_SHOULD_NOT_LOG'),
      'Test 8: recent JSON omits the query-token canary');

    const completionJson = JSON.stringify([
      ...completions,
      ...otherCompletions,
      ...redactedCompletions,
    ]);
    assert(!completionJson.includes(sessionPrefix), 'Test 8: completion paths omit session prefix');
    for (const privateValue of [
      'HEADER_SECRET_SHOULD_NOT_LOG',
      'BODY_SECRET_SHOULD_NOT_LOG',
      'RAW_UPSTREAM_ERROR_SHOULD_NOT_LOG',
      'QUERY_SECRET_SHOULD_NOT_LOG',
      'SECRET_PATH_SEGMENT_SHOULD_NOT_LOG',
    ]) {
      assert(!completionJson.includes(privateValue),
        `Test 8: completion omits private value ${privateValue}`);
    }
    const wholeProxyLog = fs.readFileSync(logFile, 'utf8') + '\n' + debugStderr;
    for (const privateValue of [
      'QUERY_SECRET_SHOULD_NOT_LOG',
      'SECRET_PATH_SEGMENT_SHOULD_NOT_LOG',
    ]) {
      assert(!wholeProxyLog.includes(privateValue),
        `Test 8: entire proxy log omits private request target value ${privateValue}`);
    }

    await killAndWait(state.child); await stub.close(); cleanup(state.tmpHome);
  } catch (e) {
    await teardown(state, stub);
    throw e;
  }
}

async function testRequestIdStrengthAndUniqueness() {
  console.log('\nTest 9: request lifecycle IDs are 128-bit and collision-free in a burst');
  let state, stub;
  try {
    stub = await stubBackend();
    state = await spawnRecentProxy(buildConfig(stub.port));
    const { port } = state;
    const logFile = path.join(state.tmpHome, '.claude', 'proxy.log');
    const sampleSize = 128;
    const batchSize = 16;
    const clientCanary = 'req-id-uniqueness-regression';

    const responses = [];
    for (let offset = 0; offset < sampleSize; offset += batchSize) {
      responses.push(...await Promise.all(
        Array.from({ length: batchSize }, () =>
          httpJson(port, 'GET', '/ping', null, { 'user-agent': clientCanary })),
      ));
    }
    assert(
      responses.every(response => response.status === 200),
      `Test 9: all ${sampleSize} burst requests returned 200`,
    );

    const starts = await waitForLogEvents(
      logFile,
      'request',
      event => event.client === clientCanary,
      sampleSize,
      5000,
    );
    assertEq(starts.length, sampleSize,
      `Test 9: captured ${sampleSize} request-start events`);
    const ids = starts.map(event => event.req_id);
    assert(ids.every(id => /^[0-9a-f]{32}$/.test(id)),
      'Test 9: every req_id is exactly 128-bit lowercase hex');
    assertEq(new Set(ids).size, sampleSize,
      `Test 9: ${sampleSize} request-start IDs are unique`);

    const idSet = new Set(ids);
    const completions = await waitForLogEvents(
      logFile,
      'request.complete',
      event => idSet.has(event.req_id),
      sampleSize,
      5000,
    );
    assertEq(completions.length, sampleSize,
      `Test 9: captured ${sampleSize} correlated completion events`);
    const completionCountById = new Map();
    for (const event of completions) {
      completionCountById.set(
        event.req_id,
        (completionCountById.get(event.req_id) || 0) + 1,
      );
    }
    assert(
      ids.every(id => completionCountById.get(id) === 1),
      'Test 9: each strong request ID joins to exactly one completion',
    );

    await killAndWait(state.child); await stub.close(); cleanup(state.tmpHome);
  } catch (e) {
    await teardown(state, stub);
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
  await testRequestCompleteLog();
  await testRequestIdStrengthAndUniqueness();

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
