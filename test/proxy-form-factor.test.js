#!/usr/bin/env node
'use strict';
// Form-factor × mode × capability matrix with stub backend.
// Passes --profile <tier> to the proxy and asserts the stub receives the
// correct concrete model, and the x-c-thru-resolved-via response header
// confirms both served_by and capability for every combination.
//
// Coverage: 5 form factors × 6 connectivity modes × 10 capabilities = 300 combos.
// Includes a "bare" capability (only connected/disconnect_model) and a "partial"
// capability (has cloud_best_model but no local_best_model and no modes[]) to
// exercise every combination of missing optional fields.
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

// All six connectivity modes with expected suffix overrides for sparse capabilities.
// bareSuffix:    "bare" has only connected/disconnect_model (no modes[], cloud_best, local_best)
// partialSuffix: "partial" has cloud_best_model but no local_best_model and no modes[]
const MODES = [
  { mode: 'connected',          suffix: 'conn', bareSuffix: 'conn', partialSuffix: 'conn' },
  { mode: 'offline',            suffix: 'disc', bareSuffix: 'disc', partialSuffix: 'disc' },
  { mode: 'local-only',         suffix: 'disc', bareSuffix: 'disc', partialSuffix: 'disc' }, // alias for offline
  { mode: 'semi-offload',       suffix: 'semi', bareSuffix: 'disc', partialSuffix: 'disc' }, // no modes[] → disconnect
  { mode: 'cloud-judge-only',   suffix: 'cjo',  bareSuffix: 'disc', partialSuffix: 'disc' }, // no modes[] → disconnect
  { mode: 'cloud-thinking',     suffix: 'cthk', bareSuffix: 'disc', partialSuffix: 'disc' }, // modes[cloud-thinking] present (cthk); no override → disconnect
  { mode: 'local-review',       suffix: 'lrev', bareSuffix: 'conn', partialSuffix: 'conn' }, // modes[local-review] present (lrev); no override → connected
  { mode: 'cloud-best-quality', suffix: 'cbq',  bareSuffix: 'conn', partialSuffix: 'cbq'  }, // cloud_best_model present → uses it
  { mode: 'local-best-quality', suffix: 'lbq',  bareSuffix: 'disc', partialSuffix: 'disc' }, // no local_best_model → disconnect
];

// Capabilities: static LLM_PROFILE_ALIASES + key agentic-system profile keys.
// Short tag kept to ≤4 chars so model names stay readable in assertion output.
// 'bare':    only connected/disconnect_model — all optional fields absent.
// 'partial': has cloud_best_model but no local_best_model and no modes[] — mixed sparse.
const CAPABILITIES = [
  { name: 'workhorse',    tag: 'wh'   },
  { name: 'judge',        tag: 'jdg'  },
  { name: 'deep-coder',   tag: 'dc'   },
  { name: 'orchestrator', tag: 'orch' },
  { name: 'classifier',   tag: 'clf'  },
  { name: 'explorer',     tag: 'expl' },
  { name: 'reviewer',     tag: 'rev'  },
  { name: 'coder',        tag: 'cdr'  },
  { name: 'bare',         tag: 'bare' },
  { name: 'partial',      tag: 'part' },
];

// ── Fixture helpers ─────────────────────────────────────────────────────────

// Concrete model name for a given (cap tag, tier, mode suffix) — no @sigil.
function modelName(tag, tier, suffix) {
  return `${tag}-${tier}-${suffix}`;
}

// Profile entry for one capability in one tier.
// Every capability gets all six modes[] entries so the fixture is uniform.
function profileEntry(tag, tier) {
  return {
    connected_model:  `${modelName(tag, tier, 'conn')}@stub`,
    disconnect_model: `${modelName(tag, tier, 'disc')}@stub`,
    cloud_best_model: `${modelName(tag, tier, 'cbq')}@stub`,
    local_best_model: `${modelName(tag, tier, 'lbq')}@stub`,
    modes: {
      'semi-offload':      `${modelName(tag, tier, 'semi')}@stub`,
      'cloud-judge-only':  `${modelName(tag, tier, 'cjo')}@stub`,
      'cloud-thinking':    `${modelName(tag, tier, 'cthk')}@stub`,
      'local-review':      `${modelName(tag, tier, 'lrev')}@stub`,
    },
  };
}

function buildConfig(stubPort) {
  const llm_profiles = {};
  for (const tier of TIERS) {
    llm_profiles[tier] = {};
    for (const { name, tag } of CAPABILITIES) {
      if (name === 'bare') {
        // Bare: only connected/disconnect — all optional fields absent.
        llm_profiles[tier][name] = {
          connected_model:  `bare-${tier}-conn@stub`,
          disconnect_model: `bare-${tier}-disc@stub`,
        };
      } else if (name === 'partial') {
        // Partial: has cloud_best_model but no local_best_model and no modes[].
        // cloud-best-quality → cloud_best_model (cbq); local-best-quality → disconnect (disc).
        llm_profiles[tier][name] = {
          connected_model:  `part-${tier}-conn@stub`,
          disconnect_model: `part-${tier}-disc@stub`,
          cloud_best_model: `part-${tier}-cbq@stub`,
        };
      } else {
        llm_profiles[tier][name] = profileEntry(tag, tier);
      }
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
  messages: [{ role: 'user', content: 'what is your model name, model id and who made you?' }],
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

      for (const { mode, suffix, bareSuffix, partialSuffix } of MODES) {
        console.log(`  mode: ${mode}`);

        await withProxy(
          { configPath, profile: tier, mode, env: proxyEnv },
          async ({ port }) => {
            for (const { name, tag } of CAPABILITIES) {
              let expected;
              if (name === 'bare') {
                expected = `bare-${tier}-${bareSuffix}`;
              } else if (name === 'partial') {
                expected = `part-${tier}-${partialSuffix}`;
              } else {
                expected = modelName(tag, tier, suffix);
              }
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

              // 3. x-c-thru-served-by header matches.
              assert(
                r.headers['x-c-thru-served-by'] === expected,
                `${tier}/${mode}/${name}: x-c-thru-served-by=${expected} (got ${r.headers['x-c-thru-served-by']})`
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
