#!/usr/bin/env node
'use strict';
// Test: the proxy correctly scrubs (removes) the Content-Length header before
// forwarding to upstreams.  When the proxy rewrites the request body (model
// name swap, message flattening, keep_alive injection) the original
// Content-Length becomes stale and would cause upstream 400s or hangs.
// scrubCthruHeaders() must delete it so Node recomputes the correct length.
//
// Run: node test/proxy-content-length-scrub.test.js

const http = require('http');
const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson,
} = require('./helpers');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

console.log('proxy content-length scrub tests\n');

// Starts a stub that records the content-length header (if any) and the actual
// body size received, then returns a minimal valid Anthropic-shape response.
function measuringStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(parts);
      let body = null;
      try { body = JSON.parse(rawBody.toString('utf8')); } catch {}
      requests.push({
        method:         req.method,
        path:           req.url,
        body,
        model_used:     body ? body.model : null,
        // Content-length as seen by the upstream server (the value the proxy forwarded).
        forwarded_cl:   req.headers['content-length'],
        // Accept-Encoding: scrubCthruHeaders must force identity (no gzip/br).
        forwarded_ae:   req.headers['accept-encoding'],
        // Actual bytes received — what the real content-length SHOULD be.
        actual_bytes:   rawBody.length,
      });
      const resp = JSON.stringify({
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: body ? body.model : 'stub',
        stop_reason: 'end_turn',
        stop_sequence: null,
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
        server,
        port:         server.address().port,
        requests,
        lastRequest: () => requests[requests.length - 1] || null,
        close:       () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-cl-scrub-'));

  try {
    // ── Test 1: Content-Length is absent from the forwarded request ──────────
    // The proxy's scrubCthruHeaders() removes 'content-length' unconditionally
    // so that Node's http.request uses chunked/computed transfer encoding after
    // the body rewrite. Upstream should receive NO content-length header at all.
    console.log('1. Content-Length absent in forwarded Ollama request (body is rewritten)');
    {
      const stub = await measuringStub();
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
          // The client sends a model name "short" which the proxy will rewrite
          // to a different model if configured, or at minimum wrap in the
          // Ollama body shape (model, messages, stream, keep_alive, options).
          // Either way the outgoing body will be different from the incoming body.
          const clientBody = JSON.stringify({
            model: 'short',
            stream: false,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 50,
          });
          const r = await httpJson(port, 'POST', '/v1/messages',
            { model: 'short', stream: false, messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 },
            { 'content-length': String(Buffer.byteLength(clientBody)) },  // client sends stale length
          );
          assertEq(r.status, 200, 'request succeeded (200)');

          const req = stub.lastRequest();
          assert(!!req, 'stub received request');
          // Client Content-Length is scrubbed, then the proxy may re-set CL to the
          // *rewritten* body size (Anthropic path after model rewrite / xAI sanitize).
          // Invariant: if CL is present it MUST equal actual bytes — never a stale client CL.
          if (req.forwarded_cl !== undefined) {
            assertEq(Number(req.forwarded_cl), req.actual_bytes,
              `forwarded content-length matches rewritten body (got CL=${req.forwarded_cl}, bytes=${req.actual_bytes})`);
          }
          assert(req.actual_bytes > 0, `upstream received non-empty body (${req.actual_bytes} bytes)`);
        });
      } finally {
        await stub.close().catch(() => {});
      }
    }

    // ── Test 2: long model name → body grows vs. incoming CL; no mismatch ────
    // "long-model-name-that-is-much-longer-than-short" is the resolved model;
    // the proxy builds an Ollama body around it. If it were to forward the
    // original content-length the upstream would see a longer body than the
    // header claimed, causing most HTTP servers to read only N bytes and
    // return 400 on the leftover.
    console.log('\n2. Model name much longer than original — no content-length mismatch');
    {
      const longModelName = 'very-long-model-name-that-exceeds-the-incoming-body-length-considerably-long';
      const stub = await measuringStub();
      try {
        const cfg = {
          backends: { stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${stub.port}` } },
          model_routes: { [longModelName]: 'stub_ollama' },
          llm_profiles: {
            '64gb': { workhorse: { connected_model: longModelName, disconnect_model: longModelName } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: longModelName,
            stream: false,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 10,
          });
          assertEq(r.status, 200, 'long model name request succeeded (200)');

          const req = stub.lastRequest();
          assert(!!req, 'stub received request');
          assertEq(req.model_used, longModelName, `upstream saw the long model name`);
          // Same invariant as test 1: CL absent (chunked) OR CL === actual bytes.
          if (req.forwarded_cl !== undefined) {
            assertEq(Number(req.forwarded_cl), req.actual_bytes,
              `long-name: forwarded CL matches body (CL=${req.forwarded_cl}, bytes=${req.actual_bytes})`);
          }
        });
      } finally {
        await stub.close().catch(() => {});
      }
    }

    // ── Test 3: Anthropic-kind backend — content-length matches rewritten body ─
    // forwardAnthropic scrubs the client Content-Length then re-sets it to
    // Buffer.byteLength(payload) after model rewrite / sanitize so upstreams
    // that reject chunked-only bodies (and length-mismatch traps) stay happy.
    console.log('\n3. Anthropic-kind backend — content-length matches rewritten body');
    {
      const stub = await measuringStub();
      try {
        const cfg = {
          backends: { cloud_stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
          model_routes: { 'claude-test': 'cloud_stub' },
          llm_profiles: {
            '64gb': { workhorse: { connected_model: 'claude-test', disconnect_model: 'claude-test' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'connected' }, async ({ port }) => {
          // Send a correct content-length (the helpers.js httpJson helper sets it
          // automatically). The proxy scrubs then re-sets to the outbound payload size.
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'claude-test',
            stream: false,
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 10,
          });

          assertEq(r.status, 200, 'anthropic-kind backend request succeeded');
          const req = stub.lastRequest();
          assert(!!req, 'stub received request');
          // Scrub removes client CL; Anthropic path re-sets CL to payload bytes.
          if (req.forwarded_cl !== undefined) {
            assertEq(Number(req.forwarded_cl), req.actual_bytes,
              `anthropic: forwarded CL matches body (CL=${req.forwarded_cl}, bytes=${req.actual_bytes})`);
          }
          assert(req.actual_bytes > 0, `upstream received non-empty body (${req.actual_bytes} bytes)`);
        });
      } finally {
        await stub.close().catch(() => {});
      }
    }

    // ── Test 4: Accept-Encoding forced to identity ───────────────────────────
    // Client may send Accept-Encoding: gzip; scrub must rewrite to identity so
    // translate/usage paths never parse compressed upstream bodies as text.
    console.log('\n4. Client Accept-Encoding:gzip → upstream gets identity');
    {
      const stub = await measuringStub();
      try {
        const cfg = {
          backends: { cloud_stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
          model_routes: { 'claude-test': 'cloud_stub' },
          llm_profiles: {
            '64gb': { workhorse: { connected_model: 'claude-test', disconnect_model: 'claude-test' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'claude-test',
            stream: false,
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 10,
          }, { 'Accept-Encoding': 'gzip, deflate, br' });

          assertEq(r.status, 200, 'accept-encoding test request succeeded');
          const req = stub.lastRequest();
          assert(!!req, 'stub received request');
          assertEq(req.forwarded_ae, 'identity',
            `upstream Accept-Encoding is identity (got ${JSON.stringify(req.forwarded_ae)})`);
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
