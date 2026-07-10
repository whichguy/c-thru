#!/usr/bin/env node
'use strict';
// F1 — forwardAnthropic() previously set NO timeout on the upstream request at
// all, so a backend that accepted the TCP connection but then went silent
// (never sending headers or a body) would hang the client request forever,
// with none of the fallback/cooldown machinery ever triggering.
//
// forwardAnthropic is the DEFAULT dispatch path for real Anthropic,
// OpenRouter, and (non-legacy) local Ollama /v1/messages passthrough — this
// mirrors test/proxy-gemini-timeout.test.js (the equivalent C32 regression
// test for forwardGemini) but targets a `format: "anthropic"` backend and the
// new CLAUDE_PROXY_ANTHROPIC_TIMEOUT_MS override.
//
// Run: node test/proxy-anthropic-timeout.test.js

const fs   = require('fs');
const os   = require('os');
const http = require('http');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson,
} = require('./helpers');

console.log('proxy anthropic upstream-timeout (F1) test\n');

// Anthropic-shape stub that accepts the connection and never responds at
// all (no headers, no body) — the worst case: no bytes ever come back.
function anthropicStallStub() {
  const requests = [];
  const openSockets = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    openSockets.push(res.socket);
    // Deliberately never call res.writeHead/res.end — simulate a fully wedged
    // backend that accepted the connection but never responds.
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        requests,
        close: () => new Promise(r => {
          for (const s of openSockets) { try { s.destroy(); } catch {} }
          server.close(r);
        }),
      });
    });
    server.on('error', reject);
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-anthtimeout-'));
  try {
    console.log('1. Anthropic-shape backend never responds → proxy timeout fires, client gets an error (not a hang)');
    const stub = await anthropicStallStub();
    try {
      const config = {
        endpoints: {
          // No fallback_to and no routes.default → after the upstream timeout
          // the cascade self-noops and the proxy must return an error, not hang.
          anthropicBackend: { format: 'anthropic', url: `http://127.0.0.1:${stub.port}`, auth_env: 'ANTHROPIC_API_KEY' },
        },
        model_routes: { 'anthropic-model': 'anthropicBackend' },
        llm_profiles: { 'cap-anthropic': { 'best-cloud': { '128gb': 'anthropic-model' } } },
      };
      const configPath = writeConfig(tmpDir, config);

      await withProxy({
        configPath, profile: '128gb', mode: 'best-cloud',
        // Pin the Anthropic upstream timeout small so the stall trips it fast.
        env: { CLAUDE_LLM_MODE: 'best-cloud', ANTHROPIC_API_KEY: 'k', CLAUDE_PROXY_ANTHROPIC_TIMEOUT_MS: '600' },
      }, async ({ port }) => {
        const started = Date.now();
        // Client timeout (6s) is far above the 600ms upstream timeout but far
        // below any hang scenario — a working fix returns an error in ~1s;
        // a regression (no timeout at all) would hang until the client gives up.
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'cap-anthropic', stream: false,
          messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
        }, {}, 6000);
        const elapsed = Date.now() - started;

        assert(elapsed < 5000, `responded well under the client timeout (no hang) — ${elapsed}ms`);
        assert(elapsed >= 500, `did not return before the upstream timeout could fire — ${elapsed}ms`);
        assert(r.status >= 500 && r.status < 600, `upstream timeout surfaced as a 5xx error (got ${r.status})`);
        assert(stub.requests.length >= 1, 'anthropic stall stub received the request');
      });
    } finally {
      await stub.close().catch(() => {});
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
