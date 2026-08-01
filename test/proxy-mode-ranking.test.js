#!/usr/bin/env node
'use strict';
// Multi-mode model selection tests: verifies that a config with distinct models
// per (capability × mode × tier) routes to the exact expected model for each combo.
//
// This tests the routing invariant at scale — that mode selection in the proxy
// correctly picks the cell at llm_profiles[cap][mode][tier] for every combination.
//
// Coverage: 3 capabilities × 5 modes × 3 tiers = 45 combinations.
// Each combination uses a uniquely-named model so wrong routing is immediately obvious.
//
// Run: node test/proxy-mode-ranking.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, stubBackend,
} = require('./helpers');

console.log('proxy multi-mode model selection tests\n');

const CAPS  = ['workhorse', 'judge', 'coder'];
const MODES = ['best-cloud', 'best-local-oss', 'best-cloud-oss', 'best-cloud-gov', 'best-local-gov'];
const TIERS = ['16gb', '64gb', '128gb'];

// Mode suffix used in model name encoding
const MODE_SUFFIX = {
  'best-cloud':     'cloud',
  'best-local-oss': 'loco',
  'best-cloud-oss': 'oss',
  'best-cloud-gov': 'gov',
  'best-local-gov': 'lgov',
};

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-rank-'));
  const stub = await stubBackend();

  try {
    // Build a fixture config where each (cap, mode, tier) has a uniquely-named model.
    // Model name encodes all three dimensions so wrong routing is self-evident.
    const llm_profiles = {};
    const model_routes = {};

    for (const cap of CAPS) {
      llm_profiles[cap] = {};
      for (const mode of MODES) {
        llm_profiles[cap][mode] = {};
        for (const tier of TIERS) {
          const modelName = `${cap}-${tier}-${MODE_SUFFIX[mode]}`;
          llm_profiles[cap][mode][tier] = `${modelName}@stub`;
          model_routes[modelName] = 'stub';
        }
      }
    }

    const config = {
      backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
      model_routes,
      llm_profiles,
    };
    const configPath = writeConfig(tmpDir, config);

    const send = (port, model) => httpJson(port, 'POST', '/v1/messages', {
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    }, {});

    const parseVia = r => {
      try { return JSON.parse(r.headers['x-c-thru-resolved-via'] || '{}'); } catch { return {}; }
    };

    // ── Test 1: every (mode × cap × tier) combo routes to the expected model ─
    console.log('1. all (mode × capability × tier) combos route to the correct cell');
    let combos = 0;
    for (const tier of TIERS) {
      for (const mode of MODES) {
        await withProxy({ configPath, profile: tier, mode }, async ({ port }) => {
          for (const cap of CAPS) {
            const expected = `${cap}-${tier}-${MODE_SUFFIX[mode]}`;
            const r = await send(port, cap);
            assertEq(r.status, 200, `${cap}/${tier}/${mode}: status 200`);
            const via = parseVia(r);
            assertEq(via.served_by, expected,
              `${cap}/${tier}/${mode}: served_by=${expected}`);
            assertEq(via.capability, cap,
              `${cap}/${tier}/${mode}: capability=${cap}`);
            assertEq(via.mode, mode,
              `${cap}/${tier}/${mode}: header.mode=${mode}`);
            assertEq(via.tier, tier,
              `${cap}/${tier}/${mode}: header.tier=${tier}`);
            combos++;
          }
        });
      }
    }
    console.log(`  (verified ${combos} combos)`);

    // ── Test 2: mode fallback — best-cloud-only cap falls back in other modes ─
    // If a capability only has 'best-cloud' entries, resolveProfileModel falls
    // back to best-cloud for all other modes. Test that behavior end-to-end.
    console.log('\n2. mode fallback: capability with only best-cloud falls back for other modes');
    {
      const bareConfig = {
        backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
        model_routes: { 'bare-64gb-cloud': 'stub' },
        llm_profiles: {
          bare: {
            'best-cloud': { '64gb': 'bare-64gb-cloud@stub' },
            // No other modes — all fall back to best-cloud
          },
        },
      };
      const barePath = writeConfig(tmpDir, bareConfig);
      for (const mode of MODES) {
        await withProxy({ configPath: barePath, profile: '64gb', mode }, async ({ port }) => {
          const r = await send(port, 'bare');
          assertEq(r.status, 200, `bare/${mode}: status 200`);
          const via = parseVia(r);
          assertEq(via.served_by, 'bare-64gb-cloud',
            `bare/${mode}: falls back to best-cloud model (got ${via.served_by})`);
        });
      }
    }

  } finally {
    await stub.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
