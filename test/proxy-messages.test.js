#!/usr/bin/env node
'use strict';
// Mocked end-to-end tests for /v1/messages: real proxy + stub Anthropic backend.
// No real model required — the stub returns a valid Anthropic response for every
// request, letting us validate proxy mechanics (routing, header emission,
// response passthrough) without network access.
//
// Covers the same scenarios as proxy-e2e.test.js but runs on any machine.
// Run with: node test/proxy-messages.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, summary,
  stubBackend, writeConfig, httpJson, withProxy,
} = require('./helpers');

console.log('proxy-messages mocked E2E tests\n');

// ── Config ─────────────────────────────────────────────────────────────────

const CONCRETE_MODEL = 'test-model-v1';

function buildConfig(stubPort) {
  return {
    backends: {
      stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    model_routes: {
      [CONCRETE_MODEL]: 'stub',
    },
    llm_profiles: {
      '16gb': {
        workhorse: {
          connected_model:  `${CONCRETE_MODEL}@stub`,
          disconnect_model: `${CONCRETE_MODEL}@stub`,
        },
        judge: {
          connected_model:  `${CONCRETE_MODEL}@stub`,
          disconnect_model: `${CONCRETE_MODEL}@stub`,
          modes: {
            'semi-offload':     `${CONCRETE_MODEL}@stub`,
            'cloud-judge-only': `${CONCRETE_MODEL}@stub`,
          },
        },
      },
    },
    agent_to_capability: {
      'test-agent': 'workhorse',
    },
  };
}

// Request body — mirrors proxy-e2e.test.js so mocked and real tests are comparable.
const MSG_BODY = {
  messages: [{ role: 'user', content: 'what is your model name, where were you born, model id and who is your maker?' }],
  max_tokens: 50,
};

function parseResolvedVia(headers) {
  const raw = headers['x-c-thru-resolved-via'];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function textContent(json) {
  if (!json || !Array.isArray(json.content)) return '';
  return json.content.filter(c => c.type === 'text').map(c => c.text).join('');
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-msg-'));
  let stub;

  try {
    stub = await stubBackend();
    const configPath = writeConfig(tmpDir, buildConfig(stub.port));

    const proxyEnv = { CLAUDE_PROXY_ANNOTATE_MODEL: '1' };

    // ── Test 1: Direct model routing — response body + headers ─────────────
    console.log('1. Direct model routing (model_routes → stub)');
    await withProxy({ configPath, profile: '16gb', env: proxyEnv }, async ({ port }) => {
      const body = Object.assign({ model: CONCRETE_MODEL }, MSG_BODY);
      const r = await httpJson(port, 'POST', '/v1/messages', body);

      assert(r.status === 200, `direct: status 200 (got ${r.status})`);
      assert(r.json && r.json.type === 'message', 'direct: response type === message');
      assert(r.json && r.json.model === CONCRETE_MODEL,
        `direct: response.model === ${CONCRETE_MODEL} (got ${r.json && r.json.model})`);
      assert(textContent(r.json).length > 0, 'direct: text content non-empty');

      // No capability alias → x-c-thru-resolved-via absent
      assert(parseResolvedVia(r.headers) === null,
        'direct: x-c-thru-resolved-via absent (no capability alias)');

      // ANNOTATE_MODEL=1 → x-claude-proxy-served-by present
      assert(r.headers['x-c-thru-served-by'] === CONCRETE_MODEL,
        `direct: x-claude-proxy-served-by === ${CONCRETE_MODEL}`);

      // Stub received the right model
      assert(stub.lastRequest() && stub.lastRequest().model_used === CONCRETE_MODEL,
        `direct: stub received model_used === ${CONCRETE_MODEL}`);
    });

    // ── Test 2: Capability alias — x-c-thru-resolved-via header ────────────
    console.log('\n2. Capability alias (workhorse → concrete model) — response headers');
    await withProxy({ configPath, profile: '16gb', env: { ...proxyEnv, CLAUDE_LLM_MODE: 'connected' } }, async ({ port }) => {
      const body = Object.assign({ model: 'workhorse' }, MSG_BODY);
      const r = await httpJson(port, 'POST', '/v1/messages', body);

      assert(r.status === 200, `workhorse: status 200 (got ${r.status})`);
      assert(r.json && r.json.model === CONCRETE_MODEL,
        `workhorse: response.model === ${CONCRETE_MODEL}`);

      const via = parseResolvedVia(r.headers);
      assert(via !== null, 'workhorse: x-c-thru-resolved-via header present');
      assert(via && via.served_by === CONCRETE_MODEL,
        `workhorse: x-c-thru-resolved-via.served_by === ${CONCRETE_MODEL} (got ${via && via.served_by})`);
      assert(via && via.capability === 'workhorse',
        `workhorse: x-c-thru-resolved-via.capability === workhorse (got ${via && via.capability})`);

      assert(r.headers['x-c-thru-served-by'] === CONCRETE_MODEL,
        `workhorse: x-claude-proxy-served-by === ${CONCRETE_MODEL}`);

      assert(stub.lastRequest() && stub.lastRequest().model_used === CONCRETE_MODEL,
        `workhorse: stub received model_used === ${CONCRETE_MODEL}`);
      assert(stub.lastRequest() && stub.lastRequest().serving_url.includes('/v1/messages'),
        'workhorse: stub serving_url contains /v1/messages');
    });

    // ── Test 3: agent_to_capability chain ───────────────────────────────────
    console.log('\n3. agent_to_capability chain (test-agent → workhorse → concrete model)');
    await withProxy({ configPath, profile: '16gb', env: { ...proxyEnv, CLAUDE_LLM_MODE: 'connected' } }, async ({ port }) => {
      const body = Object.assign({ model: 'test-agent' }, MSG_BODY);
      const r = await httpJson(port, 'POST', '/v1/messages', body);

      assert(r.status === 200, `agent chain: status 200 (got ${r.status})`);
      assert(r.json && r.json.model === CONCRETE_MODEL,
        `agent chain: response.model === ${CONCRETE_MODEL}`);

      const via = parseResolvedVia(r.headers);
      assert(via && via.served_by === CONCRETE_MODEL,
        `agent chain: x-c-thru-resolved-via.served_by === ${CONCRETE_MODEL}`);
      assert(via && via.capability === 'workhorse',
        'agent chain: x-c-thru-resolved-via.capability === workhorse');

      assert(stub.lastRequest() && stub.lastRequest().model_used === CONCRETE_MODEL,
        `agent chain: stub received model_used === ${CONCRETE_MODEL}`);
    });

    // ── Test 4: offline mode → disconnect_model ─────────────────────────────
    console.log('\n4. Offline mode (workhorse → disconnect_model)');
    await withProxy({ configPath, profile: '16gb', env: { ...proxyEnv, CLAUDE_LLM_MODE: 'offline' } }, async ({ port }) => {
      const body = Object.assign({ model: 'workhorse' }, MSG_BODY);
      const r = await httpJson(port, 'POST', '/v1/messages', body);

      assert(r.status === 200, `offline: status 200 (got ${r.status})`);

      const via = parseResolvedVia(r.headers);
      assert(via && via.served_by === CONCRETE_MODEL,
        `offline: x-c-thru-resolved-via.served_by === ${CONCRETE_MODEL} (disconnect_model)`);
      assert(via && via.capability === 'workhorse',
        'offline: x-c-thru-resolved-via.capability === workhorse');
    });

    // ── Test 5: semi-offload modes[] sub-map ────────────────────────────────
    console.log('\n5. semi-offload mode (judge modes[] sub-map)');
    await withProxy({ configPath, profile: '16gb', env: { ...proxyEnv, CLAUDE_LLM_MODE: 'semi-offload' } }, async ({ port }) => {
      const body = Object.assign({ model: 'judge' }, MSG_BODY);
      const r = await httpJson(port, 'POST', '/v1/messages', body);

      assert(r.status === 200, `semi-offload: status 200 (got ${r.status})`);

      const via = parseResolvedVia(r.headers);
      assert(via && via.served_by === CONCRETE_MODEL,
        `semi-offload: x-c-thru-resolved-via.served_by === ${CONCRETE_MODEL}`);
      assert(via && via.capability === 'judge',
        'semi-offload: x-c-thru-resolved-via.capability === judge');
    });

    // ── Test 6: unknown model → 400 ────────────────────────────────────────
    console.log('\n6. Unknown model → proxy returns error');
    await withProxy({ configPath, profile: '16gb', env: proxyEnv }, async ({ port }) => {
      const body = Object.assign({ model: 'completely-unknown-model-xyz' }, MSG_BODY);
      const r = await httpJson(port, 'POST', '/v1/messages', body);

      // Proxy returns an error when it can't resolve the backend
      assert(r.status >= 400 && r.status < 600,
        `unknown model: error status (got ${r.status})`);
    });

    // ── Test 7: missing model field → 400 ──────────────────────────────────
    console.log('\n7. Missing model field → 400');
    await withProxy({ configPath, profile: '16gb', env: proxyEnv }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', MSG_BODY);
      assert(r.status === 400, `missing model: 400 (got ${r.status})`);
    });

  } finally {
    if (stub) await stub.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
