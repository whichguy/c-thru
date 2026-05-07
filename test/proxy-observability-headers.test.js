#!/usr/bin/env node
'use strict';
// Tests for observability headers added to all proxy responses:
//   x-c-thru-backend-latency-ms  — upstream response time in ms
//   x-c-thru-auth-missing        — set to '1' when auth_env is configured but var is unset
//   x-c-thru-tier-detected       — hw-detected tier (always; may differ from tier-used)
//   x-c-thru-tier-used           — effective tier (after CLAUDE_LLM_PROFILE override)
//
// Run: node test/proxy-observability-headers.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');

const { assert, assertEq, summary, writeConfig, withProxy, httpJson, stubBackend } = require('./helpers');

console.log('proxy-observability-headers tests\n');

// Stub backend with configurable delay.
function delayedStubBackend(delayMs = 0) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({ headers: req.headers, body });
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_stub', type: 'message', role: 'assistant',
          model: body?.model || 'stub', stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 3 },
        }));
      }, delayMs);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, requests, lastRequest: () => requests[requests.length - 1], close: () => new Promise(r => server.close(r)) });
    });
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-obs-'));

  // ── Test 1: x-c-thru-backend-latency-ms is present and ≥ 50ms ──────────────
  console.log('1. x-c-thru-backend-latency-ms present and ≥ 50ms for delayed stub');
  {
    const stub = await delayedStubBackend(60);
    try {
      const configPath = writeConfig(tmpDir, {
        backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
        model_routes: { 'test-model': 'stub' },
        llm_profiles: { workhorse: { 'best-cloud': { '128gb': 'test-model' } } },
      });
      await withProxy({ configPath, profile: '128gb', mode: 'best-cloud' }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
        });
        assertEq(r.status, 200, 'request succeeded');
        const latency = r.headers['x-c-thru-backend-latency-ms'];
        assert(latency !== undefined, 'x-c-thru-backend-latency-ms is present');
        assert(Number(latency) >= 50, `latency ≥ 50ms (got ${latency})`);
      });
    } finally { await stub.close().catch(() => {}); }
  }

  // ── Test 2: x-c-thru-auth-missing when auth_env is configured but unset ────
  console.log('\n2. x-c-thru-auth-missing:1 when auth_env var is unset');
  {
    const stub = await delayedStubBackend();
    try {
      const configPath = writeConfig(tmpDir, {
        endpoints: {
          secured: {
            kind: 'anthropic',
            url: `http://127.0.0.1:${stub.port}`,
            auth_env: 'TEST_MISSING_KEY_XYZ_NOTSET',
          },
        },
        model_routes: { 'secured-model': 'secured' },
        llm_profiles: { workhorse: { 'best-cloud': { '128gb': 'secured-model' } } },
      });
      await withProxy({ configPath, profile: '128gb', mode: 'best-cloud' }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'secured-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
        });
        assertEq(r.status, 200, 'request still reaches backend (auth passthrough)');
        assertEq(r.headers['x-c-thru-auth-missing'], '1', 'x-c-thru-auth-missing:1 set');
      });
    } finally { await stub.close().catch(() => {}); }
  }

  // ── Test 3: x-c-thru-auth-missing absent when auth_env IS set ──────────────
  console.log('\n3. x-c-thru-auth-missing absent when auth_env var is set');
  {
    const stub = await delayedStubBackend();
    try {
      const configPath = writeConfig(tmpDir, {
        endpoints: {
          secured: {
            kind: 'anthropic',
            url: `http://127.0.0.1:${stub.port}`,
            auth_env: 'TEST_PRESENT_KEY_XYZ',
          },
        },
        model_routes: { 'secured-model': 'secured' },
        llm_profiles: { workhorse: { 'best-cloud': { '128gb': 'secured-model' } } },
      });
      await withProxy({
        configPath, profile: '128gb', mode: 'best-cloud',
        env: { TEST_PRESENT_KEY_XYZ: 'sk-test-value' },
      }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'secured-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
        });
        assertEq(r.status, 200, 'request succeeded');
        assertEq(r.headers['x-c-thru-auth-missing'], undefined, 'x-c-thru-auth-missing absent');
      });
    } finally { await stub.close().catch(() => {}); }
  }

  // ── Test 4: tier headers present; match when no override ───────────────────
  console.log('\n4. x-c-thru-tier-detected and x-c-thru-tier-used present and equal (no override)');
  {
    const stub = await delayedStubBackend();
    try {
      const configPath = writeConfig(tmpDir, {
        backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
        model_routes: { 'tier-model': 'stub' },
        llm_profiles: {
          workhorse: {
            'best-cloud': { '16gb': 'tier-model', '32gb': 'tier-model', '64gb': 'tier-model', '128gb': 'tier-model' },
          },
        },
      });
      await withProxy({ configPath, profile: '64gb', mode: 'best-cloud' }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'workhorse', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
        });
        assertEq(r.status, 200, 'request succeeded');
        const detected = r.headers['x-c-thru-tier-detected'];
        const used = r.headers['x-c-thru-tier-used'];
        assert(detected !== undefined, 'x-c-thru-tier-detected is present');
        assert(used !== undefined, 'x-c-thru-tier-used is present');
      });
    } finally { await stub.close().catch(() => {}); }
  }

  // ── Test 5: tier headers differ when CLAUDE_LLM_PROFILE overrides hw tier ──
  console.log('\n5. x-c-thru-tier-detected ≠ x-c-thru-tier-used when profile is overridden');
  {
    const stub = await delayedStubBackend();
    try {
      const configPath = writeConfig(tmpDir, {
        backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
        model_routes: { 'tier-model': 'stub' },
        llm_profiles: {
          workhorse: {
            'best-cloud': {
              '16gb': 'tier-model', '32gb': 'tier-model',
              '48gb': 'tier-model', '64gb': 'tier-model', '128gb': 'tier-model',
            },
          },
        },
      });
      // Override CLAUDE_LLM_PROFILE to 16gb (smaller than the machine's actual tier).
      // detected = actual hw tier; used = 16gb (profile override); they will differ.
      const actualTier = require('../tools/hw-profile.js').tierForGb(Math.ceil(require('os').totalmem() / (1024 ** 3)));
      await withProxy({
        configPath, profile: '16gb', mode: 'best-cloud',
      }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'workhorse', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
        });
        assertEq(r.status, 200, 'request succeeded');
        const detected = r.headers['x-c-thru-tier-detected'];
        const used = r.headers['x-c-thru-tier-used'];
        assert(detected !== undefined, 'x-c-thru-tier-detected is present');
        assert(used !== undefined, 'x-c-thru-tier-used is present');
        assertEq(detected, actualTier, `detected tier matches hw (got ${detected})`);
        assertEq(used, '16gb', `used tier is 16gb (profile override) (got ${used})`);
        assert(detected !== used, 'detected and used tiers differ (override in effect)');
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
