#!/usr/bin/env node
'use strict';
// Test: /v1/messages/count_tokens against Ollama-format backends is short-circuited
// with a proxy-side heuristic estimate instead of forwarded (Ollama's /v1/messages
// adapter 404s on count_tokens). The response must be Anthropic-shaped
// ({input_tokens}), carry the x-c-thru-count-tokens: estimate header, and —
// crucially — the upstream backend must NOT receive the request (proving the
// short-circuit, not a passthrough). Also covers the HEAD / liveness handler.
//
// Run: node test/proxy-count-tokens.test.js

const http = require('http');
const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson,
} = require('./helpers');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

console.log('proxy count_tokens + HEAD / tests\n');

// Stub that FAILS count_tokens (404) so the only way the client gets a 200 is
// the proxy's short-circuit. Records every request it receives so the test can
// prove count_tokens was never forwarded.
function recordingStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url });
      // count_tokens is the endpoint the proxy must NOT forward here. If it ever
      // does, the stub 404s so the test fails loudly instead of passing by accident.
      if (req.url && req.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'too many concurrent requests' }));
        return;
      }
      // Generic /v1/messages success so the proxy can boot / ping healthily.
      const resp = JSON.stringify({
        id: 'msg_stub', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'stub', stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(resp)),
      });
      res.end(resp);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server, port: server.address().port, requests,
        lastRequest: () => requests[requests.length - 1] || null,
        sawCountTokens: () => requests.some(r => r.path && r.path.startsWith('/v1/messages/count_tokens')),
        close: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

// Raw HEAD request (httpJson is JSON-only and writes a body). Returns status + headers.
function headRoot(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/', method: 'HEAD' },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          bodyBytes: Buffer.concat(chunks).length,
        }));
      },
    );
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('HEAD / timed out')); });
    req.end();
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-count-tokens-'));

  try {
    // ── Test 1: count_tokens is short-circuited, not forwarded ──────────────
    console.log('1. /v1/messages/count_tokens short-circuited with estimate (Ollama backend)');
    {
      const stub = await recordingStub();
      try {
        const cfg = {
          backends: { stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${stub.port}` } },
          model_routes: { 'short': 'stub_ollama' },
          llm_profiles: {
            '64gb': { workhorse: { connected_model: 'short', disconnect_model: 'short' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages/count_tokens', {
            model: 'short',
            messages: [{ role: 'user', content: 'hello world this is a token estimate test' }],
            system: 'you are helpful',
          });
          assertEq(r.status, 200, 'count_tokens returned 200 (short-circuit, not upstream 404)');
          assert(!!r.json && typeof r.json.input_tokens === 'number',
            `response body has numeric input_tokens (got: ${JSON.stringify(r.json)})`);
          assert(r.json.input_tokens >= 1, `input_tokens is >= 1 (got: ${r.json.input_tokens})`);
          // Observability header must mark it as an estimate.
          assert(r.headers['x-c-thru-count-tokens'] === 'estimate',
            `x-c-thru-count-tokens: estimate header present (got: ${JSON.stringify(r.headers['x-c-thru-count-tokens'])})`);
          // The upstream must NOT have seen the count_tokens request — proves the
          // short-circuit fired instead of a passthrough that happened to succeed.
          assert(!stub.sawCountTokens(),
            'upstream never received count_tokens (short-circuited at proxy)');
        });
      } finally {
        await stub.close().catch(() => {});
      }
    }

    // ── Test 2: estimate scales with input size ─────────────────────────────
    console.log('\n2. estimate grows with larger input');
    {
      const stub = await recordingStub();
      try {
        const cfg = {
          backends: { stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${stub.port}` } },
          model_routes: { 'short': 'stub_ollama' },
          llm_profiles: {
            '64gb': { workhorse: { connected_model: 'short', disconnect_model: 'short' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'connected' }, async ({ port }) => {
          const small = await httpJson(port, 'POST', '/v1/messages/count_tokens', {
            model: 'short', messages: [{ role: 'user', content: 'hi' }],
          });
          const big = await httpJson(port, 'POST', '/v1/messages/count_tokens', {
            model: 'short',
            messages: [{ role: 'user', content: 'x'.repeat(4000) }],
          });
          assertEq(small.status, 200, 'small request 200');
          assertEq(big.status, 200, 'big request 200');
          assert(big.json.input_tokens > small.json.input_tokens,
            `bigger input yields more tokens (big=${big.json.input_tokens} > small=${small.json.input_tokens})`);
        });
      } finally {
        await stub.close().catch(() => {});
      }
    }

    // ── Test 3: HEAD / liveness probe → 200, empty body, no upstream hit ────
    console.log('\n3. HEAD / answered by proxy (200, empty body)');
    {
      const stub = await recordingStub();
      try {
        const cfg = {
          backends: { stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${stub.port}` } },
          model_routes: { 'short': 'stub_ollama' },
          llm_profiles: {
            '64gb': { workhorse: { connected_model: 'short', disconnect_model: 'short' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'connected' }, async ({ port }) => {
          const r = await headRoot(port);
          assertEq(r.status, 200, 'HEAD / returns 200 (not 404 unhandled_url)');
          assertEq(r.bodyBytes, 0, 'HEAD / response has empty body');
          // The stub is an Ollama backend; HEAD / must be answered by the proxy
          // itself, never forwarded.
          assert(!stub.requests.some(x => x.method === 'HEAD'),
            'HEAD / not forwarded to upstream');
        });
      } finally {
        await stub.close().catch(() => {});
      }
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });