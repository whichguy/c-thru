#!/usr/bin/env node
'use strict';
// Tests for GET /v1/probe-llm[?model=<name>]
// Run: node test/proxy-probe-llm.test.js

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  assert, assertEq, summary,
  writeConfig, withProxy, ollamaStubBackend, httpJson,
} = require('./helpers');

console.log('proxy /v1/probe-llm tests\n');

function probeConfig(stubPort, modelName = 'probe-model') {
  return {
    backends: {
      probe_stub: { kind: 'ollama', url: `http://127.0.0.1:${stubPort}` },
    },
    routes: { default: modelName },
    model_routes: { [modelName]: 'probe_stub' },
    llm_profiles: {
      '128gb': {
        workhorse: { connected_model: modelName, disconnect_model: modelName },
      },
    },
  };
}

const stubChunks = [
  { message: { content: 'I am TestBot, made by StubCo.', thinking: '' } },
  { done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 10 },
];

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-probe-'));

  try {
    // ── Test 1: default model (no ?model param) ─────────────────────────────
    console.log('1. default model — uses routes.default');
    {
      const stub = await ollamaStubBackend(stubChunks);
      try {
        const configPath = writeConfig(tmpDir, probeConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'GET', '/v1/probe-llm');
          assertEq(r.status, 200, 'status 200');
          assertEq(r.body.ok, true, 'ok: true');
          assertEq(r.body.model_used, 'probe-model', 'model_used matches');
          assertEq(r.body.backend, 'probe_stub', 'backend id present');
          assert(typeof r.body.response === 'string' && r.body.response.length > 0, 'response is non-empty string');
          assert(typeof r.body.elapsed_ms === 'number', 'elapsed_ms is a number');
        });
      } finally { await stub.close(); }
    }

    // ── Test 2: ?model query param overrides default ─────────────────────────
    console.log('2. ?model=custom-model — overrides default route');
    {
      const stub = await ollamaStubBackend(stubChunks);
      try {
        const cfg = {
          backends: { probe_stub: { kind: 'ollama', url: `http://127.0.0.1:${stub.port}` } },
          routes: { default: 'other-model' },
          model_routes: {
            'other-model': 'probe_stub',
            'custom-model': 'probe_stub',
          },
          llm_profiles: {
            '128gb': { workhorse: { connected_model: 'other-model', disconnect_model: 'other-model' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'GET', '/v1/probe-llm?model=custom-model');
          assertEq(r.status, 200, 'status 200');
          assertEq(r.body.model_used, 'custom-model', 'model_used is the override');
        });
      } finally { await stub.close(); }
    }

    // ── Test 3: no default route and no ?model → 400 ─────────────────────────
    console.log('3. no model, no default route → 400');
    {
      const stub = await ollamaStubBackend(stubChunks);
      try {
        const cfg = {
          backends: { probe_stub: { kind: 'ollama', url: `http://127.0.0.1:${stub.port}` } },
          model_routes: { 'some-model': 'probe_stub' },
          llm_profiles: {
            '128gb': { workhorse: { connected_model: 'some-model', disconnect_model: 'some-model' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'GET', '/v1/probe-llm');
          assertEq(r.status, 400, 'status 400');
          assertEq(r.body.ok, false, 'ok: false');
          assert(typeof r.body.error === 'string', 'error message present');
        });
      } finally { await stub.close(); }
    }

    // ── Test 4: ?model resolves to unknown model → 400 ───────────────────────
    console.log('4. ?model=nonexistent → 400 (model not in routes)');
    {
      const stub = await ollamaStubBackend(stubChunks);
      try {
        const configPath = writeConfig(tmpDir, probeConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'GET', '/v1/probe-llm?model=nonexistent-xyz');
          assertEq(r.status, 400, 'status 400');
          assertEq(r.body.ok, false, 'ok: false');
        });
      } finally { await stub.close(); }
    }

    // ── Test 5: stub returns non-200 → 502 ───────────────────────────────────
    console.log('5. ollama returns 404 → 502');
    {
      const badStub = await new Promise((resolve, reject) => {
        const s = http.createServer((req, res) => {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'model not found' }));
        });
        s.listen(0, '127.0.0.1', () => resolve(s));
        s.on('error', reject);
      });
      try {
        const cfg = {
          backends: { bad_stub: { kind: 'ollama', url: `http://127.0.0.1:${badStub.address().port}` } },
          routes: { default: 'probe-model' },
          model_routes: { 'probe-model': 'bad_stub' },
          llm_profiles: { '128gb': { workhorse: { connected_model: 'probe-model', disconnect_model: 'probe-model' } } },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'GET', '/v1/probe-llm');
          assertEq(r.status, 502, 'status 502');
          assertEq(r.body.ok, false, 'ok: false');
        });
      } finally { await new Promise(r => badStub.close(r)); }
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  summary();
}

main().catch(e => { console.error(e); process.exit(1); });
