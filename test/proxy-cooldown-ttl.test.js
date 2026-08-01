#!/usr/bin/env node
'use strict';
// Test: backend cooldown TTL — a cooldowned backend is skipped during the
// cooldown window, and becomes eligible again after the TTL expires.
//
// Uses CLAUDE_PROXY_FAILED_BACKEND_TTL_MS to set a very short cooldown (500ms)
// so the test can wait out the TTL without needing a fake clock.
//
// Run: node test/proxy-cooldown-ttl.test.js

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson,
  stubBackend, ollamaStubBackend,
} = require('./helpers');

const fs   = require('fs');
const os   = require('os');
const http = require('http');
const path = require('path');

console.log('proxy cooldown TTL tests\n');

const HEALTHY_NDJSON = [
  { message: { content: 'served' } },
  { done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 },
];

// A togglable Anthropic stub: returns 500 while .failNext is true, else 200.
// Each request is recorded in .requests. Flip .failNext between requests to
// drive the fail→cooldown→recover→clear-on-success sequence deterministically.
function togglableBackend(opts = {}) {
  const requests = [];
  const state = { failNext: opts.failFirst !== false };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      if (state.failNext) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'forced 500' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_toggle', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: body ? body.model : 'stub', stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server, port: server.address().port, requests, state,
        setFailNext: (v) => { state.failNext = v; },
        close: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-cooldown-'));

  try {
    // ── Test 1: intermediate backend in cooldown is skipped; TTL expires; it's retried ─
    // Chain: A (always 500) → B (always 500) → C (serves).
    // On request 1: A→fail(cooldown)→B→fail(cooldown)→C(serves).
    // On request 2 (immediate): A fails → B is in cooldown and has fallback_to → skip → C.
    //   B.requests stays at 1 (skipped).
    // After TTL (600ms): B's cooldown expires → B is tried again on request 3.
    //   B.requests becomes 2.
    //
    // This mirrors the existing test 10 in proxy-runtime-fallback.test.js but
    // additionally validates the TTL-expiry path: after the TTL window passes,
    // the cooldowned backend re-enters the chain.
    console.log('1. Intermediate backend in cooldown is skipped, then re-eligible after TTL');
    {
      const A = await stubBackend({ failWith: 500 });
      const B = await stubBackend({ failWith: 500 });
      const C = await ollamaStubBackend(HEALTHY_NDJSON);
      try {
        const cfg = {
          backends: {
            A_be: { kind: 'anthropic', url: `http://127.0.0.1:${A.port}`, fallback_to: 'B-target' },
            B_be: { kind: 'anthropic', url: `http://127.0.0.1:${B.port}`, fallback_to: 'C-target' },
            C_be: { kind: 'ollama',    url: `http://127.0.0.1:${C.port}` },
          },
          model_routes: { 'A-model': 'A_be', 'B-target': 'B_be', 'C-target': 'C_be' },
        };
        const configPath = writeConfig(tmpDir, cfg);
        // Use a short TTL so we can test expiry within the test.
        await withProxy({
          configPath,
          profile: '128gb',
          mode: 'best-cloud',
          env: { CLAUDE_PROXY_FAILED_BACKEND_TTL_MS: '500' },
        }, async ({ port }) => {
          const reqBody = {
            model: 'A-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 10,
          };

          // Request 1: A→fail(cooldown)→B→fail(cooldown)→C(serves).
          const r1 = await httpJson(port, 'POST', '/v1/messages', reqBody);
          assertEq(r1.status, 200, 'request 1: served via C (200)');
          assertEq(A.requests.length, 1, 'request 1: A tried once');
          assertEq(B.requests.length, 1, 'request 1: B tried once');
          assertEq(C.requests.length, 1, 'request 1: C served');

          // Request 2 (immediate): A is cooldowned (has fallback_to) → skip →
          //   B is also cooldowned (has fallback_to) → skip → C serves.
          // The proxy skips any non-terminal backend that is in cooldown,
          // including the primary, to avoid paying the TTFT cost of a known-bad backend.
          const r2 = await httpJson(port, 'POST', '/v1/messages', reqBody);
          assertEq(r2.status, 200, 'request 2: still served via C (200)');
          assertEq(A.requests.length, 1, 'request 2: A SKIPPED (in cooldown — has fallback_to)');
          assertEq(B.requests.length, 1, 'request 2: B SKIPPED (in cooldown)');
          assertEq(C.requests.length, 2, 'request 2: C served again');

          // Wait for cooldown TTL to expire.
          await new Promise(r => setTimeout(r, 650));

          // Request 3: B's cooldown has expired → B is tried again.
          const r3 = await httpJson(port, 'POST', '/v1/messages', reqBody);
          assertEq(r3.status, 200, 'request 3: served (200) after B cooldown expiry');
          assertEq(B.requests.length, 2, 'request 3: B RE-TRIED after TTL expiry');
          assertEq(C.requests.length, 3, 'request 3: C served again after B fails');
        });
      } finally {
        await A.close().catch(() => {});
        await B.close().catch(() => {});
        await C.close().catch(() => {});
      }
    }

    // ── Test 2: terminal backend is NEVER cooldowned even after failure ───────
    // A backend without fallback_to is a terminal node; the proxy must not
    // cooldown it because it's the only option — cooldowing would leave us
    // with no backend to try at all.
    console.log('\n2. Terminal backend (no fallback_to) is never cooldowned');
    {
      const T = await stubBackend({ failWith: 500 });
      try {
        const cfg = {
          backends: {
            terminal_be: { kind: 'anthropic', url: `http://127.0.0.1:${T.port}` },  // no fallback_to
          },
          model_routes: { 'T-model': 'terminal_be' },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({
          configPath, profile: '128gb', mode: 'best-cloud',
          env: { CLAUDE_PROXY_FAILED_BACKEND_TTL_MS: '500' },
        }, async ({ port }) => {
          const reqBody = {
            model: 'T-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 10,
          };

          // Request 1: fails (terminal).
          await httpJson(port, 'POST', '/v1/messages', reqBody);
          assertEq(T.requests.length, 1, 'request 1: terminal tried');

          // Request 2 (immediate): terminal MUST be retried — NOT cooldowned.
          await httpJson(port, 'POST', '/v1/messages', reqBody);
          assertEq(T.requests.length, 2, 'request 2: terminal RE-TRIED (not cooldowned)');
        });
      } finally {
        await T.close().catch(() => {});
      }
    }

    // ── Test 3: permanent failure (401) never cooldowned ─────────────────────
    // 401 is classified as 'permanent' — retrying won't help until config
    // changes. Cooldowing would add delay with no benefit, so the backend
    // must remain in-chain and get retried every request.
    console.log('\n3. Permanent failure (401) does NOT enter cooldown — backend always retried');
    {
      const P = await stubBackend({ failWith: 401 });
      const C = await ollamaStubBackend(HEALTHY_NDJSON);
      try {
        const cfg = {
          backends: {
            perm_be:  { kind: 'anthropic', url: `http://127.0.0.1:${P.port}`, fallback_to: 'C-target' },
            C_be:     { kind: 'ollama',    url: `http://127.0.0.1:${C.port}` },
          },
          model_routes: { 'P-model': 'perm_be', 'C-target': 'C_be' },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({
          configPath, profile: '128gb', mode: 'best-cloud',
          env: { CLAUDE_PROXY_FAILED_BACKEND_TTL_MS: '500' },
        }, async ({ port }) => {
          const reqBody = {
            model: 'P-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 10,
          };

          // Request 1: P → 401 (permanent, no cooldown) → C serves.
          const r1 = await httpJson(port, 'POST', '/v1/messages', reqBody);
          assertEq(r1.status, 200, 'request 1: 200 via C');
          assertEq(P.requests.length, 1, 'request 1: P tried');
          assertEq(C.requests.length, 1, 'request 1: C served');

          // Request 2 (immediate): P must be retried (no cooldown for 401).
          const r2 = await httpJson(port, 'POST', '/v1/messages', reqBody);
          assertEq(r2.status, 200, 'request 2: 200 via C');
          assertEq(P.requests.length, 2, 'request 2: P RE-TRIED (401 = permanent, not cooldowned)');
          assertEq(C.requests.length, 2, 'request 2: C served again');
        });
      } finally {
        await P.close().catch(() => {});
        await C.close().catch(() => {});
      }
    }

    // ── Test 4: /c-thru/status reflects cooldown state and TTL ───────────────
    console.log('\n4. /c-thru/status reports cooldowned backend and expires_in_ms');
    {
      const A = await stubBackend({ failWith: 500 });
      const C = await ollamaStubBackend(HEALTHY_NDJSON);
      try {
        const cfg = {
          backends: {
            A_be: { kind: 'anthropic', url: `http://127.0.0.1:${A.port}`, fallback_to: 'C-target' },
            C_be: { kind: 'ollama',    url: `http://127.0.0.1:${C.port}` },
          },
          model_routes: { 'A-model': 'A_be', 'C-target': 'C_be' },
        };
        const configPath = writeConfig(tmpDir, cfg);
        // Use a more realistic TTL here so the status check can read a meaningful expiry.
        await withProxy({
          configPath, profile: '128gb', mode: 'best-cloud',
          env: { CLAUDE_PROXY_FAILED_BACKEND_TTL_MS: '30000' },
        }, async ({ port }) => {
          const reqBody = {
            model: 'A-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 10,
          };
          // Trigger cooldown.
          await httpJson(port, 'POST', '/v1/messages', reqBody);

          const status = await httpJson(port, 'GET', '/c-thru/status', null, {});
          assertEq(status.status, 200, '/c-thru/status OK');
          assert(Array.isArray(status.json.cooldown_backends), 'cooldown_backends is array');
          const entry = status.json.cooldown_backends.find(c => c.backend === 'A_be');
          assert(!!entry, `A_be appears in cooldown_backends (got: ${JSON.stringify(status.json.cooldown_backends)})`);
          assert(typeof entry.expires_in_ms === 'number' && entry.expires_in_ms > 0 && entry.expires_in_ms <= 30000,
            `expires_in_ms is a positive number within TTL (got: ${entry.expires_in_ms})`);
        });
      } finally {
        await A.close().catch(() => {});
        await C.close().catch(() => {});
      }
    }

    // ── Test 5: cooldown clears on a later SUCCESS (clearBackendCooldown) ─────
    // A (fails-once-then-succeeds) → fallback B (always serves).
    //   req1: A fails 500 → cooldown set on A → B serves.          A=1, B=1
    //   req2 (immediate, within TTL): A in cooldown → SKIPPED → B.  A=1, B=2  ← cooldown OBSERVABLE
    //   (wait out the short TTL so A re-enters the chain)
    //   req3: A now serves 200 → clearBackendCooldown(A) fires.     A=2, B=2  served by A
    //   req4 (immediate): A NOT in cooldown → A hit DIRECTLY.       A=3, B=2  served by A
    // The clear-on-success contract is what makes the cooldown map empty for A
    // (asserted via /c-thru/status) so subsequent requests dispatch straight to A.
    console.log('\n5. Cooldown CLEARS on a later success; A is then dispatched to directly');
    {
      const A = await togglableBackend({ failFirst: true });
      const B = await ollamaStubBackend(HEALTHY_NDJSON);
      try {
        const cfg = {
          backends: {
            A_be: { kind: 'anthropic', url: `http://127.0.0.1:${A.port}`, fallback_to: 'B-target' },
            B_be: { kind: 'ollama',    url: `http://127.0.0.1:${B.port}` },
          },
          model_routes: { 'A-model': 'A_be', 'B-target': 'B_be' },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({
          configPath, profile: '128gb', mode: 'best-cloud',
          env: { CLAUDE_PROXY_FAILED_BACKEND_TTL_MS: '500' },
        }, async ({ port }) => {
          const reqBody = {
            model: 'A-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 10,
          };

          // req1: A fails → cooldown set → B serves.
          const r1 = await httpJson(port, 'POST', '/v1/messages', reqBody);
          assertEq(r1.status, 200, 'req1: 200 via B (A failed)');
          assertEq(A.requests.length, 1, 'req1: A tried once (failed)');
          assertEq(B.requests.length, 1, 'req1: B served');

          // Cooldown is observable in /c-thru/status while still within TTL.
          const st1 = await httpJson(port, 'GET', '/c-thru/status', null, {});
          assert(st1.json.cooldown_backends.some(c => c.backend === 'A_be'),
            'A_be is in cooldown_backends after req1 failure');

          // req2 (immediate): A in cooldown → SKIPPED → B again. Proves the
          // cooldown is actually skipping A in the cascade.
          const r2 = await httpJson(port, 'POST', '/v1/messages', reqBody);
          assertEq(r2.status, 200, 'req2: 200 via B (A skipped)');
          assertEq(A.requests.length, 1, 'req2: A SKIPPED (cooldown observable)');
          assertEq(B.requests.length, 2, 'req2: B served again');

          // A will now succeed when it next gets a request.
          A.setFailNext(false);
          // Wait out the cooldown TTL so A re-enters the chain.
          await new Promise(r => setTimeout(r, 650));

          // req3: A re-eligible, succeeds → clearBackendCooldown(A_be).
          const r3 = await httpJson(port, 'POST', '/v1/messages', reqBody);
          assertEq(r3.status, 200, 'req3: 200 via A (recovered)');
          assertEq(A.requests.length, 2, 'req3: A RE-TRIED after TTL and succeeded');
          assertEq(B.requests.length, 2, 'req3: B NOT hit (A served)');
          assertEq(r3.headers['x-c-thru-served-by'], 'A-model', 'req3: served-by reports A-model');

          // The success must have CLEARED A's cooldown entry entirely.
          const st2 = await httpJson(port, 'GET', '/c-thru/status', null, {});
          assert(!st2.json.cooldown_backends.some(c => c.backend === 'A_be'),
            'A_be cooldown CLEARED on success (absent from cooldown_backends)');

          // req4 (immediate): A is not in cooldown → dispatched DIRECTLY to A.
          const r4 = await httpJson(port, 'POST', '/v1/messages', reqBody);
          assertEq(r4.status, 200, 'req4: 200 via A (direct dispatch)');
          assertEq(A.requests.length, 3, 'req4: A hit directly (cooldown was cleared)');
          assertEq(B.requests.length, 2, 'req4: B still not hit since recovery');
          assertEq(r4.headers['x-c-thru-served-by'], 'A-model', 'req4: served-by reports A-model');
        });
      } finally {
        await A.close().catch(() => {});
        await B.close().catch(() => {});
      }
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
