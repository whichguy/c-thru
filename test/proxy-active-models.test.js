#!/usr/bin/env node
'use strict';
// Integration tests for GET /v1/active-models proxy endpoint.
// Verifies tier/mode resolution, local vs cloud filtering, and mode-switching.
// Run with: node test/proxy-active-models.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { assert, assertEq, summary, writeConfig, httpJson, withProxy } = require('./helpers');

console.log('proxy-active-models endpoint tests\n');

// ── Fixture config ─────────────────────────────────────────────────────────
// Two local models and one cloud model across two capabilities.
// model_routes distinguishes local vs cloud.

function buildConfig({ tier = '64gb', extra = {} } = {}) {
  return Object.assign({
    model_routes: {
      'local-a:7b':   'ollama_local',
      'local-b:13b':  'ollama_local',
      'cloud-x:big':  'anthropic',
      'local-c:70b':  'ollama_local',
    },
    llm_profiles: {
      [tier]: {
        workhorse: {
          connected_model:  'cloud-x:big',
          disconnect_model: 'local-a:7b',
        },
        coder: {
          connected_model:  'local-b:13b',
          disconnect_model: 'local-b:13b',
        },
        judge: {
          connected_model:  'cloud-x:big',
          disconnect_model: 'local-c:70b',
          cloud_best_model: 'cloud-x:big',
          local_best_model: 'local-c:70b',
          modes: {
            'semi-offload':    'cloud-x:big',
            'cloud-judge-only': 'cloud-x:big',
          },
        },
      },
    },
  }, extra);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-am-'));

  try {

    // ── Test 1: connected mode — cloud models excluded from local_models ─────
    console.log('1. connected mode: cloud models not in local_models');
    await withProxy(
      { configPath: writeConfig(tmpDir, buildConfig()), profile: '64gb', mode: 'connected' },
      async ({ port }) => {
        const r = await httpJson(port, 'GET', '/v1/active-models');
        assertEq(r.status, 200, 'status 200');
        assertEq(r.json?.tier, '64gb', 'tier');
        assertEq(r.json?.mode, 'connected', 'mode');
        assert(Array.isArray(r.json?.capabilities), 'capabilities is array');
        assert(Array.isArray(r.json?.local_models), 'local_models is array');

        // In connected mode: workhorse→cloud-x, coder→local-b, judge→cloud-x
        // cloud-x is anthropic → not in local_models
        const localModels = r.json.local_models;
        assert(!localModels.includes('cloud-x:big'), 'cloud model excluded from local_models');
        assert(localModels.includes('local-b:13b'), 'local coder in local_models');

        // capabilities array has an entry per profile key
        const caps = r.json.capabilities.map(c => c.capability);
        assert(caps.includes('workhorse'), 'workhorse in capabilities');
        assert(caps.includes('coder'), 'coder in capabilities');
        assert(caps.includes('judge'), 'judge in capabilities');

        // workhorse connected_model is cloud-x — local: false
        const wh = r.json.capabilities.find(c => c.capability === 'workhorse');
        assertEq(wh?.model, 'cloud-x:big', 'workhorse model in connected');
        assertEq(wh?.local, false, 'workhorse local=false for cloud model');

        // coder connected_model is local-b — local: true
        const coder = r.json.capabilities.find(c => c.capability === 'coder');
        assertEq(coder?.model, 'local-b:13b', 'coder model');
        assertEq(coder?.local, true, 'coder local=true');
      }
    );

    // ── Test 2: offline mode — uses disconnect_model, only local models ──────
    console.log('\n2. offline mode: local_models contains all offline models');
    await withProxy(
      { configPath: writeConfig(tmpDir, buildConfig()), profile: '64gb', mode: 'offline' },
      async ({ port }) => {
        const r = await httpJson(port, 'GET', '/v1/active-models');
        assertEq(r.json?.mode, 'offline', 'mode=offline');
        const localModels = r.json.local_models;
        assert(localModels.includes('local-a:7b'), 'workhorse disconnect in local_models');
        assert(localModels.includes('local-b:13b'), 'coder disconnect in local_models');
        assert(localModels.includes('local-c:70b'), 'judge disconnect in local_models');
        assert(!localModels.includes('cloud-x:big'), 'cloud model absent in offline');

        const wh = r.json.capabilities.find(c => c.capability === 'workhorse');
        assertEq(wh?.model, 'local-a:7b', 'workhorse uses disconnect_model in offline');
      }
    );

    // ── Test 3: local-best-quality — uses local_best_model ──────────────────
    console.log('\n3. local-best-quality mode: uses local_best_model');
    await withProxy(
      { configPath: writeConfig(tmpDir, buildConfig()), profile: '64gb', mode: 'local-best-quality' },
      async ({ port }) => {
        const r = await httpJson(port, 'GET', '/v1/active-models');
        assertEq(r.json?.mode, 'local-best-quality', 'mode=local-best-quality');
        const j = r.json.capabilities.find(c => c.capability === 'judge');
        // judge has local_best_model=local-c:70b
        assertEq(j?.model, 'local-c:70b', 'judge uses local_best_model');
      }
    );

    // ── Test 4: cloud-judge-only — modes[] override for judge ────────────────
    console.log('\n4. cloud-judge-only: judge uses modes[cloud-judge-only] override');
    await withProxy(
      { configPath: writeConfig(tmpDir, buildConfig()), profile: '64gb', mode: 'cloud-judge-only' },
      async ({ port }) => {
        const r = await httpJson(port, 'GET', '/v1/active-models');
        assertEq(r.json?.mode, 'cloud-judge-only', 'mode=cloud-judge-only');
        const j = r.json.capabilities.find(c => c.capability === 'judge');
        // judge.modes['cloud-judge-only'] = cloud-x:big
        assertEq(j?.model, 'cloud-x:big', 'judge overridden to cloud via modes[]');
        assertEq(j?.local, false, 'cloud-judge-only model is not local');
        // coder has no modes[] override → falls back to disconnect_model
        const c = r.json.capabilities.find(c => c.capability === 'coder');
        assertEq(c?.model, 'local-b:13b', 'coder falls back to disconnect_model');
      }
    );

    // ── Test 5: deduplication — same model used by multiple capabilities ─────
    console.log('\n5. local_models is deduplicated when multiple caps share a model');
    const sharedConfig = buildConfig();
    // Make coder use same model as workhorse in offline mode
    sharedConfig.llm_profiles['64gb'].coder.disconnect_model = 'local-a:7b';
    await withProxy(
      { configPath: writeConfig(tmpDir, sharedConfig), profile: '64gb', mode: 'offline' },
      async ({ port }) => {
        const r = await httpJson(port, 'GET', '/v1/active-models');
        const count = r.json.local_models.filter(m => m === 'local-a:7b').length;
        assertEq(count, 1, 'local-a:7b appears exactly once despite multiple caps using it');
      }
    );

    // ── Test 6: thin config (one capability) and no-profiles-for-tier case ──
    console.log('\n6a. thin config: single-capability tier resolves correctly');
    const thinConfig = {
      model_routes: { 'tiny:1b': 'ollama_local' },
      llm_profiles: {
        '128gb': { workhorse: { connected_model: 'tiny:1b', disconnect_model: 'tiny:1b' } },
      },
    };
    await withProxy(
      { configPath: writeConfig(tmpDir, thinConfig), profile: '128gb', mode: 'connected' },
      async ({ port }) => {
        const r = await httpJson(port, 'GET', '/v1/active-models');
        assertEq(r.status, 200, 'status 200 for thin config');
        assert(r.json?.local_models?.includes('tiny:1b'), 'tiny:1b in local_models');
        assertEq(r.json?.capabilities?.length, 1, 'exactly 1 capability entry');
      }
    );

    console.log('\n6b. tier with no profiles: returns empty capabilities and local_models');
    // Config has profiles for 64gb only; force proxy to 128gb so profiles[128gb] is undefined.
    await withProxy(
      { configPath: writeConfig(tmpDir, buildConfig({ tier: '64gb' })), profile: '128gb', mode: 'connected' },
      async ({ port }) => {
        const r = await httpJson(port, 'GET', '/v1/active-models');
        assertEq(r.status, 200, 'status 200 when tier has no profiles');
        assertEq(r.json?.capabilities?.length, 0, 'empty capabilities for missing tier');
        assertEq(r.json?.local_models?.length, 0, 'empty local_models for missing tier');
      }
    );

    // ── Test 7: /ping and /v1/active-models agree on tier and mode ───────────
    console.log('\n7. /ping and /v1/active-models report same tier and mode');
    await withProxy(
      { configPath: writeConfig(tmpDir, buildConfig()), profile: '64gb', mode: 'offline' },
      async ({ port }) => {
        const [ping, am] = await Promise.all([
          httpJson(port, 'GET', '/ping'),
          httpJson(port, 'GET', '/v1/active-models'),
        ]);
        assertEq(ping.json?.active_tier, am.json?.tier, '/ping tier matches /v1/active-models tier');
        assertEq(ping.json?.active_mode, am.json?.mode, '/ping mode matches /v1/active-models mode');
      }
    );

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
