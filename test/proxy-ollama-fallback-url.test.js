#!/usr/bin/env node
'use strict';
// Test: the proxy's "model not in model_routes" Ollama fallback honors
// OLLAMA_URL — not only OLLAMA_BASE_URL.
//
// Regression for the half-shipped #2 fix. c-thru:49 exports the inbound
// OLLAMA_URL the caller set, but claude-proxy:87 read only OLLAMA_BASE_URL, so
// a caller who set ONLY OLLAMA_URL was invisible to the proxy's Ollama
// fallback (DEFAULT_OLLAMA_URL). The fix makes it
//   OLLAMA_URL || OLLAMA_BASE_URL || http://localhost:11434
// so this proves precedence + that the legacy OLLAMA_BASE_URL path still works.
//
// The proxy has no module.exports, so this is HTTP-level only: point the
// fallback at an in-process stub and assert the unknown-model request lands
// there. A model with NO model_routes entry takes the not-in-routes branch
// (claude-proxy:~1088) which dispatches to DEFAULT_OLLAMA_URL.
//
// Negative control: revert claude-proxy:87 to OLLAMA_BASE_URL-only and Case 1
// fails — with OLLAMA_BASE_URL unset the fallback resolves to localhost:11434
// instead of the stub, so the stub records zero requests.
//
// Run: node test/proxy-ollama-fallback-url.test.js

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, httpStream, ollamaStubBackend,
} = require('./helpers');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

console.log('proxy ollama-fallback URL precedence tests\n');

// stream:false → ollamaStubBackend emits a single JSON object (not ndjson),
// which forwardAnthropic passes through verbatim → client sees 200.
const HEALTHY_NDJSON = [
  { message: { content: 'fallback-served' } },
  { done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 },
];

// Not present in model_routes below → forces the not-in-routes Ollama-fallback
// branch rather than a configured backend.
const UNKNOWN_MODEL = 'definitely-not-a-routed-model-zzz';

// A minimal, valid config whose routes deliberately exclude UNKNOWN_MODEL.
function fallbackConfig() {
  return {
    backends: {
      // Never reached — present only so the config has a real route.
      placeholder_be: { kind: 'ollama', url: 'http://127.0.0.1:1' },
    },
    model_routes: { 'some-known-model': 'placeholder_be' },
  };
}

// Drives one unknown-model request through the proxy with the given env and
// returns how many requests the stub (standing in for the Ollama endpoint) saw.
async function probeFallback(tmpDir, envVars, stream = false) {
  const stub = await ollamaStubBackend(HEALTHY_NDJSON);
  const env = Object.assign({}, envVars, {
    OLLAMA_URL: envVars.OLLAMA_URL === '__STUB__' ? `http://127.0.0.1:${stub.port}` : envVars.OLLAMA_URL,
    OLLAMA_BASE_URL: envVars.OLLAMA_BASE_URL === '__STUB__' ? `http://127.0.0.1:${stub.port}` : envVars.OLLAMA_BASE_URL,
  });
  try {
    const configPath = writeConfig(tmpDir, fallbackConfig());
    let status = null;
    await withProxy({ configPath, profile: '128gb', mode: 'best-cloud', env }, async ({ port }) => {
      const body = { model: UNKNOWN_MODEL, stream, messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 };
      // The assertion is on the recorded stub hit (URL routing); the response is
      // ollama ndjson on the streaming path, passed through verbatim.
      const r = stream
        ? await httpStream(port, 'POST', '/v1/messages', body)
        : await httpJson(port, 'POST', '/v1/messages', body);
      status = r.status;
    });
    return { hits: stub.requests.length, status, firstPath: stub.requests[0] ? stub.requests[0].path : null };
  } finally {
    await stub.close().catch(() => {});
  }
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-ollama-fallback-'));
  try {
    // ── Case 1: OLLAMA_URL is honored when OLLAMA_BASE_URL is unset ───────────
    // OLLAMA_BASE_URL:'' scrubs any host-inherited value so the only signal is
    // OLLAMA_URL — exactly the caller scenario the #2 fix completes.
    console.log('1. Unknown-model fallback honors OLLAMA_URL (OLLAMA_BASE_URL unset)');
    {
      const { hits, status, firstPath } = await probeFallback(tmpDir, {
        OLLAMA_URL: '__STUB__', OLLAMA_BASE_URL: '',
      });
      assert(hits >= 1, `fallback hit the OLLAMA_URL stub (got ${hits} requests)`);
      assertEq(firstPath, '/v1/messages', 'forwarded to the /v1/messages adapter path');
      assertEq(status, 200, 'client saw a 200 round-trip through the stub');
    }

    // ── Case 2: back-compat — OLLAMA_BASE_URL alone still works ───────────────
    console.log('\n2. Unknown-model fallback still honors OLLAMA_BASE_URL alone (back-compat)');
    {
      const { hits, status } = await probeFallback(tmpDir, {
        OLLAMA_URL: '', OLLAMA_BASE_URL: '__STUB__',
      });
      assert(hits >= 1, `fallback hit the OLLAMA_BASE_URL stub (got ${hits} requests)`);
      assertEq(status, 200, 'client saw a 200 round-trip through the stub');
    }

    // ── Case 3: OLLAMA_URL wins over OLLAMA_BASE_URL when both are set ─────────
    // Proves precedence, not just presence: OLLAMA_BASE_URL points at a dead
    // port; if it were preferred the request would never reach the live stub.
    console.log('\n3. OLLAMA_URL takes precedence over OLLAMA_BASE_URL when both set');
    {
      const { hits, status } = await probeFallback(tmpDir, {
        OLLAMA_URL: '__STUB__', OLLAMA_BASE_URL: 'http://127.0.0.1:1',
      });
      assert(hits >= 1, `fallback used OLLAMA_URL (the live stub) over the dead OLLAMA_BASE_URL (got ${hits})`);
      assertEq(status, 200, 'client saw a 200 round-trip through the OLLAMA_URL stub');
    }

    // ── Case 4: the streaming path (stream:true) also routes via OLLAMA_URL ────
    // forwardAnthropic relays the request to <OLLAMA_URL>/v1/messages regardless
    // of stream; this proves URL routing holds on the SSE-passthrough path, not
    // just stream:false.
    console.log('\n4. Unknown-model fallback honors OLLAMA_URL on the streaming path too');
    {
      const { hits, firstPath } = await probeFallback(tmpDir, {
        OLLAMA_URL: '__STUB__', OLLAMA_BASE_URL: '',
      }, true);
      assert(hits >= 1, `streaming fallback hit the OLLAMA_URL stub (got ${hits} requests)`);
      assertEq(firstPath, '/v1/messages', 'streaming forwarded to the /v1/messages adapter path');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
