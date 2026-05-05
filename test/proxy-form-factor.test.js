#!/usr/bin/env node
'use strict';
// Form-factor × mode × capability matrix with stub backend.
// Passes --profile <tier> to the proxy and asserts the stub receives the
// correct concrete model, and the x-c-thru-resolved-via response header
// confirms both served_by and capability for every combination.
//
// Coverage: 5 form factors × 5 connectivity modes × 6 capabilities = 150 combos.
// Includes a "bare" capability (only best-cloud; other modes fall back to best-cloud)
// to exercise the mode-fallback path.
//
// Run with: node test/proxy-form-factor.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, summary,
  stubBackend, writeConfig, httpJson, withProxy,
} = require('./helpers');

console.log('proxy-form-factor matrix tests\n');

// ── Dimensions ─────────────────────────────────────────────────────────────

const TIERS = ['16gb', '32gb', '48gb', '64gb', '128gb'];

// 5 canonical modes. bareSuffix: what "bare" capability resolves to (falls
// back to best-cloud for all modes since it only has a best-cloud entry).
const MODES = [
  { mode: 'best-cloud',     suffix: 'cloud', bareSuffix: 'cloud' },
  { mode: 'best-cloud-oss', suffix: 'oss',   bareSuffix: 'cloud' },  // bare falls back to best-cloud
  { mode: 'best-local-oss', suffix: 'loco',  bareSuffix: 'cloud' },  // bare falls back to best-cloud
  { mode: 'best-cloud-gov', suffix: 'gov',   bareSuffix: 'cloud' },  // bare falls back to best-cloud
  { mode: 'best-local-gov', suffix: 'lgov',  bareSuffix: 'cloud' },  // bare falls back to best-cloud
];

// 6 capabilities: 5 full (all modes present) + 1 bare (only best-cloud).
const CAPABILITIES = [
  { name: 'workhorse', tag: 'wh'   },
  { name: 'judge',     tag: 'jdg'  },
  { name: 'coder',     tag: 'cdr'  },
  { name: 'explorer',  tag: 'expl' },
  { name: 'reviewer',  tag: 'rev'  },
  { name: 'bare',      tag: 'bare' },  // only best-cloud — others fall back to it
];

// ── Fixture helpers ─────────────────────────────────────────────────────────

// Concrete model name for a given (cap tag, tier, mode suffix) — no @sigil.
function modelName(tag, tier, suffix) {
  return `${tag}-${tier}-${suffix}`;
}

// Profile entry for one capability in the new schema:
// llm_profiles[capability][mode][tier] = concrete model string.
function profileEntry(tag) {
  const entry = {};
  for (const { mode, suffix } of MODES) {
    entry[mode] = {};
    for (const tier of TIERS) {
      entry[mode][tier] = `${modelName(tag, tier, suffix)}@stub`;
    }
  }
  return entry;
}

function buildConfig(stubPort) {
  const llm_profiles = {};
  for (const { name, tag } of CAPABILITIES) {
    if (name === 'bare') {
      // Only best-cloud — other modes fall back to best-cloud via resolveProfileModel.
      const bestCloud = {};
      for (const tier of TIERS) {
        bestCloud[tier] = `bare-${tier}-cloud@stub`;
      }
      llm_profiles[name] = { 'best-cloud': bestCloud };
    } else {
      llm_profiles[name] = profileEntry(tag);
    }
  }
  return {
    backends: {
      stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    llm_profiles,
  };
}

// Minimal request body.
const MSG_BODY = {
  messages: [{ role: 'user', content: 'what is your model name?' }],
  max_tokens: 10,
};

function parseResolvedVia(headers) {
  const raw = headers['x-c-thru-resolved-via'];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-ff-'));
  let stub;

  try {
    stub = await stubBackend();
    const configPath = writeConfig(tmpDir, buildConfig(stub.port));

    const proxyEnv = { CLAUDE_PROXY_ANNOTATE_MODEL: '1' };

    for (const tier of TIERS) {
      console.log(`\n── form factor: ${tier} ──────────────────────────────`);

      for (const { mode, suffix, bareSuffix } of MODES) {
        console.log(`  mode: ${mode}`);

        await withProxy(
          { configPath, profile: tier, mode, env: proxyEnv },
          async ({ port }) => {
            for (const { name, tag } of CAPABILITIES) {
              const expected = name === 'bare'
                ? modelName('bare', tier, bareSuffix)
                : modelName(tag, tier, suffix);

              const body = Object.assign({ model: name }, MSG_BODY);
              const r = await httpJson(port, 'POST', '/v1/messages', body);

              // 1. Stub received the correct concrete model on the wire.
              const req = stub.lastRequest();
              assert(
                req && req.model_used === expected,
                `${tier}/${mode}/${name}: stub model_used=${expected} (got ${req && req.model_used})`
              );

              // 2. x-c-thru-resolved-via header confirms served_by and capability.
              const via = parseResolvedVia(r.headers);
              assert(
                via && via.served_by === expected,
                `${tier}/${mode}/${name}: x-c-thru-resolved-via.served_by=${expected} (got ${via && via.served_by})`
              );
              assert(
                via && via.capability === name,
                `${tier}/${mode}/${name}: x-c-thru-resolved-via.capability=${name} (got ${via && via.capability})`
              );
            }
          }
        );
      }
    }

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
