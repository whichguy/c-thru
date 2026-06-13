#!/usr/bin/env node
'use strict';
// Node port of preflight-model-readiness.test.sh. Unit-tests the
// preflight_model_readiness() routing skeleton, extracted into the fixture
// test/stubs/preflight-skeleton.sh (kept in sync with tools/c-thru by
// contract-check Check 10) with the real ollama pull/warm replaced by
// `echo PULL:<model>`.
//
// Serves the proxy's /v1/active-models and Ollama's /api/tags via in-process
// startStubServer; drives the skeleton with async spawnCapture (NOT spawnSync —
// that would block the event loop and the in-process stubs could never answer).
//
// Run: node test/preflight-model-readiness.test.js

const path = require('path');
const {
  assert, assertEq, summary, getFreePort, startStubServer, spawnCapture,
} = require('./helpers');

const SKELETON = path.join(__dirname, 'stubs', 'preflight-skeleton.sh');

console.log('preflight-model-readiness (Node port: /v1/active-models → PULL decisions)\n');

// Run the skeleton against a proxy port + optional OLLAMA_URL. Returns trimmed
// stdout (the PULL:<model> lines, if any).
async function runPreflight(proxyPort, ollamaUrl, extraEnv = {}) {
  const env = Object.assign({}, process.env, extraEnv);
  if (ollamaUrl) env.OLLAMA_URL = ollamaUrl; else delete env.OLLAMA_URL;
  const r = await spawnCapture('bash', [SKELETON, String(proxyPort != null ? proxyPort : '')],
    { env, timeout: 15000 });
  return (r.stdout || '').trim();
}

async function main() {
  // ── Test 1: all models already pulled — no PULL output ───────────────────
  console.log('Test 1: all models already pulled — no output');
  {
    const proxy = await startStubServer({ 'GET /v1/active-models':
      '{"tier":"64gb","mode":"connected","local_models":["modelA:7b","modelB:13b"]}' });
    const ollama = await startStubServer({ 'GET /api/tags':
      '{"models":[{"name":"modelA:7b"},{"name":"modelB:13b"},{"name":"other:1b"}]}' });
    const out = await runPreflight(proxy.port, ollama.url);
    assertEq(out, '', 'all-present: no PULL output');
    await proxy.close(); await ollama.close();
  }

  // ── Test 2: one model missing — PULL output for that model ────────────────
  console.log('Test 2: one model missing — PULL emitted');
  {
    const proxy = await startStubServer({ 'GET /v1/active-models':
      '{"tier":"64gb","mode":"connected","local_models":["modelA:7b","missing:30b"]}' });
    const ollama = await startStubServer({ 'GET /api/tags':
      '{"models":[{"name":"modelA:7b"}]}' });
    const out = await runPreflight(proxy.port, ollama.url);
    assert(out.includes('PULL:missing:30b'), `missing model: PULL:missing:30b emitted (got ${JSON.stringify(out)})`);
    await proxy.close(); await ollama.close();
  }

  // ── Test 3: all models missing — PULL for each ────────────────────────────
  console.log('Test 3: all models missing — PULL for each');
  {
    const proxy = await startStubServer({ 'GET /v1/active-models':
      '{"tier":"64gb","mode":"offline","local_models":["x:7b","y:13b"]}' });
    const ollama = await startStubServer({ 'GET /api/tags': '{"models":[]}' });
    const out = await runPreflight(proxy.port, ollama.url);
    const lines = out.split('\n');
    assertEq(lines.filter(l => l === 'PULL:x:7b').length, 1, 'all-missing: PULL:x:7b present once');
    assertEq(lines.filter(l => l === 'PULL:y:13b').length, 1, 'all-missing: PULL:y:13b present once');
    await proxy.close(); await ollama.close();
  }

  // ── Test 4: C_THRU_SKIP_PREFLIGHT=1 — no calls made ──────────────────────
  console.log('Test 4: C_THRU_SKIP_PREFLIGHT=1 — skipped entirely');
  {
    const proxy = await startStubServer({ 'GET /v1/active-models':
      '{"tier":"64gb","mode":"connected","local_models":["gone:99b"]}' });
    const ollama = await startStubServer({ 'GET /api/tags': '{"models":[]}' });
    const out = await runPreflight(proxy.port, ollama.url, { C_THRU_SKIP_PREFLIGHT: '1' });
    assertEq(out, '', 'skip-preflight: no PULL output');
    await proxy.close(); await ollama.close();
  }

  // ── Test 5: empty proxy port — silently skips ─────────────────────────────
  console.log('Test 5: empty port — silently returns');
  {
    const out = await runPreflight('', '');
    assertEq(out, '', 'empty-port: no output');
  }

  // ── Test 6: proxy unreachable — silently skips ────────────────────────────
  console.log('Test 6: proxy unreachable — silently returns');
  {
    const closed = await getFreePort();   // bound-then-freed → definitively closed
    const out = await runPreflight(closed, '');
    assertEq(out, '', 'proxy-unreachable: no output');
  }

  // ── Test 7: Ollama unreachable — silently skips ───────────────────────────
  console.log('Test 7: Ollama unreachable — silently returns');
  {
    const proxy = await startStubServer({ 'GET /v1/active-models':
      '{"tier":"64gb","mode":"connected","local_models":["model:7b"]}' });
    const closedOllama = await getFreePort();
    const out = await runPreflight(proxy.port, `http://127.0.0.1:${closedOllama}`);
    assertEq(out, '', 'ollama-unreachable: no output');
    await proxy.close();
  }

  // ── Test 8: no local_models in response — silently skips ──────────────────
  console.log('Test 8: empty local_models array — nothing to pull');
  {
    const proxy = await startStubServer({ 'GET /v1/active-models':
      '{"tier":"64gb","mode":"connected","local_models":[]}' });
    const ollama = await startStubServer({ 'GET /api/tags': '{"models":[]}' });
    const out = await runPreflight(proxy.port, ollama.url);
    assertEq(out, '', 'empty-local-models: no PULL');
    await proxy.close(); await ollama.close();
  }

  // ── Test 9: @backend sigil stripped from model name ───────────────────────
  console.log('Test 9: @backend sigil stripped before comparing');
  {
    const proxy = await startStubServer({ 'GET /v1/active-models':
      '{"tier":"64gb","mode":"connected","local_models":["model:7b@stub"]}' });
    const ollama = await startStubServer({ 'GET /api/tags': '{"models":[]}' });
    const out = await runPreflight(proxy.port, ollama.url);
    assert(out.split('\n').includes('PULL:model:7b'),
      `sigil-stripped: PULL:model:7b (bare, @stub removed) (got ${JSON.stringify(out)})`);
    await proxy.close(); await ollama.close();
  }

  // ── Test 10: cloud-only session — no local_models — skips pull ────────────
  console.log('Test 10: cloud-only session (no local models)');
  {
    const proxy = await startStubServer({ 'GET /v1/active-models':
      '{"tier":"48gb","mode":"connected","local_models":[]}' });
    const ollama = await startStubServer({ 'GET /api/tags': '{"models":[]}' });
    const out = await runPreflight(proxy.port, ollama.url);
    assertEq(out, '', 'cloud-only: no PULL');
    await proxy.close(); await ollama.close();
  }
}

main()
  .then(() => process.exit(summary() ? 1 : 0))
  .catch(err => { console.error(err); process.exit(1); });
