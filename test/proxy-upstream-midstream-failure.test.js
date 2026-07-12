#!/usr/bin/env node
'use strict';
// Round-5 Phase A regression suite: upstream TRANSPORT failure after the
// response is committed (headers sent) must never hang the client or kill
// the proxy.
//
// Distinct from proxy-forward-ollama-midstream-error.test.js, which tests
// malformed NDJSON content followed by a CLEAN upstream end — here the
// upstream socket is destroyed mid-response (network blip, upstream crash),
// which pre-fix left forwardAnthropic/forwardGemini/handleOllamaNonStream
// with no upRes 'error'/'aborted' handler: the client hung on a truncated
// response and a non-ignored error code could reach uncaughtException and
// process.exit(1) the shared proxy.
//
// Contract under test (the A0 termination primitive):
//   - committed SSE response  -> one Anthropic-shape `error` frame + end
//   - committed JSON response -> connection terminated (no SSE corruption)
//   - pre-commitment failure  -> normal backend-failure path (5xx/fallback)
//   - in every case the proxy process survives and /ping still answers
//
// Run: node test/proxy-upstream-midstream-failure.test.js

const http = require('http');
const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpStream, httpJson,
} = require('./helpers');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

console.log('proxy upstream midstream transport-failure tests\n');

// Stub that sends `head` (status+headers), then `frames` (with small delays),
// then destroys the socket WITHOUT a clean end. `raw: true` frames bypass
// res.write framing and go straight to the socket (used to inject bytes that
// corrupt chunked encoding — the strongest crash repro).
function abruptStub({ headers, frames, destroyDelayMs = 30 }) {
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      res.writeHead(200, headers);
      let i = 0;
      const tick = () => {
        if (i >= frames.length) {
          setTimeout(() => { try { res.socket.destroy(); } catch {} }, destroyDelayMs);
          return;
        }
        const f = frames[i++];
        if (f && f.raw) { try { res.socket.write(f.raw); } catch {} }
        else res.write(f);
        setTimeout(tick, 10);
      };
      tick();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise(r => server.close(r)),
    }));
    server.on('error', reject);
  });
}

function pingAlive(port) {
  return httpJson(port, 'GET', '/ping').then(r => r.status === 200).catch(() => false);
}

// Abort-aware request: unlike helpers.httpStream (which only settles on a
// clean 'end' or a request-level error), this also settles when the proxy
// DESTROYS the response socket mid-body — the correct post-fix behavior for
// a committed JSON response (terminateCommittedResponse -> res.destroy()).
// Resolves {kind: 'ended'|'aborted'|'req_error'|'hung', ...}; never rejects.
function httpObserveTermination(port, urlPath, body, wallClockMs = 8000) {
  return new Promise(resolve => {
    const bodyStr = JSON.stringify(body);
    let settled = false;
    const settle = v => { if (!settled) { settled = true; clearTimeout(wall); resolve(v); } };
    const wall = setTimeout(() => settle({ kind: 'hung' }), wallClockMs);
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => settle({ kind: 'ended', status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('aborted', () => settle({ kind: 'aborted', status: res.statusCode }));
      res.on('error', () => settle({ kind: 'aborted', status: res.statusCode }));
      res.on('close', () => settle({ kind: 'aborted', status: res.statusCode }));
    });
    req.on('error', e => settle({ kind: 'req_error', error: e.message }));
    req.end(bodyStr);
  });
}

const MSG_START = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01X","usage":{"input_tokens":7,"output_tokens":0}}}\n\n';
const TEXT_DELTA = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n';

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-midstream-fail-'));

  try {
    // ── 1. Anthropic passthrough, SSE stream, upstream socket destroyed ─────
    console.log('1. forwardAnthropic SSE: upstream destroy -> error frame + end + proxy alive');
    {
      const stub = await abruptStub({
        headers: { 'Content-Type': 'text/event-stream' },
        frames: [MSG_START, TEXT_DELTA],
      });
      try {
        const cfg = {
          endpoints: { anthropic: { kind: 'anthropic', format: 'anthropic', url: `http://127.0.0.1:${stub.port}`, auth: 'none' } },
          model_routes: { 'claude-test': 'anthropic' },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'claude-test', stream: true, max_tokens: 32,
            messages: [{ role: 'user', content: 'hi' }],
          }, {}, 8000);
          assertEq(r.status, 200, 'stream committed with 200 before the failure');
          const names = r.events.map(e => e.event);
          assert(names.includes('error'),
            `terminal error SSE frame emitted on upstream transport failure (got events: ${names.join(',')})`);
          const errEv = r.events.find(e => e.event === 'error');
          assert(errEv && errEv.data && errEv.data.error && errEv.data.error.type === 'api_error',
            'error frame is Anthropic-shaped (type api_error)');
          assert(await pingAlive(port), 'proxy still answers /ping after midstream failure');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── 2. Anthropic passthrough, non-stream JSON, upstream destroyed ───────
    console.log('\n2. forwardAnthropic JSON: upstream destroy -> fast termination (no hang) + proxy alive');
    {
      const stub = await abruptStub({
        headers: { 'Content-Type': 'application/json' },
        frames: ['{"id":"msg_01X","type":"message","content":[{"type":"text","te'],
      });
      try {
        const cfg = {
          endpoints: { anthropic: { kind: 'anthropic', format: 'anthropic', url: `http://127.0.0.1:${stub.port}`, auth: 'none' } },
          model_routes: { 'claude-test': 'anthropic' },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath }, async ({ port }) => {
          const started = Date.now();
          const outcome = await httpObserveTermination(port, '/v1/messages', {
            model: 'claude-test', stream: false, max_tokens: 32,
            messages: [{ role: 'user', content: 'hi' }],
          }, 8000);
          const elapsed = Date.now() - started;
          // A partially-written JSON body cannot be repaired — the contract is
          // prompt TERMINATION (abrupt socket close), not a hang. 'ended' with
          // a truncated body would also be acceptable; 'hung' is the pre-fix
          // failure mode.
          assert(outcome.kind !== 'hung',
            `response terminated promptly, not hung (outcome: ${JSON.stringify(outcome)})`);
          assert(elapsed < 5000, `terminated in ${elapsed}ms (<5s)`);
          assert(await pingAlive(port), 'proxy still answers /ping after non-stream midstream failure');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── 3. Corrupt chunked encoding (raw socket bytes) — crash regression ───
    // Injecting bytes that violate chunked framing makes Node's HTTP parser
    // raise a non-ECONNRESET error (HPE_*) on the upstream response — the
    // exact class that pre-fix escaped to uncaughtException and
    // process.exit(1). The client-side outcome is version-dependent and NOT
    // asserted; the invariant is that the proxy SURVIVES.
    console.log('\n3. Corrupt chunked bytes from upstream -> proxy survives (crash regression)');
    {
      const stub = await abruptStub({
        headers: { 'Content-Type': 'text/event-stream' },
        frames: [MSG_START, { raw: 'NOT_A_CHUNK_SIZE\r\n\r\n' }],
      });
      try {
        const cfg = {
          endpoints: { anthropic: { kind: 'anthropic', format: 'anthropic', url: `http://127.0.0.1:${stub.port}`, auth: 'none' } },
          model_routes: { 'claude-test': 'anthropic' },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath }, async ({ port }) => {
          // Client-side outcome is Node-version-dependent and not asserted —
          // the invariant is proxy survival. Abort-aware helper so the await
          // settles regardless of how the failure surfaces client-side.
          await httpObserveTermination(port, '/v1/messages', {
            model: 'claude-test', stream: true, max_tokens: 32,
            messages: [{ role: 'user', content: 'hi' }],
          }, 6000);
          assert(await pingAlive(port), 'proxy survives corrupt upstream chunked encoding');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── 4. Gemini streaming: upstream destroy -> error frame + end ──────────
    console.log('\n4. forwardGemini SSE: upstream destroy -> error frame + end + proxy alive');
    {
      const gframe = 'data: ' + JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'partial' }] } }],
      }) + '\n\n';
      const stub = await abruptStub({
        headers: { 'Content-Type': 'text/event-stream' },
        frames: [gframe],
      });
      try {
        const cfg = {
          endpoints: { gemini_stub: { kind: 'gemini', format: 'gemini', call_style: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: 'none' } },
          model_routes: { 'gemini-test-model': 'gemini_stub' },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'gemini-test-model', stream: true, max_tokens: 32,
            messages: [{ role: 'user', content: 'hi' }],
          }, {}, 8000);
          assertEq(r.status, 200, 'gemini stream committed with 200');
          const names = r.events.map(e => e.event);
          assert(names.includes('error'),
            `terminal error SSE frame on gemini upstream failure (got: ${names.join(',')})`);
          assert(await pingAlive(port), 'proxy alive after gemini midstream failure');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── 5. Gemini non-stream: destroy before end -> 5xx, not a hang ─────────
    console.log('\n5. forwardGemini non-stream: upstream destroy pre-commitment -> prompt 5xx');
    {
      const stub = await abruptStub({
        headers: { 'Content-Type': 'application/json' },
        frames: ['{"candidates":[{"content":{"par'],
      });
      try {
        const cfg = {
          endpoints: { gemini_stub: { kind: 'gemini', format: 'gemini', call_style: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: 'none' } },
          model_routes: { 'gemini-test-model': 'gemini_stub' },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath }, async ({ port }) => {
          const started = Date.now();
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'gemini-test-model', stream: false, max_tokens: 32,
            messages: [{ role: 'user', content: 'hi' }],
          }, {}, 8000);
          const elapsed = Date.now() - started;
          assert(r.status >= 500 && r.status < 600,
            `pre-commitment upstream drop surfaces as 5xx (got ${r.status})`);
          assert(elapsed < 5000, `answered in ${elapsed}ms, not hung`);
          assert(await pingAlive(port), 'proxy alive after gemini non-stream failure');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── 6. Ollama-legacy non-stream: destroy mid-body -> prompt 5xx ─────────
    console.log('\n6. handleOllamaNonStream: upstream destroy mid-body -> prompt 5xx, proxy alive');
    {
      const stub = await abruptStub({
        headers: { 'Content-Type': 'application/json' },
        frames: ['{"model":"m","message":{"content":"par'],
      });
      try {
        const cfg = {
          backends: { stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${stub.port}`, legacy_ollama_chat: true } },
          model_routes: { 'test-model': 'stub_ollama' },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath }, async ({ port }) => {
          const started = Date.now();
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'test-model', stream: false, max_tokens: 32,
            messages: [{ role: 'user', content: 'hi' }],
          }, {}, 8000);
          const elapsed = Date.now() - started;
          assert(r.status >= 500 && r.status < 600,
            `mid-body upstream drop surfaces as 5xx (got ${r.status})`);
          assert(elapsed < 5000, `answered in ${elapsed}ms, not hung`);
          assert(await pingAlive(port), 'proxy alive after ollama-legacy non-stream failure');
        });
      } finally { await stub.close().catch(() => {}); }
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
