#!/usr/bin/env node
'use strict';
// End-to-end tests: real proxy → real Ollama backend.
// Tests model routing, capability alias resolution, agent chains,
// and validates x-c-thru-resolved-via response headers on live traffic.
//
// Requires: Ollama running at localhost:11434 with qwen3:1.7b pulled.
// Skips gracefully when Ollama is unreachable.
//
// Run with: node test/proxy-e2e.test.js

const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, summary,
  writeConfig, httpJson, withProxy,
} = require('./helpers');

console.log('proxy-e2e integration tests\n');

// ── E2E constants ──────────────────────────────────────────────────────────

const OLLAMA_URL   = 'http://localhost:11434';
const E2E_MODEL    = 'qwen3:1.7b';    // smallest available; already pulled
const E2E_TIMEOUT  = 60_000;          // real inference can take up to 60s

// Minimal body that gets a text response from qwen3 without burning tokens on thinking.
const IDENTITY_PROMPT = 'what is your model name, where were you born, model id and who is your maker?';
const MSG_BODY = {
  messages: [{ role: 'user', content: IDENTITY_PROMPT }],
  max_tokens: 2000,
  stream: false,
  thinking: { type: 'disabled' },
};

// ── Probe ──────────────────────────────────────────────────────────────────

function probeOllama(timeoutMs = 2000) {
  return new Promise(resolve => {
    const u = new URL(OLLAMA_URL);
    const req = http.request(
      { hostname: u.hostname, port: Number(u.port) || 11434, path: '/api/tags', method: 'GET' },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const models = (body.models || []).map(m => m.name);
            resolve({ available: true, models });
          } catch {
            resolve({ available: false, models: [] });
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ available: false, models: [] }); });
    req.on('error', () => resolve({ available: false, models: [] }));
    req.end();
  });
}

// ── Skip counter ───────────────────────────────────────────────────────────

let _skipped = 0;
function skip(reason) {
  console.log(`  SKIP  ${reason}`);
  _skipped++;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseResolvedVia(headers) {
  const raw = headers['x-c-thru-resolved-via'];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function textContent(json) {
  if (!json || !Array.isArray(json.content)) return '';
  return json.content.filter(c => c.type === 'text').map(c => c.text).join('');
}

// ── Fixture config ─────────────────────────────────────────────────────────

function buildConfig() {
  return {
    backends: {
      ollama: { kind: 'ollama', url: OLLAMA_URL },
    },
    model_routes: {
      [E2E_MODEL]: 'ollama',
    },
    llm_profiles: {
      '16gb': {
        workhorse: {
          connected_model:  `${E2E_MODEL}@ollama`,
          disconnect_model: `${E2E_MODEL}@ollama`,
        },
      },
    },
    agent_to_capability: {
      'test-agent': 'workhorse',
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  const probe = await probeOllama();
  if (!probe.available) {
    skip('Ollama not reachable at localhost:11434 — skipping all E2E tests');
    console.log(`\n0/0 passed (${_skipped} skipped)`);
    process.exit(0);
  }
  if (!probe.models.includes(E2E_MODEL)) {
    skip(`${E2E_MODEL} not pulled — run: ollama pull ${E2E_MODEL}`);
    console.log(`\n0/0 passed (${_skipped} skipped)`);
    process.exit(0);
  }
  console.log(`Ollama reachable. ${probe.models.length} models present. Using: ${E2E_MODEL}\n`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-e2e-'));
  const configPath = writeConfig(tmpDir, buildConfig());

  const proxyEnv = {
    CLAUDE_PROXY_ANNOTATE_MODEL: '1',
  };

  // ── Test 1: Direct model routing ──────────────────────────────────────────
  console.log('1. Direct model routing (qwen3:1.7b via model_routes → Ollama)');
  await withProxy({ configPath, profile: '16gb', env: proxyEnv }, async ({ port }) => {
    const body = Object.assign({ model: E2E_MODEL }, MSG_BODY);
    const r = await httpJson(port, 'POST', '/v1/messages', body, {}, E2E_TIMEOUT);

    assert(r.status === 200, `direct route: status 200 (got ${r.status})`);
    assert(r.json && r.json.type === 'message', 'direct route: response type === message');
    assert(r.json && r.json.model === E2E_MODEL, `direct route: response model === ${E2E_MODEL}`);

    const text = textContent(r.json);
    assert(text.length > 0, 'direct route: text content is non-empty');

    // No capability alias used → x-c-thru-resolved-via absent
    const via = parseResolvedVia(r.headers);
    assert(via === null, 'direct route: x-c-thru-resolved-via absent (no capability)');

    // ANNOTATE_MODEL=1 → x-claude-proxy-served-by present
    assert(
      r.headers['x-c-thru-served-by'] === E2E_MODEL,
      `direct route: x-c-thru-served-by === ${E2E_MODEL}`
    );
  });

  // ── Test 2: Capability alias → resolved model → response headers ──────────
  console.log('\n2. Capability alias (workhorse → qwen3:1.7b) + response header validation');
  await withProxy({ configPath, profile: '16gb', env: { ...proxyEnv, CLAUDE_LLM_MODE: 'connected' } }, async ({ port }) => {
    const body = Object.assign({ model: 'workhorse' }, MSG_BODY);
    const r = await httpJson(port, 'POST', '/v1/messages', body, {}, E2E_TIMEOUT);

    assert(r.status === 200, `capability alias: status 200 (got ${r.status})`);
    assert(r.json && r.json.type === 'message', 'capability alias: response type === message');
    assert(r.json && r.json.model === E2E_MODEL, `capability alias: response model === ${E2E_MODEL}`);

    const text = textContent(r.json);
    assert(text.length > 0, 'capability alias: text content is non-empty');

    const via = parseResolvedVia(r.headers);
    assert(via !== null, 'capability alias: x-c-thru-resolved-via header present');
    assert(via && via.served_by === E2E_MODEL,
      `capability alias: x-c-thru-resolved-via.served_by === ${E2E_MODEL} (got ${via && via.served_by})`);
    assert(via && via.capability === 'workhorse',
      `capability alias: x-c-thru-resolved-via.capability === workhorse (got ${via && via.capability})`);

    assert(
      r.headers['x-c-thru-served-by'] === E2E_MODEL,
      `capability alias: x-c-thru-served-by === ${E2E_MODEL}`
    );
  });

  // ── Test 3: agent_to_capability chain + response headers ─────────────────
  console.log('\n3. agent_to_capability chain (test-agent → workhorse → qwen3:1.7b)');
  await withProxy({ configPath, profile: '16gb', env: { ...proxyEnv, CLAUDE_LLM_MODE: 'connected' } }, async ({ port }) => {
    const body = Object.assign({ model: 'test-agent' }, MSG_BODY);
    const r = await httpJson(port, 'POST', '/v1/messages', body, {}, E2E_TIMEOUT);

    assert(r.status === 200, `agent chain: status 200 (got ${r.status})`);
    assert(r.json && r.json.model === E2E_MODEL, `agent chain: response model === ${E2E_MODEL}`);

    const text = textContent(r.json);
    assert(text.length > 0, 'agent chain: text content is non-empty');

    const via = parseResolvedVia(r.headers);
    assert(via && via.served_by === E2E_MODEL,
      `agent chain: x-c-thru-resolved-via.served_by === ${E2E_MODEL}`);
    assert(via && via.capability === 'workhorse',
      `agent chain: x-c-thru-resolved-via.capability === workhorse`);
  });

  // ── Test 4: offline mode routes to disconnect_model ───────────────────────
  console.log('\n4. Offline mode (workhorse → disconnect_model)');
  await withProxy({ configPath, profile: '16gb', env: { ...proxyEnv, CLAUDE_LLM_MODE: 'offline' } }, async ({ port }) => {
    const body = Object.assign({ model: 'workhorse' }, MSG_BODY);
    const r = await httpJson(port, 'POST', '/v1/messages', body, {}, E2E_TIMEOUT);

    assert(r.status === 200, `offline: status 200 (got ${r.status})`);

    const via = parseResolvedVia(r.headers);
    assert(via && via.served_by === E2E_MODEL,
      `offline: x-c-thru-resolved-via.served_by === ${E2E_MODEL} (disconnect_model)`);
    assert(via && via.capability === 'workhorse',
      'offline: x-c-thru-resolved-via.capability === workhorse');
  });

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const failed = summary();
  if (_skipped) console.log(`(${_skipped} skipped)`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
