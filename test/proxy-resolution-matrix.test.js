#!/usr/bin/env node
'use strict';
// End-to-end model resolution matrix: tiers × modes × capability aliases.
// Spawns a real proxy + stub backend; asserts the concrete model that hits
// the wire (stub.lastRequest().model_used) matches what pure-function tests predict.
//
// Coverage:
//   - All 5 hw tiers (16gb/32gb/48gb/64gb/128gb) × connected + offline
//   - modes[] sub-map: semi-offload + cloud-judge-only via judge profile
//   - agent_to_capability chain: "test-agent" → workhorse → concrete model
//
// Run with: node test/proxy-resolution-matrix.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, summary,
  stubBackend, writeConfig,
  httpJson, withProxy,
} = require('./helpers');

console.log('proxy-resolution-matrix integration tests\n');

// ── Fixture helpers ────────────────────────────────────────────────────────

// Build a tier profile entry. Model names encode tier+capability+mode for
// unambiguous assertion: e.g. "wh-64gb-conn@stub".
function profileEntry(cap, tier, stubSuffix) {
  const base = `${cap}-${tier}`;
  const entry = {
    connected_model:  `${base}-conn@${stubSuffix}`,
    disconnect_model: `${base}-disc@${stubSuffix}`,
  };
  // judge gets explicit modes[] entries so semi-offload and cloud-judge-only
  // select different models than connected/offline.
  if (cap === 'judge') {
    entry.modes = {
      'semi-offload':      `${base}-semi@${stubSuffix}`,
      'cloud-judge-only':  `${base}-cjo@${stubSuffix}`,
    };
  }
  return entry;
}

const TIERS       = ['16gb', '32gb', '48gb', '64gb', '128gb'];
const CAPABILITIES = ['workhorse', 'judge', 'deep-coder'];

// Build the full fixture config given a running stub port.
function buildFixtureConfig(stubPort) {
  const stubSuffix = 'stub';
  const llm_profiles = {};
  for (const tier of TIERS) {
    llm_profiles[tier] = {};
    for (const cap of CAPABILITIES) {
      llm_profiles[tier][cap] = profileEntry(cap, tier, stubSuffix);
    }
  }
  return {
    backends: {
      stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    llm_profiles,
    agent_to_capability: {
      'test-agent': 'workhorse',
    },
  };
}

// Minimal Anthropic-format request body (non-streaming).
const MSG_BODY = {
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 1,
};

// ── Test runner ────────────────────────────────────────────────────────────

async function runMatrix(stub, configPath) {
  // ── 1. Tier × mode matrix (workhorse, judge, deep-coder) ───────────────
  console.log('1. Tier × mode matrix');
  for (const tier of TIERS) {
    for (const [mode, suffix] of [['connected', 'conn'], ['offline', 'disc']]) {
      await withProxy(
        { configPath, profile: tier, env: { CLAUDE_LLM_MODE: mode } },
        async ({ port }) => {
          for (const cap of CAPABILITIES) {
            const body = Object.assign({ model: cap }, MSG_BODY);
            await httpJson(port, 'POST', '/v1/messages', body);
            const req = stub.lastRequest();
            const expected = `${cap}-${tier}-${suffix}`;
            assert(
              req && req.model_used === expected,
              `tier=${tier} mode=${mode} cap=${cap} → model_used=${expected} (got ${req && req.model_used})`
            );
            assert(
              req && req.serving_url && req.serving_url.includes('/v1/messages'),
              `serving_url contains /v1/messages for ${cap}@${tier}/${mode}`
            );
          }
        }
      );
    }
  }

  // ── 2. modes[] sub-map: semi-offload and cloud-judge-only ──────────────
  console.log('\n2. modes[] sub-map (64gb × semi-offload + cloud-judge-only)');
  for (const [mode, suffix] of [['semi-offload', 'semi'], ['cloud-judge-only', 'cjo']]) {
    await withProxy(
      { configPath, profile: '64gb', env: { CLAUDE_LLM_MODE: mode } },
      async ({ port }) => {
        const body = Object.assign({ model: 'judge' }, MSG_BODY);
        await httpJson(port, 'POST', '/v1/messages', body);
        const req = stub.lastRequest();
        const expected = `judge-64gb-${suffix}`;
        assert(
          req && req.model_used === expected,
          `tier=64gb mode=${mode} cap=judge → model_used=${expected} (got ${req && req.model_used})`
        );
      }
    );
  }

  // ── 3. agent_to_capability chain ────────────────────────────────────────
  console.log('\n3. agent_to_capability chain (test-agent → workhorse)');
  await withProxy(
    { configPath, profile: '64gb', env: { CLAUDE_LLM_MODE: 'connected' } },
    async ({ port }) => {
      const body = Object.assign({ model: 'test-agent' }, MSG_BODY);
      await httpJson(port, 'POST', '/v1/messages', body);
      const req = stub.lastRequest();
      const expected = 'workhorse-64gb-conn';
      assert(
        req && req.model_used === expected,
        `agent=test-agent → workhorse → model_used=${expected} (got ${req && req.model_used})`
      );
      assert(
        req && req.serving_url.startsWith('http://127.0.0.1:'),
        `agent chain request reached stub at ${req && req.serving_url}`
      );
    }
  );
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-matrix-'));
  let stub;

  try {
    stub = await stubBackend();
    const config = buildFixtureConfig(stub.port);
    const configPath = writeConfig(tmpDir, config);

    await runMatrix(stub, configPath);
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
