#!/usr/bin/env node
'use strict';
/**
 * Anthropic API Coverage Test Suite
 *
 * Pins the matrix in docs/anthropic-api-coverage.md so passthrough vs 501
 * gating cannot regress silently. For each Anthropic-only path:
 *
 *   - With NO Anthropic auth in env / on the request:
 *       proxy must short-circuit to 501 with error.type === 'not_implemented'.
 *       (Matrix cell ⚠️/🔁 must NEVER hit api.anthropic.com without auth.)
 *
 *   - With Anthropic auth present and a stub backend configured as
 *     `endpoints.anthropic`:
 *       proxy must forward the request to the stub (not return 501).
 *       Verifies methods other than POST (DELETE) propagate.
 *
 * Plus a Gemini translation-gap header check: a request containing a
 * `redacted_thinking` block returns `x-c-thru-translation-gap: redacted_thinking`.
 *
 * Stdlib-only — local-bound stub backend, no network egress.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
  assert, assertEq, summary,
  stubBackend, writeConfig, httpJson, httpStream, withProxy, getFreePort,
} = require('./helpers');

console.log('anthropic-api-coverage: 501 gating + translation-gap header\n');

// Endpoints that must 501 when no anthropic endpoint is configured at all.
// Matches ANTHROPIC_ONLY_PATHS in tools/claude-proxy. /v1/oauth/token is
// excluded — bootstrap path, never gated. /v1/files/{id}/content is excluded
// — handed to handleFilesApi (Gemini) or anthropic catch-all.
const ANTHROPIC_ONLY_PROBES = [
  { method: 'POST',   path: '/v1/messages/batches', body: {} },
  { method: 'GET',    path: '/v1/messages/batches', body: null },
  { method: 'GET',    path: '/v1/messages/batches/abc123', body: null },
  { method: 'DELETE', path: '/v1/messages/batches/abc123', body: null },
  { method: 'POST',   path: '/v1/messages/batches/abc123/cancel', body: {} },
  { method: 'GET',    path: '/v1/skills', body: null },
  { method: 'POST',   path: '/v1/agents', body: {} },
  { method: 'POST',   path: '/v1/sessions', body: {} },
  { method: 'GET',    path: '/v1/environments', body: null },
  { method: 'GET',    path: '/v1/vaults', body: null },
  { method: 'GET',    path: '/v1/organizations/me', body: null },
  { method: 'GET',    path: '/v1/usage_report/messages', body: null },
  { method: 'GET',    path: '/v1/cost_report', body: null },
  { method: 'GET',    path: '/v1/rate_limits', body: null },
  { method: 'GET',    path: '/v1/audit_logs', body: null },
  { method: 'POST',   path: '/v1/complete', body: {} },
];

// Issues a request without Content-Type for null bodies (so GET/DELETE do not
// look like JSON requests). httpJson always sends Content-Type: application/json
// which is fine for a 501 short-circuit.
async function probe(port, method, urlPath, body) {
  return httpJson(port, method, urlPath, body, {}, 5000);
}

async function runUnauthedGating() {
  console.log('--- Phase 1: 501 gating when no anthropic endpoint configured ---');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-coverage-'));
  try {
    // Empty config — no anthropic endpoint at all.
    const configPath = writeConfig(tmpDir, {});
    await withProxy({ configPath }, async ({ port }) => {
      for (const p of ANTHROPIC_ONLY_PROBES) {
        const r = await probe(port, p.method, p.path, p.body);
        assertEq(r.status, 501, `${p.method} ${p.path} → 501 (no anthropic endpoint)`);
        const errType = r.json && r.json.error && r.json.error.type;
        assertEq(errType, 'not_implemented',
          `${p.method} ${p.path} error.type === 'not_implemented'`);
      }
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function runAuthedPassthrough() {
  console.log('\n--- Phase 2: passthrough with Anthropic stub + auth ---');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-coverage-'));
  let stub;
  try {
    stub = await stubBackend();
    const config = {
      endpoints: {
        anthropic: {
          kind: 'anthropic',
          url: `http://127.0.0.1:${stub.port}`,
          format: 'anthropic',
          auth_env: 'ANTHROPIC_API_KEY',
        },
      },
    };
    const configPath = writeConfig(tmpDir, config);
    await withProxy({
      configPath,
      env: { ANTHROPIC_API_KEY: 'sk-test-coverage' },
    }, async ({ port }) => {
      // POST forwards.
      const r1 = await probe(port, 'POST', '/v1/messages/batches', {});
      // Stub returns 200 (default Anthropic-shape body).
      assertEq(r1.status, 200, 'POST /v1/messages/batches forwarded (stub 200)');
      // DELETE method propagates — stub records method=DELETE.
      const r2 = await probe(port, 'DELETE', '/v1/messages/batches/abc', null);
      assertEq(r2.status, 200, 'DELETE /v1/messages/batches/abc forwarded');

      // Confirm stub saw both, with the DELETE method preserved.
      const seen = stub.requests.map(r => `${r.method} ${r.path}`);
      assert(seen.includes('POST /v1/messages/batches'),
        `stub saw POST batches (saw: ${seen.join(', ')})`);
      assert(seen.includes('DELETE /v1/messages/batches/abc'),
        `stub saw DELETE batches/abc (saw: ${seen.join(', ')})`);

      // Admin-style endpoint also forwards (no special-casing of admin keys).
      const r3 = await probe(port, 'GET', '/v1/organizations/me', null);
      assertEq(r3.status, 200, 'GET /v1/organizations/me forwarded');

      // OAuth bootstrap: not in ANTHROPIC_ONLY_PATHS at all — falls through
      // to the late /v1/* catch-all and forwards. Critical for Claude Code
      // subscription token refresh, which ships no inbound auth headers.
      const r4 = await probe(port, 'POST', '/v1/oauth/token', { grant_type: 'refresh_token' });
      assertEq(r4.status, 200, 'POST /v1/oauth/token forwarded (bootstrap path)');

      // Files content download: also excluded from ANTHROPIC_ONLY_PATHS;
      // routes through handleFilesApi → falls through to anthropic catch-all
      // for paths it doesn't translate (e.g. content download, no Gemini cfg).
      const r5 = await probe(port, 'GET', '/v1/files/file_xyz/content', null);
      assertEq(r5.status, 200, 'GET /v1/files/{id}/content forwarded');

      const seen2 = stub.requests.map(r => `${r.method} ${r.path}`);
      assert(seen2.includes('POST /v1/oauth/token'),
        `stub saw POST /v1/oauth/token (saw: ${seen2.join(', ')})`);
      assert(seen2.includes('GET /v1/files/file_xyz/content'),
        `stub saw GET /v1/files/file_xyz/content — confirms /v1/files/* fall-through reaches the anthropic catch-all rather than being intercepted by handleFilesApi or returning 503`);
    });
  } finally {
    try { if (stub) await stub.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// Minimal Gemini stub: accepts any POST under the Anthropic-shape /v1/messages
// path that the proxy translates from. We use call_style:"gemini" and point
// the URL at this stub. The stub returns a Gemini-shape generateContent
// response so forwardGemini can map it back to Anthropic.
function geminiStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({ method: req.method, path: req.url, body });
      // Streaming: proxy hits :streamGenerateContent?alt=sse — respond with
      // Gemini SSE chunks ("data: {...}\n\n") so the proxy's SSE parser can
      // produce a valid Anthropic stream and call writeHead with the gap
      // header before any bytes flow downstream.
      const isStream = /streamGenerateContent/.test(req.url) || /\balt=sse\b/.test(req.url);
      if (isStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        const chunk1 = {
          candidates: [{
            content: { role: 'model', parts: [{ text: 'ok' }] },
            index: 0,
          }],
        };
        const chunk2 = {
          candidates: [{
            content: { role: 'model', parts: [] },
            finishReason: 'STOP',
            index: 0,
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        };
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.end();
        return;
      }
      // Minimal generateContent response.
      const resp = {
        candidates: [{
          content: { role: 'model', parts: [{ text: 'ok' }] },
          finishReason: 'STOP',
          index: 0,
        }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resp));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, port: server.address().port, requests,
      close: () => new Promise(r => server.close(r)),
    }));
  });
}

async function runTranslationGapHeader() {
  console.log('\n--- Phase 3: x-c-thru-translation-gap header on Gemini ---');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-coverage-'));
  let gstub;
  try {
    gstub = await geminiStub();
    const config = {
      endpoints: {
        gemini_stub: {
          kind: 'gemini',
          format: 'gemini',
          call_style: 'gemini',
          url: `http://127.0.0.1:${gstub.port}`,
          auth: 'none',
        },
      },
      model_routes: {
        'gemini-test-model': 'gemini_stub',
      },
    };
    const configPath = writeConfig(tmpDir, config);
    await withProxy({ configPath }, async ({ port }) => {
      const reqBody = {
        model: 'gemini-test-model',
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello' },
              { type: 'redacted_thinking', data: 'opaque-blob' },
              // A made-up server-tool block to verify generic gap capture.
              { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} },
            ],
          },
        ],
      };
      const r = await httpJson(port, 'POST', '/v1/messages', reqBody, {}, 5000);
      assertEq(r.status, 200, 'POST /v1/messages → 200 via Gemini stub');
      const gap = r.headers['x-c-thru-translation-gap'];
      assert(typeof gap === 'string' && gap.length > 0,
        `x-c-thru-translation-gap header present (got ${JSON.stringify(gap)})`);
      const tokens = (gap || '').split(',');
      assert(tokens.includes('redacted_thinking'),
        `gap header includes redacted_thinking (got ${gap})`);
      assert(tokens.includes('server_tool_use'),
        `gap header includes server_tool_use (got ${gap})`);

      // Streaming variant: writeHead in the SSE branch (~claude-proxy L2837)
      // must use buildCthruResponseHeaders too, so x-c-thru-translation-gap
      // shows up on the streaming response headers (set before any SSE bytes
      // are flushed). Guards against the streaming and non-streaming paths
      // drifting — both share buildCthruResponseHeaders today.
      const streamReqBody = Object.assign({}, reqBody, { stream: true });
      const sr = await httpStream(port, 'POST', '/v1/messages', streamReqBody, {}, 5000);
      assertEq(sr.status, 200, 'POST /v1/messages stream:true → 200 via Gemini stub');
      const sgap = sr.headers['x-c-thru-translation-gap'];
      assert(typeof sgap === 'string' && sgap.length > 0,
        `streaming x-c-thru-translation-gap header present (got ${JSON.stringify(sgap)})`);
      const sTokens = (sgap || '').split(',');
      assert(sTokens.includes('redacted_thinking'),
        `streaming gap header includes redacted_thinking (got ${sgap})`);
      assert(sTokens.includes('server_tool_use'),
        `streaming gap header includes server_tool_use (got ${sgap})`);
      // SSE body completed cleanly — message_start opens the stream and
      // message_stop closes it. Confirms header logic didn't short-circuit
      // the stream.
      const evNames = sr.events.map(e => e.event);
      assert(evNames.includes('message_start'),
        `streaming response contains message_start (got events: ${evNames.join(',')})`);
      assert(evNames.includes('message_stop'),
        `streaming response contains message_stop (got events: ${evNames.join(',')})`);
    });
  } finally {
    try { if (gstub) await gstub.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function runPassthroughDenylist() {
  console.log('\n--- Phase 4: passthrough_denylist gates the catch-all forwarder ---');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-coverage-deny-'));
  let stub;
  try {
    stub = await stubBackend();
    const config = {
      endpoints: {
        anthropic: {
          kind: 'anthropic',
          url: `http://127.0.0.1:${stub.port}`,
          format: 'anthropic',
          auth_env: 'ANTHROPIC_API_KEY',
        },
      },
      passthrough_denylist: ['^/v1/admin/'],
    };
    const configPath = writeConfig(tmpDir, config);
    await withProxy({
      configPath,
      env: { ANTHROPIC_API_KEY: 'sk-test-coverage' },
    }, async ({ port }) => {
      const r = await probe(port, 'GET', '/v1/admin/foo', null);
      assertEq(r.status, 403, 'denylisted path returns 403');
      const errType = r.json && r.json.error && r.json.error.type;
      assertEq(errType, 'forbidden_error', 'error.type === forbidden_error');
      const stubSawAdmin = stub.requests.some(rq => rq.path === '/v1/admin/foo');
      assert(!stubSawAdmin, 'upstream stub never received the denied request');
    });
  } finally {
    try { if (stub) await stub.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  try {
    await runUnauthedGating();
    await runAuthedPassthrough();
    await runTranslationGapHeader();
    await runPassthroughDenylist();
  } catch (e) {
    console.error('test threw:', e && e.stack || e);
    process.exit(1);
  }
  process.exit(summary());
})();
