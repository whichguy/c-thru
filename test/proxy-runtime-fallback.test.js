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
  writeConfig, withProxy, httpJson, stubBackend, ollamaStubBackend,
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
      stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${ollamaPort}` },
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
            },
            healthy_ollama: { kind: 'ollama', url: `http://127.0.0.1:${ollamaHealthy.port}` },
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
            },
            healthy_ollama: { kind: 'ollama', url: `http://127.0.0.1:${ollamaHealthy.port}` },
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
            tertiary_be:  { kind: 'ollama',    url: `http://127.0.0.1:${tertiary.port}` },
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
            C_be: { kind: 'ollama', url: `http://127.0.0.1:${C.port}` },
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

          // Second request: B should be in cooldown, walked-around.
          // Counts after: A=2, B=1 (NOT 2 — skipped), C=2.
          const r2 = await httpJson(port, 'POST', '/v1/messages', {
            model: 'A-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 50,
          });
          assertEq(r2.status, 200, 'second request: chain still serves (200)');
          assertEq(A.requests.length, 2, 'second req: A tried 1x more (still in chain)');
          assertEq(B.requests.length, 1, 'second req: B SKIPPED via cooldown (still 1, not 2)');
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
            default_be: { kind: 'ollama', url: `http://127.0.0.1:${defaultBackend.port}` },
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
            C_be: { kind: 'ollama', url: `http://127.0.0.1:${C.port}` },
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
            ollama_local: { kind: 'ollama', url: `http://127.0.0.1:${upstream.address().port}` },
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
            ollama_local: { kind: 'ollama', url: `http://127.0.0.1:${upstream.address().port}` },
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

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  summary();
}

main().catch(e => { console.error(e); process.exit(1); });
