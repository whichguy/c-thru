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
const path = require('path');

console.log('proxy cooldown TTL tests\n');

const HEALTHY_NDJSON = [
  { message: { content: 'served' } },
  { done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 },
];

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
          llm_profiles: {
            '128gb': { workhorse: { connected_model: 'A-model', disconnect_model: 'A-model' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        // Use a short TTL so we can test expiry within the test.
        await withProxy({
          configPath,
          profile: '128gb',
          mode: 'connected',
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

          // Request 2 (immediate): A fails → B is cooldowned (has fallback_to) → skip → C.
          const r2 = await httpJson(port, 'POST', '/v1/messages', reqBody);
          assertEq(r2.status, 200, 'request 2: still served via C (200)');
          assertEq(A.requests.length, 2, 'request 2: A tried again (primary — never cooldowned from this chain)');
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
          llm_profiles: {
            '128gb': { workhorse: { connected_model: 'T-model', disconnect_model: 'T-model' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({
          configPath, profile: '128gb', mode: 'connected',
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
          llm_profiles: {
            '128gb': { workhorse: { connected_model: 'P-model', disconnect_model: 'P-model' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({
          configPath, profile: '128gb', mode: 'connected',
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
          llm_profiles: {
            '128gb': { workhorse: { connected_model: 'A-model', disconnect_model: 'A-model' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        // Use a more realistic TTL here so the status check can read a meaningful expiry.
        await withProxy({
          configPath, profile: '128gb', mode: 'connected',
          env: { CLAUDE_PROXY_FAILED_BACKEND_TTL_MS: '30000' },
        }, async ({ port }) => {
          const reqBody = {
            model: 'A-model', stream: false,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 10,
          };
          // Trigger cooldown.
          await httpJson(port, 'POST', '/v1/messages', reqBody);

          const status = await httpJson(port, 'GET', '/c-thru/status', null, {}, 3000);
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

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
