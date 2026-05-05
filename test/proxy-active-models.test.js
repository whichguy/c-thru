#!/usr/bin/env node
'use strict';
// Integration tests for GET /v1/active-models proxy endpoint.
// Verifies tier/mode resolution, local vs cloud filtering, and mode-switching.
// Uses new capability-outer llm_profiles schema.
// Run with: node test/proxy-active-models.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { assert, assertEq, summary, writeConfig, httpJson, withProxy } = require('./helpers');

console.log('proxy-active-models endpoint tests\n');

// ── Fixture config ─────────────────────────────────────────────────────────
// Two local models and one cloud model across three capabilities.
// model_routes + backends distinguish local vs cloud.

function buildConfig({ tier = '64gb', extra = {} } = {}) {
  return Object.assign({
    backends: {
      ollama_local: { kind: 'ollama',    url: 'http://localhost:11434' },
      anthropic:    { kind: 'anthropic', url: 'https://api.anthropic.com' },
    },
    model_routes: {
      'local-a:7b':  'ollama_local',
      'local-b:13b': 'ollama_local',
      'cloud-x:big': 'anthropic',
      'local-c:70b': 'ollama_local',
    },
    llm_profiles: {
      workhorse: {
        'best-cloud':     { [tier]: 'cloud-x:big' },
        'best-local-oss': { [tier]: 'local-a:7b'  },
      },
      coder: {
        'best-cloud':     { [tier]: 'local-b:13b' },
        'best-local-oss': { [tier]: 'local-b:13b' },
      },
      judge: {
        'best-cloud':     { [tier]: 'cloud-x:big' },
        'best-local-oss': { [tier]: 'local-c:70b' },
      },
    },
  }, extra);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-am-'));

  try {

    // ── Test 1: best-cloud mode — cloud models excluded from local_models ─────
    console.log('1. best-cloud mode: cloud models not in local_models');
    await withProxy(
      { configPath: writeConfig(tmpDir, buildConfig()), profile: '64gb', mode: 'best-cloud' },
      async ({ port }) => {
        const r = await httpJson(port, 'GET', '/v1/active-models');
        assertEq(r.status, 200, 'status 200');
        assertEq(r.json?.tier, '64gb', 'tier');
        assertEq(r.json?.mode, 'best-cloud', 'mode');
        assert(Array.isArray(r.json?.capabilities), 'capabilities is array');
        assert(Array.isArray(r.json?.local_models), 'local_models is array');

        // workhorse→cloud-x (cloud), coder→local-b (local), judge→cloud-x (cloud)
        const localModels = r.json.local_models;
        assert(!localModels.includes('cloud-x:big'), 'cloud model excluded from local_models');
        assert(localModels.includes('local-b:13b'), 'local coder model in local_models');

        const caps = r.json.capabilities.map(c => c.capability);
        assert(caps.includes('workhorse'), 'workhorse in capabilities');
        assert(caps.includes('coder'), 'coder in capabilities');
        assert(caps.includes('judge'), 'judge in capabilities');

        const wh = r.json.capabilities.find(c => c.capability === 'workhorse');
        assertEq(wh?.model, 'cloud-x:big', 'workhorse model in best-cloud');
        assertEq(wh?.local, false, 'workhorse local=false for cloud model');

        const coder = r.json.capabilities.find(c => c.capability === 'coder');
        assertEq(coder?.model, 'local-b:13b', 'coder model');
        assertEq(coder?.local, true, 'coder local=true');
      }
    );

    // ── Test 2: best-local-oss mode — only local models ──────────────────────
    console.log('\n2. best-local-oss mode: all models local, cloud model absent');
    await withProxy(
      { configPath: writeConfig(tmpDir, buildConfig()), profile: '64gb', mode: 'best-local-oss' },
      async ({ port }) => {
        const r = await httpJson(port, 'GET', '/v1/active-models');
        assertEq(r.json?.mode, 'best-local-oss', 'mode=best-local-oss');
        const localModels = r.json.local_models;
        assert(localModels.includes('local-a:7b'), 'workhorse local model in local_models');
        assert(localModels.includes('local-b:13b'), 'coder local model in local_models');
        assert(localModels.includes('local-c:70b'), 'judge local model in local_models');
        assert(!localModels.includes('cloud-x:big'), 'cloud model absent in best-local-oss');

        const wh = r.json.capabilities.find(c => c.capability === 'workhorse');
        assertEq(wh?.model, 'local-a:7b', 'workhorse uses best-local-oss slot');
        assertEq(wh?.local, true, 'workhorse local=true in best-local-oss');

        const j = r.json.capabilities.find(c => c.capability === 'judge');
        assertEq(j?.model, 'local-c:70b', 'judge uses best-local-oss slot');
      }
    );

    // ── Test 3: mode fallback — missing mode falls back to best-cloud ─────────
    console.log('\n3. mode fallback: missing best-cloud-oss falls back to best-cloud');
    await withProxy(
      { configPath: writeConfig(tmpDir, buildConfig()), profile: '64gb', mode: 'best-cloud-oss' },
      async ({ port }) => {
        const r = await httpJson(port, 'GET', '/v1/active-models');
        // Config has no best-cloud-oss entries; resolveProfileModel falls back to best-cloud
        const wh = r.json.capabilities.find(c => c.capability === 'workhorse');
        assertEq(wh?.model, 'cloud-x:big', 'workhorse falls back to best-cloud when best-cloud-oss absent');
        const j = r.json.capabilities.find(c => c.capability === 'judge');
        assertEq(j?.model, 'cloud-x:big', 'judge falls back to best-cloud when best-cloud-oss absent');
      }
    );

    // ── Test 4: deduplication — same model used by multiple capabilities ──────
    console.log('\n4. local_models is deduplicated when multiple caps share a model');
    const sharedCfg = buildConfig();
    // Make workhorse share local-b:13b with coder in best-local-oss mode
    sharedCfg.llm_profiles.workhorse['best-local-oss'] = { '64gb': 'local-b:13b' };
    await withProxy(
      { configPath: writeConfig(tmpDir, sharedCfg), profile: '64gb', mode: 'best-local-oss' },
      async ({ port }) => {
        const r = await httpJson(port, 'GET', '/v1/active-models');
        const count = r.json.local_models.filter(m => m === 'local-b:13b').length;
        assertEq(count, 1, 'local-b:13b appears exactly once despite multiple caps using it');
      }
    );

    // ── Test 5: thin config (one capability) resolves correctly ───────────────
    console.log('\n5. thin config: single-capability resolves correctly');
    const thinConfig = {
      backends: { ollama_local: { kind: 'ollama', url: 'http://localhost:11434' } },
      model_routes: { 'tiny:1b': 'ollama_local' },
      llm_profiles: {
        workhorse: { 'best-cloud': { '128gb': 'tiny:1b' } },
      },
    };
    await withProxy(
      { configPath: writeConfig(tmpDir, thinConfig), profile: '128gb', mode: 'best-cloud' },
      async ({ port }) => {
        const r = await httpJson(port, 'GET', '/v1/active-models');
        assertEq(r.status, 200, 'status 200 for thin config');
        assert(r.json?.local_models?.includes('tiny:1b'), 'tiny:1b in local_models');
        assertEq(r.json?.capabilities?.length, 1, 'exactly 1 capability entry');
        const wh = r.json.capabilities.find(c => c.capability === 'workhorse');
        assertEq(wh?.model, 'tiny:1b', 'thin config capability model correct');
        assertEq(wh?.local, true, 'ollama model is local');
      }
    );

    // ── Test 6: empty llm_profiles → empty capabilities and local_models ──────
    console.log('\n6. empty llm_profiles: returns empty capabilities and local_models');
    const emptyCfg = {
      backends: { stub: { kind: 'anthropic', url: 'https://api.anthropic.com' } },
      llm_profiles: {},
    };
    await withProxy(
      { configPath: writeConfig(tmpDir, emptyCfg), profile: '64gb', mode: 'best-cloud' },
      async ({ port }) => {
        const r = await httpJson(port, 'GET', '/v1/active-models');
        assertEq(r.status, 200, 'status 200 for empty profiles');
        assertEq(r.json?.capabilities?.length, 0, 'empty capabilities');
        assertEq(r.json?.local_models?.length, 0, 'empty local_models');
      }
    );

    // ── Test 7: /ping and /v1/active-models agree on tier and mode ────────────
    console.log('\n7. /ping and /v1/active-models report same tier and mode');
    await withProxy(
      { configPath: writeConfig(tmpDir, buildConfig()), profile: '64gb', mode: 'best-local-oss' },
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
