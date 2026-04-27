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

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  summary();
}

main().catch(e => { console.error(e); process.exit(1); });
