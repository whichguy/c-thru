#!/usr/bin/env node
'use strict';
// C32: a Gemini upstream that accepts the connection and sends response HEADERS
// then STALLS (never finishes the body) must NOT hang the client — the
// forwardGemini `up.on('timeout')` listener (armed by the request `timeout`
// option) must fire and destroy the socket, surfacing an error/fallback.
//
// Previously the Gemini timeout was a bare `timeout: 60000` literal with no env
// override, so this path could not be exercised hermetically (a 60s stall is
// impractical in a test). It is now GEMINI_UPSTREAM_TIMEOUT_MS =
// numberFromEnv('CLAUDE_PROXY_GEMINI_TIMEOUT_MS', 60000); this test pins it small.
//
// Run: node test/proxy-gemini-timeout.test.js

const fs   = require('fs');
const os   = require('os');
const http = require('http');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson,
} = require('./helpers');

console.log('proxy gemini upstream-timeout (C32) test\n');

// Gemini stub that HANGS after sending response headers: it writes 200 + headers
// then never ends the body, holding the socket open. The proxy's socket-inactivity
// timeout must fire and destroy it.
function geminiStallStub() {
  const requests = [];
  const openRes = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    // Send headers, then stall forever (no res.end()).
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"candidates":['); // partial body, then hang
    openRes.push(res);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        requests,
        close: () => new Promise(r => {
          for (const res of openRes) { try { res.destroy(); } catch {} }
          server.close(r);
        }),
      });
    });
    server.on('error', reject);
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-gemtimeout-'));
  try {
    console.log('1. Gemini hangs after headers → proxy timeout fires, client gets an error (not a hang)');
    const gem = await geminiStallStub();
    try {
      const config = {
        endpoints: {
          // No fallback_to and no routes.default → after the upstream timeout the
          // cascade self-noops and the proxy must return an error, not hang.
          geminiBackend: { format: 'gemini', url: `http://127.0.0.1:${gem.port}`, auth_env: 'GOOGLE_API_KEY' },
        },
        model_routes: { 'gemini-model': 'geminiBackend' },
        llm_profiles: { 'cap-gemini': { 'best-cloud': { '128gb': 'gemini-model' } } },
      };
      const configPath = writeConfig(tmpDir, config);

      await withProxy({
        configPath, profile: '128gb', mode: 'best-cloud',
        // Pin the Gemini upstream timeout small so the stall trips it fast.
        env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k', CLAUDE_PROXY_GEMINI_TIMEOUT_MS: '600' },
      }, async ({ port }) => {
        const started = Date.now();
        // Client timeout (6s) is far above the 600ms upstream timeout but far below
        // the 60s default — a hang would blow the client timeout; a working C32
        // listener returns an error in ~1s.
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'cap-gemini', stream: false,
          messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
        }, {}, 6000);
        const elapsed = Date.now() - started;

        assert(elapsed < 5000, `responded well under the client timeout (no hang) — ${elapsed}ms`);
        assert(elapsed >= 500, `did not return before the upstream timeout could fire — ${elapsed}ms`);
        assert(r.status >= 500 && r.status < 600, `upstream timeout surfaced as a 5xx error (got ${r.status})`);
        assert(gem.requests.length >= 1, 'gemini stall stub received the request');
      });
    } finally {
      await gem.close().catch(() => {});
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
