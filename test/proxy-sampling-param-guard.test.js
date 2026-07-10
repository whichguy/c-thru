#!/usr/bin/env node
'use strict';
// Tests for capability_sampling_defaults injection guard on Anthropic models
// that reject proxy-supplied sampling parameters.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  stubBackend, writeConfig, httpJson, spawnProxy, waitForPing,
} = require('./helpers');

console.log('proxy-sampling-param-guard tests\n');

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function buildConfig(stubPort, overrides = {}) {
  const base = {
    llm_active_profile: '16gb',
    llm_mode: 'best-cloud',
    backends: {
      stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    model_routes: {
      'claude-fable-5': 'stub',
      'claude-sonnet-4-6': 'stub',
      'my-model-alpha': 'stub',
    },
    llm_profiles: {
      planner: {
        'best-cloud': { '16gb': 'claude-fable-5' },
      },
      legacy_planner: {
        'best-cloud': { '16gb': 'claude-sonnet-4-6' },
      },
      custom_guard: {
        'best-cloud': { '16gb': 'my-model-alpha' },
      },
    },
    capability_sampling_defaults: {
      planner: { temperature: 1, top_p: 0.95, top_k: 40 },
      legacy_planner: { temperature: 0.4, top_p: 0.8, top_k: 20 },
      custom_guard: { temperature: 0.6, top_p: 0.75, top_k: 10 },
    },
    agent_to_capability: {},
  };
  return Object.assign({}, base, overrides);
}

function msgBody(model, extra = {}) {
  return Object.assign({
    model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 10,
  }, extra);
}

function killAndWait(child, signal = 'SIGTERM') {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.on('exit', finish);
    try { child.kill(signal); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(); }, 3000);
  });
}

async function withSamplingProxy(configOverrides, fn) {
  const stub = await stubBackend();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-sampling-'));
  const configPath = writeConfig(tmpHome, buildConfig(stub.port, configOverrides));
  let child;
  try {
    const spawned = await spawnProxy({ configPath, tmpHome });
    child = spawned.child;
    await waitForPing(spawned.port, 5000);
    await fn({ port: spawned.port, stub });
  } finally {
    if (child) await killAndWait(child);
    try { await stub.close(); } catch {}
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }
}

async function postMessage(port, body) {
  return httpJson(port, 'POST', '/v1/messages', body, {
    'x-api-key': 'test',
    'anthropic-version': '2023-06-01',
  });
}

async function testBuiltInRejectsInjectedDefaults() {
  console.log('Test A: claude-fable-5 skips proxy-injected sampling defaults');
  await withSamplingProxy({}, async ({ port, stub }) => {
    const { status } = await postMessage(port, msgBody('planner'));
    assertEq(status, 200, 'Test A: /v1/messages returned 200');

    const req = stub.lastRequest();
    assertEq(req.model_used, 'claude-fable-5', 'Test A: resolved model reached stub');
    assert(!hasOwn(req.body, 'temperature'), 'Test A: temperature not injected');
    assert(!hasOwn(req.body, 'top_p'), 'Test A: top_p not injected');
    assert(!hasOwn(req.body, 'top_k'), 'Test A: top_k not injected');
  });
}

async function testOlderAnthropicStillGetsDefaults() {
  console.log('\nTest B: older Anthropic model still receives capability defaults');
  await withSamplingProxy({}, async ({ port, stub }) => {
    const { status } = await postMessage(port, msgBody('legacy_planner'));
    assertEq(status, 200, 'Test B: /v1/messages returned 200');

    const req = stub.lastRequest();
    assertEq(req.model_used, 'claude-sonnet-4-6', 'Test B: resolved model reached stub');
    assertEq(req.body.temperature, 0.4, 'Test B: temperature injected from defaults');
    assertEq(req.body.top_p, 0.8, 'Test B: top_p injected from defaults');
  });
}

async function testCallerSuppliedSamplingIsNotStripped() {
  console.log('\nTest C: caller-supplied temperature survives on rejecting model');
  await withSamplingProxy({}, async ({ port, stub }) => {
    const { status } = await postMessage(port, msgBody('planner', { temperature: 0.123 }));
    assertEq(status, 200, 'Test C: /v1/messages returned 200');

    const req = stub.lastRequest();
    assertEq(req.model_used, 'claude-fable-5', 'Test C: resolved model reached stub');
    assertEq(req.body.temperature, 0.123, 'Test C: caller temperature forwarded verbatim');
    assert(!hasOwn(req.body, 'top_p'), 'Test C: proxy top_p default not injected');
    assert(!hasOwn(req.body, 'top_k'), 'Test C: proxy top_k default not injected');
  });
}

async function testConfigExtendsGuardList() {
  console.log('\nTest D: sampling_unsupported_models extends guard list');
  await withSamplingProxy({ sampling_unsupported_models: ['my-model'] }, async ({ port, stub }) => {
    const { status } = await postMessage(port, msgBody('custom_guard'));
    assertEq(status, 200, 'Test D: /v1/messages returned 200');

    const req = stub.lastRequest();
    assertEq(req.model_used, 'my-model-alpha', 'Test D: resolved model reached stub');
    assert(!hasOwn(req.body, 'temperature'), 'Test D: temperature not injected by config prefix');
    assert(!hasOwn(req.body, 'top_p'), 'Test D: top_p not injected by config prefix');
    assert(!hasOwn(req.body, 'top_k'), 'Test D: top_k not injected by config prefix');
  });
}

(async () => {
  try {
    await testBuiltInRejectsInjectedDefaults();
    await testOlderAnthropicStillGetsDefaults();
    await testCallerSuppliedSamplingIsNotStripped();
    await testConfigExtendsGuardList();
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    const failed = summary();
    process.exit(failed || process.exitCode ? 1 : 0);
  }
})();
