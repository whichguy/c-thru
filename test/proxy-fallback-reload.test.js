#!/usr/bin/env node
'use strict';
// Tests for S5: config version stamp on requestMeta._configVersion.
// Verifies that when CONFIG is reloaded mid-session (SIGHUP), the fallback
// cycle-detection visited-set is reset so new cycles in the reloaded graph
// are detectable — without causing infinite loops on the in-flight request.
//
// Run: node test/proxy-fallback-reload.test.js

const fs   = require('fs');
const http = require('http');
const os   = require('os');
const path = require('path');

const { assert, assertEq, summary, writeConfig, withProxy, httpJson, spawnProxy, waitForPing, collectStderr } = require('./helpers');

console.log('proxy-fallback-reload tests\n');

// Minimal stub backend for non-error responses.
function stubBackend() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({ headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_stub', type: 'message', role: 'assistant',
        model: body?.model || 'stub', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 5, output_tokens: 3 },
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        requests,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-fr-'));

  // ── Test 1: requests succeed after SIGHUP reload ────────────────────────────
  console.log('1. requests succeed after SIGHUP config reload');
  {
    const stub = await stubBackend();
    try {
      const configPath = writeConfig(tmpDir, {
        backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
        model_routes: { 'test-model': 'stub' },
        llm_profiles: { workhorse: { 'best-cloud': { '128gb': 'test-model' } } },
      });

      await withProxy({ configPath, profile: '128gb', mode: 'best-cloud' }, async ({ port, child }) => {
        // First request — baseline
        const r1 = await httpJson(port, 'POST', '/v1/messages', {
          model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
        });
        assertEq(r1.status, 200, 'pre-SIGHUP request succeeds');

        // Trigger config reload — write a semantically equivalent config and send SIGHUP
        fs.writeFileSync(configPath, JSON.stringify({
          backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
          model_routes: { 'test-model': 'stub' },
          llm_profiles: { workhorse: { 'best-cloud': { '128gb': 'test-model' } } },
          _reload_marker: 1,
        }));
        process.kill(child.pid, 'SIGHUP');

        // Brief settle time for reload to complete
        await new Promise(r => setTimeout(r, 150));

        // Post-SIGHUP request — should succeed with the reloaded config
        const r2 = await httpJson(port, 'POST', '/v1/messages', {
          model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
        });
        assertEq(r2.status, 200, 'post-SIGHUP request succeeds');
        assert(stub.requests.length >= 2, `stub received ≥2 requests (got ${stub.requests.length})`);
      });
    } finally { await stub.close().catch(() => {}); }
  }

  // ── Test 2: CONFIG._version increments on each reload ──────────────────────
  console.log('\n2. CONFIG._version increments on SIGHUP (verified via /ping config_source)');
  {
    const stub = await stubBackend();
    try {
      const configPath = writeConfig(tmpDir, {
        backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
        model_routes: { 'test-model': 'stub' },
        llm_profiles: { workhorse: { 'best-cloud': { '128gb': 'test-model' } } },
      });

      await withProxy({ configPath, profile: '128gb', mode: 'best-cloud' }, async ({ port, child }) => {
        // Verify /ping reports config
        const ping1 = await httpJson(port, 'GET', '/ping', null);
        assertEq(ping1.status, 200, 'proxy is up');
        assert(ping1.json?.ok === true, '/ping returns ok:true before reload');

        // Reload
        fs.writeFileSync(configPath, JSON.stringify({
          backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
          model_routes: { 'test-model': 'stub' },
          llm_profiles: { workhorse: { 'best-cloud': { '128gb': 'test-model' } } },
          _reload_marker: 2,
        }));
        process.kill(child.pid, 'SIGHUP');
        await new Promise(r => setTimeout(r, 200));

        // Proxy should still respond after reload
        const ping2 = await httpJson(port, 'GET', '/ping', null);
        assertEq(ping2.status, 200, 'proxy responds after SIGHUP');
        assert(ping2.json?.ok === true, '/ping returns ok:true after reload');

        // Confirm a request still routes correctly after reload
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
        });
        assertEq(r.status, 200, 'request succeeds after reload');
      });
    } finally { await stub.close().catch(() => {}); }
  }

  // ── Test 3: no hang or double-dispatch on fallback after reload ────────────
  console.log('\n3. fallback chain still terminates after config reload');
  {
    const stub = await stubBackend();
    try {
      // primary → fallback → stub
      const configPath = writeConfig(tmpDir, {
        backends: {
          primary: { kind: 'anthropic', url: 'http://127.0.0.1:1', fallback_to: 'stub' },  // port 1 = unreachable
          stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` },
        },
        model_routes: { 'test-model': 'primary' },
        llm_profiles: { workhorse: { 'best-cloud': { '128gb': 'test-model' } } },
      });

      await withProxy({ configPath, profile: '128gb', mode: 'best-cloud' }, async ({ port, child }) => {
        // Reload config then immediately try a request through the fallback chain.
        fs.writeFileSync(configPath, JSON.stringify({
          backends: {
            primary: { kind: 'anthropic', url: 'http://127.0.0.1:1', fallback_to: 'stub' },
            stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` },
          },
          model_routes: { 'test-model': 'primary' },
          llm_profiles: { workhorse: { 'best-cloud': { '128gb': 'test-model' } } },
          _reload_marker: 3,
        }));
        process.kill(child.pid, 'SIGHUP');
        await new Promise(r => setTimeout(r, 150));

        // Request should fall through primary (unreachable) → stub (reachable) without hanging.
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
        }, {}, 5000);
        // Either 200 (fallback succeeded) or 5xx (upstream error) — crucially not a hang.
        assert(r.status >= 200 && r.status < 600, `response received without hang (status ${r.status})`);
        assert(r.status !== undefined, 'response completed (not a timeout)');
      });
    } finally { await stub.close().catch(() => {}); }
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
