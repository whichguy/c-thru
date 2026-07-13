#!/usr/bin/env node
'use strict';
// Runtime upstream-fallback tests for forwardAnthropic.
// Verifies that when a primary anthropic-kind backend fails (connection error,
// 401/404/429/5xx), the proxy transparently retries through the configured
// fallback target before surfacing the failure to the client.
//
// Run: node test/proxy-runtime-fallback.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, httpStream,
  stubBackend, ollamaStubBackend, streamingStubBackend,
} = require('./helpers');

console.log('proxy runtime upstream fallback tests\n');

// Build a config where the primary "cloud" backend has a fallback to
// "stub_ollama". If the cloud backend fails, the proxy should re-route
// through the ollama stub (which always succeeds with our test fixture).
function buildConfig(cloudPort, ollamaPort, opts = {}) {
  const cfg = {
    backends: {
      cloud: {
        kind: 'anthropic',
        url: `http://127.0.0.1:${cloudPort}`,
        ...(opts.fallback_to !== undefined ? { fallback_to: opts.fallback_to } : {}),
      },
      stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${ollamaPort}`, legacy_ollama_chat: true },
    },
    model_routes: {
      'fallback-test-model': 'cloud',
      'local-fallback-target': 'stub_ollama',
    },
    llm_profiles: {
      '128gb': {
        workhorse: { connected_model: 'fallback-test-model', disconnect_model: 'fallback-test-model' },
      },
    },
  };
  return cfg;
}

const HEALTHY_OLLAMA_NDJSON = [
  { message: { content: 'fallback-served' } },
  { done: true, done_reason: 'stop', prompt_eval_count: 2, eval_count: 1 },
];

// Minimal-but-coherent Anthropic SSE the fallback streaming backend serves.
// The text delta carries a sentinel so the client can prove the bytes came
// from the FALLBACK, not the failed primary.
const FALLBACK_STREAM = [
  { event: 'message_start', data: {
      type: 'message_start',
      message: {
        id: 'msg_fb_stream', type: 'message', role: 'assistant',
        content: [], model: 'fallback-stream-model', stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
  }},
  { event: 'content_block_start', data: {
      type: 'content_block_start', index: 0,
      content_block: { type: 'text', text: '' },
  }},
  { event: 'content_block_delta', data: {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'stream-fallback-served' },
  }},
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 }},
  { event: 'message_delta', data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
  }},
  { event: 'message_stop', data: { type: 'message_stop' } },
];

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-fallback-'));

  try {
    // ── Test 1: 401 on cloud → fallback to local fires ──────────────────────
    console.log('1. cloud returns 401 → fallback to local-fallback-target fires');
    {
      const cloud = await stubBackend({ failWith: 401 });
      const ollama = await ollamaStubBackend(HEALTHY_OLLAMA_NDJSON);
      try {
        const cfg = buildConfig(cloud.port, ollama.port, { fallback_to: 'local-fallback-target' });
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'fallback-test-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r.status, 200, 'final status 200 (fallback succeeded)');
          assert(r.json.content && r.json.content.some(b => b.text === 'fallback-served'),
            `response came from ollama fallback (got: ${JSON.stringify(r.json.content)})`);
          assertEq(cloud.requests.length, 1, 'cloud was tried once');
          assertEq(ollama.requests.length, 1, 'ollama fallback was hit once');
        });
      } finally {
        await cloud.close().catch(() => {});
        await ollama.close().catch(() => {});
      }
    }

    // ── Test 2: 500 on cloud → fallback fires ───────────────────────────────
    console.log('\n2. cloud returns 500 → fallback fires');
    {
      const cloud = await stubBackend({ failWith: 500 });
      const ollama = await ollamaStubBackend(HEALTHY_OLLAMA_NDJSON);
      try {
        const cfg = buildConfig(cloud.port, ollama.port, { fallback_to: 'local-fallback-target' });
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'fallback-test-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r.status, 200, '5xx triggers fallback, final status 200');
        });
      } finally {
        await cloud.close().catch(() => {});
        await ollama.close().catch(() => {});
      }
    }

    // ── Test 3: 400 on cloud → fallback does NOT fire (caller's bug) ────────
    console.log('\n3. cloud returns 400 → fallback does NOT fire (request is malformed)');
    {
      const cloud = await stubBackend({ failWith: 400 });
      const ollama = await ollamaStubBackend(HEALTHY_OLLAMA_NDJSON);
      try {
        const cfg = buildConfig(cloud.port, ollama.port, { fallback_to: 'local-fallback-target' });
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'fallback-test-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r.status, 400, '400 surfaced to client unchanged');
          assertEq(cloud.requests.length, 1, 'cloud was tried');
          assertEq(ollama.requests.length, 0, 'ollama was NOT hit (no retry on caller-fault)');
        });
      } finally {
        await cloud.close().catch(() => {});
        await ollama.close().catch(() => {});
      }
    }

    // ── Test 4: no fallback_to configured → error surfaces normally ─────────
    console.log('\n4. no fallback_to configured → upstream error surfaces to client');
    {
      const cloud = await stubBackend({ failWith: 401 });
      const ollama = await ollamaStubBackend(HEALTHY_OLLAMA_NDJSON);
      try {
        const cfg = buildConfig(cloud.port, ollama.port);  // no fallback_to
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'fallback-test-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r.status, 401, '401 surfaced to client unchanged');
          assertEq(ollama.requests.length, 0, 'ollama was NOT hit (no fallback configured)');
        });
      } finally {
        await cloud.close().catch(() => {});
        await ollama.close().catch(() => {});
      }
    }

    // ── Test 5: cloud connection refused → fallback fires ───────────────────
    console.log('\n5. cloud unreachable (port closed) → connection-error fallback fires');
    {
      // Open a port, close it immediately to get a guaranteed-refused address.
      const sham = await stubBackend({});
      const closedPort = sham.port;
      await sham.close();
      const ollama = await ollamaStubBackend(HEALTHY_OLLAMA_NDJSON);
      try {
        const cfg = buildConfig(closedPort, ollama.port, { fallback_to: 'local-fallback-target' });
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'fallback-test-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r.status, 200, 'connection-error triggers fallback, final status 200');
          assertEq(ollama.requests.length, 1, 'ollama fallback was hit');
        });
      } finally { await ollama.close().catch(() => {}); }
    }

    // ── Test 7: Ollama backend non-200 → fallback to a healthy ollama ──────
    console.log('\n7. Ollama backend returns 404 (model not found) → fallback fires');
    {
      // Primary "ollama" backend is a stub that returns 404 like Ollama would
      // for a model it can't load (e.g., :cloud model without a subscription).
      const ollamaPrimary = await stubBackend({ failWith: 404 });
      const ollamaHealthy = await ollamaStubBackend(HEALTHY_OLLAMA_NDJSON);
      try {
        const cfg = {
          backends: {
            primary_ollama: {
              kind: 'ollama',
              url: `http://127.0.0.1:${ollamaPrimary.port}`,
              fallback_to: 'fallback-target',
              legacy_ollama_chat: true,
            },
            healthy_ollama: { kind: 'ollama', url: `http://127.0.0.1:${ollamaHealthy.port}`, legacy_ollama_chat: true },
          },
          model_routes: { 'primary-model': 'primary_ollama', 'fallback-target': 'healthy_ollama' },
          llm_profiles: {
            '128gb': { workhorse: { connected_model: 'primary-model', disconnect_model: 'primary-model' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'primary-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r.status, 200, 'Ollama 404 → fallback succeeded with 200');
          assert(r.json.content && r.json.content.some(b => b.text === 'fallback-served'),
            `response served by healthy fallback (got: ${JSON.stringify(r.json.content)})`);
          assertEq(ollamaPrimary.requests.length, 1, 'primary tried once');
          assertEq(ollamaHealthy.requests.length, 1, 'healthy fallback hit once');
        });
      } finally {
        await ollamaPrimary.close().catch(() => {});
        await ollamaHealthy.close().catch(() => {});
      }
    }

    // ── Test 8: Ollama TTFT timeout (hung upstream) → fallback fires ────────
    console.log('\n8. Ollama hangs on headers (TTFT timeout) → fallback to healthy backend');
    {
      // Bare http server that accepts the connection but never responds —
      // simulates a wedged Ollama daemon.
      const http = require('http');
      const hangSrv = await new Promise((resolve, reject) => {
        const s = http.createServer(req => { req.on('data', () => {}); req.on('end', () => {}); });
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => resolve(s));
      });
      const ollamaHealthy = await ollamaStubBackend(HEALTHY_OLLAMA_NDJSON);
      try {
        const cfg = {
          backends: {
            hung_ollama: {
              kind: 'ollama',
              url: `http://127.0.0.1:${hangSrv.address().port}`,
              fallback_to: 'fallback-target',
              legacy_ollama_chat: true,
            },
            healthy_ollama: { kind: 'ollama', url: `http://127.0.0.1:${ollamaHealthy.port}`, legacy_ollama_chat: true },
          },
          model_routes: { 'primary-model': 'hung_ollama', 'fallback-target': 'healthy_ollama' },
          llm_profiles: {
            '128gb': { workhorse: { connected_model: 'primary-model', disconnect_model: 'primary-model' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        // Tighten TTFT for the test so it fires in 1s instead of the 11s default.
        await withProxy({
          configPath, profile: '128gb', mode: 'connected',
          env: { CLAUDE_PROXY_OLLAMA_TTFT_MS: '1000' },
        }, async ({ port }) => {
          const t0 = Date.now();
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'primary-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          }, {}, 10000);
          const elapsed = Date.now() - t0;
          assertEq(r.status, 200, 'TTFT-timed-out request still returned 200 via fallback');
          assert(elapsed < 5000, `fast fallback (elapsed ${elapsed}ms < 5000ms — TTFT(1s) + dispatch)`);
          assertEq(ollamaHealthy.requests.length, 1, 'healthy fallback hit once');
        });
      } finally {
        await new Promise(r => hangSrv.close(r));
        await ollamaHealthy.close().catch(() => {});
      }
    }

    // ── Test 9: 2-hop fallback chain — primary fails, secondary fails, tertiary serves ─
    console.log('\n9. 2-hop chain: primary→secondary→tertiary; first two fail, tertiary serves');
    {
      const primary = await stubBackend({ failWith: 500 });
      const secondary = await stubBackend({ failWith: 500 });
      const tertiary = await ollamaStubBackend(HEALTHY_OLLAMA_NDJSON);
      try {
        const cfg = {
          backends: {
            primary_be:   { kind: 'anthropic', url: `http://127.0.0.1:${primary.port}`,   fallback_to: 'secondary-target' },
            secondary_be: { kind: 'anthropic', url: `http://127.0.0.1:${secondary.port}`, fallback_to: 'tertiary-target' },
            tertiary_be:  { kind: 'ollama',    url: `http://127.0.0.1:${tertiary.port}`, legacy_ollama_chat: true },
          },
          model_routes: {
            'primary-model':     'primary_be',
            'secondary-target':  'secondary_be',
            'tertiary-target':   'tertiary_be',
          },
          llm_profiles: {
            '128gb': { workhorse: { connected_model: 'primary-model', disconnect_model: 'primary-model' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'primary-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r.status, 200, 'chain succeeded — got 200');
          assert(r.json.content && r.json.content.some(b => b.text === 'fallback-served'),
            `served by tertiary (got: ${JSON.stringify(r.json.content)})`);
          assertEq(primary.requests.length,   1, 'primary tried once');
          assertEq(secondary.requests.length, 1, 'secondary tried once (after primary fail)');
          assertEq(tertiary.requests.length,  1, 'tertiary served (after secondary fail)');
        });
      } finally {
        await primary.close().catch(() => {});
        await secondary.close().catch(() => {});
        await tertiary.close().catch(() => {});
      }
    }

    // ── Test 10: cooldown skip — second request transparently bypasses recently-failed intermediate ─
    console.log('\n10. cooldown: 2nd request skips a recently-failed intermediate node');
    {
      // Chain A→B→C. B will fail on FIRST request; cooldown marks B.
      // Second request should walk A→(B-skipped)→C without hitting B at all.
      const A = await stubBackend({ failWith: 500 });
      const B = await stubBackend({ failWith: 500 });
      const C = await ollamaStubBackend(HEALTHY_OLLAMA_NDJSON);
      try {
        const cfg = {
          backends: {
            A_be: { kind: 'anthropic', url: `http://127.0.0.1:${A.port}`, fallback_to: 'B-target' },
            B_be: { kind: 'anthropic', url: `http://127.0.0.1:${B.port}`, fallback_to: 'C-target' },
            C_be: { kind: 'ollama', url: `http://127.0.0.1:${C.port}`, legacy_ollama_chat: true },
          },
          model_routes: { 'A-model': 'A_be', 'B-target': 'B_be', 'C-target': 'C_be' },
          llm_profiles: { '128gb': { workhorse: { connected_model: 'A-model', disconnect_model: 'A-model' } } },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          // First request: walks A → B (fails, cooldown marked) → C (serves)
          const r1 = await httpJson(port, 'POST', '/v1/messages', {
            model: 'A-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r1.status, 200, 'first request: chain works (200)');
          assertEq(A.requests.length, 1, 'first req: A tried 1x');
          assertEq(B.requests.length, 1, 'first req: B tried 1x');
          assertEq(C.requests.length, 1, 'first req: C served 1x');

          // Second request: BOTH A and B failed (500) on req1, so BOTH are in
          // cooldown (transient + have fallback_to). The proxy cooldown-skips A on
          // the main path (jumps straight to the cascade) and skips B in the walk,
          // descending to C. So A is NOT re-dispatched.
          // Counts after: A=1 (cooldown-skipped), B=1 (skipped), C=2.
          const r2 = await httpJson(port, 'POST', '/v1/messages', {
            model: 'A-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r2.status, 200, 'second request: chain still serves (200)');
          assertEq(A.requests.length, 1, 'second req: A cooldown-skipped (also 500 w/ fallback → marked), not re-dispatched');
          assertEq(B.requests.length, 1, 'second req: B SKIPPED via cooldown (still 1, not 2)');
          assertEq(C.requests.length, 2, 'second req: C served 1x more');
        });
      } finally {
        await A.close().catch(() => {});
        await B.close().catch(() => {});
        await C.close().catch(() => {});
      }
    }

    // ── Test 10b: permanent failure (401 auth) does NOT enter cooldown ─────
    console.log('\n10b. cooldown: permanent failure (401) does NOT cooldown — same backend re-tried');
    {
      // Chain A→B→C. A returns 401 (permanent — auth-class). On the first
      // request, A fails → fallback through B → fallback to C (serves).
      // CRITICAL: even though A has fallback_to, A must NOT be cooldowned on
      // a 401 (cooldown would just delay the same auth error on next request
      // until the user fixes config). On the second request, A must be hit
      // again — because re-trying gives the user a fast deterministic signal
      // and because there's no point skipping a backend whose error is
      // configuration-locked.
      const A = await stubBackend({ failWith: 401 });
      const B = await stubBackend({ failWith: 500 });   // transient — gets cooldowned normally
      const C = await ollamaStubBackend(HEALTHY_OLLAMA_NDJSON);
      try {
        const cfg = {
          backends: {
            A_be: { kind: 'anthropic', url: `http://127.0.0.1:${A.port}`, fallback_to: 'B-target' },
            B_be: { kind: 'anthropic', url: `http://127.0.0.1:${B.port}`, fallback_to: 'C-target' },
            C_be: { kind: 'ollama', url: `http://127.0.0.1:${C.port}`, legacy_ollama_chat: true },
          },
          model_routes: { 'A-model': 'A_be', 'B-target': 'B_be', 'C-target': 'C_be' },
          llm_profiles: { '128gb': { workhorse: { connected_model: 'A-model', disconnect_model: 'A-model' } } },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          // First request: A (401 perm) → B (500 trans) → C (serves).
          const r1 = await httpJson(port, 'POST', '/v1/messages', {
            model: 'A-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r1.status, 200, 'first request: chain works (200) via C');
          assertEq(A.requests.length, 1, 'first req: A tried 1x');
          assertEq(B.requests.length, 1, 'first req: B tried 1x');
          assertEq(C.requests.length, 1, 'first req: C served 1x');

          // Second request. EXPECTED behavior (the change being tested):
          //   - A is RE-TRIED (permanent 401 ⇒ NOT cooldowned). A.requests=2.
          //   - B is SKIPPED (transient 500 ⇒ cooldowned). B.requests=1 (unchanged).
          //   - C serves. C.requests=2.
          const r2 = await httpJson(port, 'POST', '/v1/messages', {
            model: 'A-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r2.status, 200, 'second request: chain still serves (200)');
          assertEq(A.requests.length, 2, 'second req: A RE-TRIED (401 permanent — no cooldown)');
          assertEq(B.requests.length, 1, 'second req: B skipped (500 transient — cooldowned)');
          assertEq(C.requests.length, 2, 'second req: C served 1x more');
        });
      } finally {
        await A.close().catch(() => {});
        await B.close().catch(() => {});
        await C.close().catch(() => {});
      }
    }

    // ── Test 11: terminal exemption — terminal in chain never enters cooldown ─
    console.log('\n11. terminal node never cooldowns even when it just failed');
    {
      // A→B (terminal, no fallback_to). A fails, B fails. Terminal B must
      // be retried on subsequent requests despite failing — otherwise we'd
      // be stuck with no targets to serve.
      const A = await stubBackend({ failWith: 500 });
      const B = await stubBackend({ failWith: 500 });
      try {
        const cfg = {
          backends: {
            A_be: { kind: 'anthropic', url: `http://127.0.0.1:${A.port}`, fallback_to: 'B-target' },
            B_be: { kind: 'anthropic', url: `http://127.0.0.1:${B.port}` },  // no fallback_to
          },
          model_routes: { 'A-model': 'A_be', 'B-target': 'B_be' },
          llm_profiles: { '128gb': { workhorse: { connected_model: 'A-model', disconnect_model: 'A-model' } } },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          // First request: A fails → B fails → no more targets, original error surfaces.
          await httpJson(port, 'POST', '/v1/messages', {
            model: 'A-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(B.requests.length, 1, 'first req: B (terminal) hit 1x');

          // Second request: even though B just failed, since it's terminal it
          // MUST be retried. If we cooldowned B, the second req would have
          // nowhere to route and would fail without ever trying B.
          await httpJson(port, 'POST', '/v1/messages', {
            model: 'A-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(B.requests.length, 2, 'second req: B (terminal) RETRIED despite recent failure');
        });
      } finally {
        await A.close().catch(() => {});
        await B.close().catch(() => {});
      }
    }

    // ── Test 12: global default — request with NO fallback_to still gets retry ─
    console.log('\n12. routes.default catches requests with no per-backend fallback chain');
    {
      // Primary has no fallback_to. routes.default points at a healthy backend.
      // Verifies the tier-3 global-default last-resort fires when tier-1
      // (per-backend) chain is empty.
      const primary = await stubBackend({ failWith: 500 });
      const defaultBackend = await ollamaStubBackend(HEALTHY_OLLAMA_NDJSON);
      try {
        const cfg = {
          backends: {
            primary_be: { kind: 'anthropic', url: `http://127.0.0.1:${primary.port}` },  // no fallback_to
            default_be: { kind: 'ollama', url: `http://127.0.0.1:${defaultBackend.port}`, legacy_ollama_chat: true },
          },
          routes: { default: 'default-target' },
          model_routes: { 'primary-model': 'primary_be', 'default-target': 'default_be' },
          llm_profiles: { '128gb': { workhorse: { connected_model: 'primary-model', disconnect_model: 'primary-model' } } },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'primary-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r.status, 200, 'global-default fired, served via routes.default backend');
          assertEq(primary.requests.length, 1, 'primary tried');
          assertEq(defaultBackend.requests.length, 1, 'global default served');
          assert(r.json.content && r.json.content.some(b => b.text === 'fallback-served'),
            `served by default backend (got: ${JSON.stringify(r.json.content)})`);
        });
      } finally {
        await primary.close().catch(() => {});
        await defaultBackend.close().catch(() => {});
      }
    }

    // ── Test 13: /c-thru/status surfaces cooldown_backends + default_route ──
    console.log('\n13. /c-thru/status reports cooldown state and default_route');
    {
      const A = await stubBackend({ failWith: 500 });
      const C = await ollamaStubBackend(HEALTHY_OLLAMA_NDJSON);
      try {
        const cfg = {
          backends: {
            A_be: { kind: 'anthropic', url: `http://127.0.0.1:${A.port}`, fallback_to: 'C-target' },
            C_be: { kind: 'ollama', url: `http://127.0.0.1:${C.port}`, legacy_ollama_chat: true },
          },
          routes: { default: 'C-target' },
          model_routes: { 'A-model': 'A_be', 'C-target': 'C_be' },
          llm_profiles: { '128gb': { workhorse: { connected_model: 'A-model', disconnect_model: 'A-model' } } },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          // Trigger A's failure so it enters cooldown
          await httpJson(port, 'POST', '/v1/messages', {
            model: 'A-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          // Now check /c-thru/status
          const status = await httpJson(port, 'GET', '/c-thru/status', null);
          assertEq(status.status, 200, 'status endpoint OK');
          assertEq(status.json.default_route, 'C-target', 'default_route surfaced');
          assert(Array.isArray(status.json.cooldown_backends), 'cooldown_backends is an array');
          const aCooldown = status.json.cooldown_backends.find(c => c.backend === 'A_be');
          assert(aCooldown, `A_be in cooldown list (got: ${JSON.stringify(status.json.cooldown_backends)})`);
          assert(aCooldown.expires_in_ms > 0 && aCooldown.expires_in_ms <= 60000,
            `cooldown expires within 60s (got ${aCooldown.expires_in_ms}ms)`);
        });
      } finally {
        await A.close().catch(() => {});
        await C.close().catch(() => {});
      }
    }

    // ── Test 6: fallback_to with self-loop is broken by cycle detection ─────
    // resolveBackend has an `_seen` Set that detects cycles in route chains.
    // Construct: model_routes points at a "cloud" backend that fallback_to's
    // back to itself ("fallback-test-model"). The resolver must NOT loop.
    console.log('\n6. fallback_to creates a routing cycle → cycle detector breaks it');
    {
      const cloud = await stubBackend({ failWith: 500 });
      const ollama = await ollamaStubBackend(HEALTHY_OLLAMA_NDJSON);
      try {
        // fallback_to points BACK at the same model — would loop forever
        // without cycle detection. The dispatched request runs once through
        // cloud (500), the fallback resolver visits the same model, the
        // cycle guard fires, and the original error surfaces.
        const cfg = buildConfig(cloud.port, ollama.port, { fallback_to: 'fallback-test-model' });
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'fallback-test-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          // The cycle should be broken: original 500 surfaces, no infinite loop.
          // Cloud should be hit at most twice (once original, once via fallback)
          // before cycle detection bails. Critically: ollama is NEVER hit.
          assertEq(r.status, 500, 'original 500 surfaces after cycle detected');
          assert(cloud.requests.length >= 1 && cloud.requests.length <= 2,
            `cloud hit at most twice (got ${cloud.requests.length})`);
          assertEq(ollama.requests.length, 0, 'ollama never hit (fallback cycled, did not reach a different backend)');
        });
      } finally {
        await cloud.close().catch(() => {});
        await ollama.close().catch(() => {});
      }
    }

    // ── Test 14: Ollama :cloud-suffixed model auth-fail → cloud→local rewrite fires ─
    console.log('\n14. Ollama :cloud model returns 401 → cloud→local rewrite retries against same backend');
    {
      // Custom upstream that mimics Ollama's behaviour for :cloud models
      // without a subscription: returns 401 if body.model ends in :cloud,
      // otherwise serves a normal Ollama ndjson response. Verifies that
      // OLLAMA_CLOUD_LOCAL_FALLBACK_MODEL transparently swaps the model name
      // and retries against the same backend (no per-model fallback_to wired).
      const http = require('http');
      const requests = [];
      const upstream = await new Promise((resolve, reject) => {
        const s = http.createServer((req, res) => {
          const chunks = [];
          req.on('data', c => chunks.push(c));
          req.on('end', () => {
            let body = null;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
            requests.push({ method: req.method, path: req.url, model_used: body?.model || null });
            if (typeof body?.model === 'string' && body.model.endsWith(':cloud')) {
              const errBody = JSON.stringify({ error: 'unauthorized: subscription required for :cloud models' });
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(errBody);
              return;
            }
            // Healthy non-stream Ollama response for the local fallback model.
            const respObj = {
              model: body?.model || 'unknown',
              created_at: new Date().toISOString(),
              message: { role: 'assistant', content: 'served-by-local-fallback' },
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 2,
              eval_count: 1,
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(respObj));
          });
        });
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => resolve(s));
      });
      try {
        const cfg = {
          backends: {
            ollama_local: { kind: 'ollama', url: `http://127.0.0.1:${upstream.address().port}`, legacy_ollama_chat: true },
          },
          model_routes: {
            'deepseek-v4-flash:cloud': 'ollama_local',
          },
          llm_profiles: {
            '128gb': {
              workhorse: { connected_model: 'deepseek-v4-flash:cloud', disconnect_model: 'deepseek-v4-flash:cloud' },
            },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({
          configPath, profile: '128gb', mode: 'connected',
          env: { OLLAMA_CLOUD_LOCAL_FALLBACK_MODEL: 'local-fallback-model' },
        }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'deepseek-v4-flash:cloud', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r.status, 200, ':cloud auth-fail → cloud→local rewrite succeeded with 200');
          assert(r.json.content && r.json.content.some(b => b.text === 'served-by-local-fallback'),
            `response served by local fallback model (got: ${JSON.stringify(r.json.content)})`);
          assertEq(requests.length, 2, 'upstream hit twice: once with :cloud (401), once with local fallback (200)');
          assertEq(requests[0].model_used, 'deepseek-v4-flash:cloud', 'first request used :cloud model');
          assertEq(requests[1].model_used, 'local-fallback-model', 'second request used OLLAMA_CLOUD_LOCAL_FALLBACK_MODEL');
        });
      } finally {
        await new Promise(r => upstream.close(r));
      }
    }

    // ── Test 15: cloud-fallback only fires once — no infinite loop ─────────
    console.log('\n15. cloud-fallback fires at most once per request (no loop on persistent failure)');
    {
      // Upstream returns 401 for ALL requests regardless of model. Even after
      // the cloud→local rewrite, the local-fallback-model itself fails. The
      // _cloudFallbackTried flag must prevent a second cloud-rewrite attempt;
      // the request should fall through to tryFallbackOrFail (no fallback_to
      // configured) → original error surfaced.
      const http = require('http');
      const requests = [];
      const upstream = await new Promise((resolve, reject) => {
        const s = http.createServer((req, res) => {
          const chunks = [];
          req.on('data', c => chunks.push(c));
          req.on('end', () => {
            let body = null;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
            requests.push({ model_used: body?.model || null });
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
          });
        });
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => resolve(s));
      });
      try {
        const cfg = {
          backends: {
            ollama_local: { kind: 'ollama', url: `http://127.0.0.1:${upstream.address().port}`, legacy_ollama_chat: true },
          },
          model_routes: { 'glm-5.1:cloud': 'ollama_local' },
          llm_profiles: {
            '128gb': { workhorse: { connected_model: 'glm-5.1:cloud', disconnect_model: 'glm-5.1:cloud' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({
          configPath, profile: '128gb', mode: 'connected',
          env: { OLLAMA_CLOUD_LOCAL_FALLBACK_MODEL: 'local-fallback-model' },
        }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'glm-5.1:cloud', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r.status, 401, 'persistent failure surfaces original 401 (no infinite loop)');
          assertEq(requests.length, 2, 'upstream hit exactly twice (once with :cloud, once with rewritten — no third attempt)');
          assertEq(requests[0].model_used, 'glm-5.1:cloud', 'first attempt used :cloud model');
          assertEq(requests[1].model_used, 'local-fallback-model', 'second attempt used local fallback (cloud-rewrite fired once)');
        });
      } finally {
        await new Promise(r => upstream.close(r));
      }
    }

    // ── Test 12: gemini-pro → sonnet fallback (commit d9bc6d3) ──────────────
    // The shipped config (config/model-map.json:24) sets
    //   endpoints.gemini_ai.fallback_to = "claude-sonnet-5"
    // so when the gemini endpoint fails (5xx, auth, quota), the proxy walks
    // the backend chain to anthropic and the client gets a Sonnet response
    // instead of the upstream error. Verify end-to-end with two stubs.
    console.log('\n12. gemini_ai 5xx → falls back to anthropic Sonnet');
    {
      const gemini = await stubBackend({ failWith: 503 });
      const anthropic = await stubBackend({
        responseBody: {
          id: 'msg_sonnet_fb',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'sonnet-fallback-served' }],
          model: 'claude-sonnet-5',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      try {
        const cfg = {
          endpoints: {
            gemini_ai: {
              format: 'gemini',
              url: `http://127.0.0.1:${gemini.port}`,
              auth: 'none',
              fallback_to: 'claude-sonnet-5',
            },
            anthropic: {
              kind: 'anthropic',
              url: `http://127.0.0.1:${anthropic.port}`,
            },
          },
          model_routes: {
            'gemini-pro':         { endpoint: 'gemini_ai', name: 'gemini-pro-latest' },
            'claude-sonnet-5':  'anthropic',
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'gemini-pro', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r.status, 200, '12 gemini 5xx → proxy returned 200 after fallback');
          const text = (r.json?.content || []).map(b => b.text).join('');
          assert(text.includes('sonnet-fallback-served'),
            `12 response came from anthropic stub, not gemini (got: ${text})`);
          assertEq(gemini.requests.length, 1, '12 gemini was tried once');
          assertEq(anthropic.requests.length, 1, '12 anthropic fallback hit once');
          // Resolution chain header surfaces the fallback hop for observability.
          assert((r.headers?.['x-c-thru-fallback-from'] || '').includes('gemini') ||
                 (r.headers?.['x-c-thru-resolution-chain'] || '').includes('gemini'),
            `12 fallback hop visible in response headers (chain: '${r.headers?.['x-c-thru-resolution-chain']}', fallback-from: '${r.headers?.['x-c-thru-fallback-from']}')`);
        });
      } finally {
        await gemini.close().catch(() => {});
        await anthropic.close().catch(() => {});
      }
    }

    // ── Test 12b: gemini connection refused → falls back to Sonnet ──────────
    // Network errors (ECONNREFUSED) classify the same as 5xx for fallback
    // purposes. Verifies the same chain works when gemini_ai is entirely
    // unreachable, not just returning errors.
    console.log('\n12b. gemini_ai unreachable → falls back to Sonnet');
    {
      const anthropic = await stubBackend({
        responseBody: {
          id: 'msg_sonnet_fb2',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'sonnet-after-net-error' }],
          model: 'claude-sonnet-5',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      try {
        // Pick a port that won't accept connections (1 is privileged + bind-disallowed).
        const cfg = {
          endpoints: {
            gemini_ai: {
              format: 'gemini',
              url: 'http://127.0.0.1:1',
              auth: 'none',
              fallback_to: 'claude-sonnet-5',
            },
            anthropic: {
              kind: 'anthropic',
              url: `http://127.0.0.1:${anthropic.port}`,
            },
          },
          model_routes: {
            'gemini-pro':         { endpoint: 'gemini_ai', name: 'gemini-pro-latest' },
            'claude-sonnet-5':  'anthropic',
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'gemini-pro', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          }, {}, 10000);
          assertEq(r.status, 200, '12b connection error → fallback succeeded with 200');
          const text = (r.json?.content || []).map(b => b.text).join('');
          assert(text.includes('sonnet-after-net-error'),
            `12b response from anthropic after network error (got: ${text})`);
          assertEq(anthropic.requests.length, 1, '12b anthropic fallback hit once');
        });
      } finally {
        await anthropic.close().catch(() => {});
      }
    }

    // ── Test C9: gemini 503 with NO fallback_to but a routes.default ────────
    // Regression for the `if (backend.fallback_to)` gate in forwardGemini's
    // non-2xx handler. routes.default / local-terminal / capability chains do
    // NOT require the failing backend to declare fallback_to — gating on it
    // meant a Gemini backend without fallback_to relayed the raw 503 instead of
    // cascading. After the fix the cascade always runs (self-noops if nothing
    // applies), so routes.default catches it.
    console.log('\nC9. gemini 503 (no fallback_to) + routes.default → cascades to default backend');
    {
      const gemini = await stubBackend({ failWith: 503 });
      const fallback = await stubBackend({
        responseBody: {
          id: 'msg_default_fb',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'served-by-routes-default' }],
          model: 'claude-sonnet-5',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      try {
        const cfg = {
          endpoints: {
            // NOTE: deliberately NO fallback_to on the gemini endpoint.
            gemini_ai: {
              format: 'gemini',
              url: `http://127.0.0.1:${gemini.port}`,
              auth: 'none',
            },
            anthropic: {
              kind: 'anthropic',
              url: `http://127.0.0.1:${fallback.port}`,
            },
          },
          model_routes: {
            'gemini-pro':        { endpoint: 'gemini_ai', name: 'gemini-pro-latest' },
            'claude-sonnet-5': 'anthropic',
          },
          routes: { default: 'claude-sonnet-5' },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'gemini-pro', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r.status, 200, 'C9 gemini 503 (no fallback_to) → 200 via routes.default');
          const text = (r.json?.content || []).map(b => b.text).join('');
          assert(text.includes('served-by-routes-default'),
            `C9 served by routes.default backend, not raw gemini error (got: ${text})`);
          assertEq(gemini.requests.length, 1, 'C9 gemini tried once');
          assertEq(fallback.requests.length, 1, 'C9 routes.default backend served once');
        });
      } finally {
        await gemini.close().catch(() => {});
        await fallback.close().catch(() => {});
      }
    }

    // ── Test C11: gemini connection error with NO fallback at all → 502 ─────
    // forwardGemini's up.on('error') previously ignored tryFallbackOrFail's
    // boolean and never sent a response when nothing handled it — the client
    // socket hung forever. With no fallback_to, no routes.default, and no local
    // terminal, the proxy must now surface a 502 (mirrors forwardAnthropic).
    // If the bug regresses, httpJson rejects on timeout and this test fails.
    console.log('\nC11. gemini connection error + no fallback → 502 (not a hang)');
    {
      const cfg = {
        endpoints: {
          // Unreachable port, no fallback_to, no routes.default below.
          gemini_ai: {
            format: 'gemini',
            url: 'http://127.0.0.1:1',
            auth: 'none',
          },
        },
        model_routes: {
          'gemini-pro': { endpoint: 'gemini_ai', name: 'gemini-pro-latest' },
        },
      };
      const configPath = writeConfig(tmpDir, cfg);
      await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
        let r, hung = false;
        try {
          r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'gemini-pro', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          }, {}, 8000);
        } catch (e) {
          hung = /timed out/.test(e.message);
        }
        assert(!hung, 'C11 client did NOT hang (got a response before timeout)');
        assertEq(r?.status, 502, `C11 connection error surfaced as 502 (got ${r?.status})`);
        assert(r?.json?.type === 'error',
          `C11 502 carries an Anthropic-shape error envelope (got type: ${r?.json?.type})`);
      });
    }

    // ── Test C45: empty-base @sigil must NOT forward an empty model ─────────
    // BACKEND_SIGIL_RE's `.*` base lets bare "@anthropic" match with an empty
    // baseModel → resolveBackend used to return effectiveModel:'' and forward
    // model:"" upstream. The non-empty guard makes "@anthropic" fall through to
    // normal resolution instead. The defining assertion: the anthropic backend
    // never receives a request whose model is empty.
    console.log('\nC45. model "@anthropic" (empty base) does not forward an empty model upstream');
    {
      const anthropic = await stubBackend({
        responseBody: {
          id: 'msg_c45',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'served' }],
          model: 'claude-sonnet-5',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      try {
        const cfg = {
          endpoints: {
            anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${anthropic.port}` },
          },
          model_routes: { 'claude-sonnet-5': 'anthropic' },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          // Best-effort request; we don't care about its status, only that the
          // anthropic stub is never handed model:"".
          await httpJson(port, 'POST', '/v1/messages', {
            model: '@anthropic', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          }, {}, 8000).catch(() => {});
          const emptyModelHit = anthropic.requests.some(
            req => req.model_used === '' || req.body?.model === ''
          );
          assert(!emptyModelHit,
            `C45 anthropic backend never received an empty model (hits: ${JSON.stringify(anthropic.requests.map(r => r.model_used))})`);
        });
      } finally {
        await anthropic.close().catch(() => {});
      }
    }

    // ── Test C44: local terminal already tried under its CONCRETE name is NOT re-dispatched ─
    // tryLocalTerminalFallback resolves the LOGICAL profile fallback model
    // through resolveBackend to its concrete effectiveModel, then de-dups on the
    // concrete name (triedM.has(termResolved.effectiveModel)). Construct a
    // capability whose primary connected model and local-fallback model are two
    // DIFFERENT logical names ('local-concrete' vs 'local-alias') that resolve to
    // the SAME concrete model 'local-concrete' (via a model_routes alias) on the
    // SAME local backend. The primary attempt fails (404) and records
    // 'local-concrete' in _triedModels. When the cascade reaches the local
    // terminal, the logical name 'local-alias' is NOT in the tried set — pre-fix
    // it re-dispatched the same concrete model a 2nd time. Post-fix it resolves
    // 'local-alias' → 'local-concrete', sees the concrete name already tried, and
    // skips: the local backend is hit exactly ONCE and the original 404 surfaces.
    console.log('\nC44. local terminal resolving to an already-tried concrete model is NOT re-dispatched');
    {
      // Bare http server (NOT ollamaStubBackend, which always 200s) that records
      // every request and always returns 404, so the cascade runs to the terminal.
      const http = require('http');
      const localRequests = [];
      const local = await new Promise((resolve, reject) => {
        const s = http.createServer((req, res) => {
          const chunks = [];
          req.on('data', c => chunks.push(c));
          req.on('end', () => {
            let b = null; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
            localRequests.push({ model_used: b?.model || null });
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'model not found' }));
          });
        });
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => resolve(s));
      });
      try {
        const cfg = {
          backends: {
            local_be: { kind: 'ollama', url: `http://127.0.0.1:${local.address().port}`, legacy_ollama_chat: true },
          },
          model_routes: {
            'local-concrete': 'local_be',
            'local-alias':    'local-concrete',   // logical alias → SAME concrete model
          },
          llm_profiles: {
            // Primary (connected) → local-concrete; local terminal (best-local-oss)
            // → local-alias which resolves to the SAME concrete 'local-concrete'.
            workhorse: {
              'best-cloud':     { '128gb': 'local-concrete' },
              'best-local-oss': { '128gb': 'local-alias' },
            },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          }, {}, 8000);
          // Original 404 surfaces (terminal skipped, no global default configured).
          assertEq(r.status, 404, 'C44 original 404 surfaces (local terminal skipped, not re-dispatched)');
          // The defining assertion: the local backend was hit exactly ONCE — the
          // primary attempt — NOT a second time via tryLocalTerminalFallback.
          assertEq(localRequests.length, 1, 'C44 local backend hit exactly once (concrete model not double-dispatched)');
          assertEq(localRequests[0].model_used, 'local-concrete', 'C44 the single hit used the concrete model');
        });
      } finally {
        await new Promise(r => local.close(r));
      }
    }

    // ── Test C31a: gemini 503 (no fallback_to) → capability fallback_chains hop ─
    // Batch 3 ungated forwardGemini's non-2xx cascade from `backend.fallback_to`.
    // C9 proves routes.default catches it; C31a proves the OTHER tier the ungate
    // unlocked: a capability-level fallback_chains[tier][cap] candidate. capKey is
    // non-null only when the request routes through a capability (llm_profiles key),
    // so the client model is the capability name 'workhorse' — resolveCapabilityAlias
    // makes requestMeta.capability = 'workhorse', and tryFallbackOrFail reads
    // CONFIG.fallback_chains['128gb']['workhorse'] after the (empty) per-backend walk.
    console.log('\nC31a. gemini 503 (no fallback_to) → cascades to capability fallback_chains candidate');
    {
      const gemini = await stubBackend({ failWith: 503 });
      const chainAlt = await stubBackend({
        responseBody: {
          id: 'msg_cap_chain',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'served-by-cap-chain' }],
          model: 'claude-sonnet-5',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      try {
        const cfg = {
          endpoints: {
            // NOTE: deliberately NO fallback_to on the gemini endpoint.
            gemini_ai: {
              format: 'gemini',
              url: `http://127.0.0.1:${gemini.port}`,
              auth: 'none',
            },
            anthropic: {
              kind: 'anthropic',
              url: `http://127.0.0.1:${chainAlt.port}`,
            },
          },
          model_routes: {
            // Primary capability model resolves to the gemini endpoint.
            'gemini-primary': { endpoint: 'gemini_ai', name: 'gemini-pro-latest' },
            // The capability-chain candidate resolves to the anthropic stub.
            'chain-alt':      'anthropic',
          },
          // Capability route: client sends model 'workhorse' (an llm_profiles key),
          // so requestMeta.capability = 'workhorse' (capKey non-null).
          llm_profiles: {
            workhorse: { 'best-cloud': { '128gb': 'gemini-primary' } },
          },
          // The tier-2 capability cascade the Batch 3 fix unlocked.
          fallback_chains: {
            '128gb': { workhorse: ['chain-alt'] },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r.status, 200, 'C31a gemini 503 (no fallback_to) → 200 via capability fallback_chains');
          const text = (r.json?.content || []).map(b => b.text).join('');
          assert(text.includes('served-by-cap-chain'),
            `C31a served by fallback_chains candidate, not raw gemini error (got: ${text})`);
          assertEq(gemini.requests.length, 1, 'C31a gemini tried once');
          assertEq(chainAlt.requests.length, 1, 'C31a capability-chain candidate served once');
        });
      } finally {
        await gemini.close().catch(() => {});
        await chainAlt.close().catch(() => {});
      }
    }

    // ── Test C31c: gemini connection error (no fallback_to) → routes.default ────
    // Mirrors C11's connection-error path, but where C11 has NO fallback anywhere
    // (→ 502), C31c configures routes.default. The Batch 3 ungate means forwardGemini's
    // up.on('error') handler ALWAYS walks the cascade; with the per-backend chain
    // and any capability chain empty, tryGlobalDefaultFallback must catch the
    // connection error and serve routes.default (200) instead of a raw 502.
    console.log('\nC31c. gemini connection error (no fallback_to) + routes.default → cascades to default (200)');
    {
      const fallback = await stubBackend({
        responseBody: {
          id: 'msg_default_conn_fb',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'served-by-default-on-conn-error' }],
          model: 'claude-sonnet-5',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      try {
        const cfg = {
          endpoints: {
            // Unreachable port → connection error (not HTTP). No fallback_to.
            gemini_ai: {
              format: 'gemini',
              url: 'http://127.0.0.1:1',
              auth: 'none',
            },
            anthropic: {
              kind: 'anthropic',
              url: `http://127.0.0.1:${fallback.port}`,
            },
          },
          model_routes: {
            'gemini-pro':        { endpoint: 'gemini_ai', name: 'gemini-pro-latest' },
            'claude-sonnet-5': 'anthropic',
          },
          routes: { default: 'claude-sonnet-5' },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'gemini-pro', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          }, {}, 10000);
          assertEq(r.status, 200, 'C31c gemini conn-error (no fallback_to) → 200 via routes.default');
          const text = (r.json?.content || []).map(b => b.text).join('');
          assert(text.includes('served-by-default-on-conn-error'),
            `C31c served by routes.default after connection error, not a raw 502 (got: ${text})`);
          assertEq(fallback.requests.length, 1, 'C31c routes.default backend served once');
        });
      } finally {
        await fallback.close().catch(() => {});
      }
    }

    // ── Test P1-STREAM: stream:true, primary fails pre-headers → fallback STREAMS ─
    // GAP: every prior fallback assertion uses stream:false. Claude Code's default
    // IS streaming, and the proxy has SEPARATE dispatch/error handling for the SSE
    // path (forwardAnthropic only fails over while !res.headersSent — once the
    // first SSE byte is flushed the cascade is impossible). This case proves the
    // pre-first-byte cascade still produces a COHERENT stream from the fallback
    // (not a hang, not a raw error after headersSent). Two sub-cases:
    //   (a) primary 503 pre-headers → fallback serves SSE
    //   (b) primary connection-refused (port closed) → fallback serves SSE
    console.log('\nP1-STREAM. stream:true + primary fails pre-first-byte → fallback serves a coherent stream');
    {
      // Helper: build a config whose primary anthropic backend falls back to a
      // streaming anthropic backend. Routed through a capability so the request
      // model is a plain logical model name.
      const buildStreamCfg = (primaryPort, fallbackPort) => ({
        backends: {
          stream_primary:  { kind: 'anthropic', url: `http://127.0.0.1:${primaryPort}`, fallback_to: 'stream-fallback-target' },
          stream_fallback: { kind: 'anthropic', url: `http://127.0.0.1:${fallbackPort}` },
        },
        model_routes: {
          'stream-primary-model':   'stream_primary',
          'stream-fallback-target': 'stream_fallback',
        },
        llm_profiles: {
          '128gb': {
            workhorse: { connected_model: 'stream-primary-model', disconnect_model: 'stream-primary-model' },
          },
        },
      });
      const assertCoherentStream = (r, label) => {
        assertEq(r.status, 200, `${label}: fallback stream returned 200`);
        const types = r.events.map(e => e.event);
        assertEq(types[0], 'message_start', `${label}: first SSE event = message_start`);
        assertEq(types[types.length - 1], 'message_stop', `${label}: last SSE event = message_stop (clean close, no hang)`);
        const text = r.events
          .filter(e => e.event === 'content_block_delta')
          .map(e => e.data?.delta?.text || '').join('');
        assert(text.includes('stream-fallback-served'),
          `${label}: streamed bytes came from the FALLBACK, not the failed primary (got: ${JSON.stringify(text)})`);
      };

      // (a) primary 503 pre-headers → fallback streams
      {
        const primary  = await stubBackend({ failWith: 503 });
        const fallback = await streamingStubBackend(FALLBACK_STREAM);
        try {
          const configPath = writeConfig(tmpDir, buildStreamCfg(primary.port, fallback.port));
          await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
            const r = await httpStream(port, 'POST', '/v1/messages', {
              model: 'stream-primary-model', stream: true,
              messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
            }, {}, 10000);
            assertCoherentStream(r, 'stream/503');
            assertEq(primary.requests.length, 1, 'stream/503: primary tried once (503 pre-headers)');
            assertEq(fallback.requests.length, 1, 'stream/503: streaming fallback served once');
            assertEq(fallback.lastRequest()?.body?.stream, true,
              'stream/503: fallback received stream:true (flag preserved across the cascade)');
          });
        } finally {
          await primary.close().catch(() => {});
          await fallback.close().catch(() => {});
        }
      }

      // (b) primary connection-refused (port closed) → fallback streams.
      // This is the strict "fails BEFORE the first byte" form: the proxy never
      // even gets an HTTP response from the primary, so the cascade fires from
      // the up.on('error') handler rather than the non-2xx handler.
      {
        const sham = await stubBackend({});
        const closedPort = sham.port;
        await sham.close();
        const fallback = await streamingStubBackend(FALLBACK_STREAM);
        try {
          const configPath = writeConfig(tmpDir, buildStreamCfg(closedPort, fallback.port));
          await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
            const r = await httpStream(port, 'POST', '/v1/messages', {
              model: 'stream-primary-model', stream: true,
              messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
            }, {}, 10000);
            assertCoherentStream(r, 'stream/conn-refused');
            assertEq(fallback.requests.length, 1, 'stream/conn-refused: streaming fallback served once');
          });
        } finally {
          await fallback.close().catch(() => {});
        }
      }
    }

    // ── Test P1-GOV: gov filter applied AT CASCADE time (not just pre-dispatch) ──
    // GAP: the gov Chinese-origin block was only ever tested on the PRIMARY
    // selection (proxy-mode-filters.test.js). It was never tested that when a
    // primary FAILS and the proxy WALKS the fallback chain, the cascade SKIPS a
    // Chinese-origin node (fallback.skip_mode_filter) and serves the compliant
    // one. This exercises the modeAllows()/filterFor() guard inside
    // tryFallbackOrFail's per-backend fallback_to walk.
    //
    // Chain: compliant_primary (non-Chinese, 5xx) → blocked (qwen3 = Chinese)
    //        → compliant_fallback (non-Chinese, serves). Under best-cloud-gov the
    // walk must skip the qwen3 node entirely (never hit its stub) and serve the
    // compliant fallback.
    console.log('\nP1-GOV. cascade walk under best-cloud-gov SKIPS a Chinese-origin node and serves the compliant one');
    {
      const primary  = await stubBackend({ failWith: 503 });       // non-Chinese primary, fails
      const blocked  = await stubBackend();                         // Chinese-origin (qwen3) — must NEVER be hit
      const compliant = await stubBackend({
        responseBody: {
          id: 'msg_gov_fb', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'served-by-compliant-fallback' }],
          model: 'claude-sonnet-gov', stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      try {
        // Per-backend fallback_to walk: primary → qwen3 (blocked) → claude (compliant).
        // The qwen3 node itself declares fallback_to so the walk DESCENDS past it
        // (skip_mode_filter path that continues, mirroring a cooldown skip).
        const cfg = {
          backends: {
            primary_be:   { kind: 'anthropic', url: `http://127.0.0.1:${primary.port}`,   fallback_to: 'qwen3-blocked' },
            qwen3_be:     { kind: 'anthropic', url: `http://127.0.0.1:${blocked.port}`,    fallback_to: 'claude-compliant' },
            compliant_be: { kind: 'anthropic', url: `http://127.0.0.1:${compliant.port}` },
          },
          model_routes: {
            'claude-sonnet-primary': 'primary_be',   // non-Chinese name → allowed
            'qwen3-blocked':         'qwen3_be',      // Chinese family token → blocked in gov
            'claude-compliant':      'compliant_be',  // non-Chinese name → allowed
          },
          llm_profiles: {
            gov_cap: {
              'best-cloud-gov': { '128gb': 'claude-sonnet-primary' },
            },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'best-cloud-gov' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'gov_cap', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          }, {}, 8000);
          assertEq(r.status, 200, 'gov cascade served the compliant fallback (200)');
          const text = (r.json?.content || []).map(b => b.text).join('');
          assert(text.includes('served-by-compliant-fallback'),
            `gov cascade served the compliant node, not the Chinese one (got: ${text})`);
          assertEq(primary.requests.length, 1, 'gov: non-Chinese primary tried once');
          assertEq(blocked.requests.length, 0,
            'gov: Chinese-origin (qwen3) node SKIPPED in the cascade walk — never dispatched');
          assertEq(compliant.requests.length, 1, 'gov: compliant fallback served once');
        });
      } finally {
        await primary.close().catch(() => {});
        await blocked.close().catch(() => {});
        await compliant.close().catch(() => {});
      }
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Gate the exit code on the failed count (mirrors every sibling fallback suite).
  // Previously this called summary() and discarded the result, so a failed
  // assertion still exited 0 — run-all.sh keys on exit code, so the whole
  // fallback dimension was painted green regardless of assertion failures.
  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
