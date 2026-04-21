#!/usr/bin/env node
'use strict';
// Form-factor × mode × capability matrix with stub backend.
// Passes --profile <tier> to the proxy and asserts the stub receives the
// correct concrete model, and the x-c-thru-resolved-via response header
// confirms both served_by and capability for every combination.
//
// Coverage: 5 form factors × 4 connectivity modes × 8 capabilities = 160 combos.
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

// All four connectivity modes and their profile suffix.
const MODES = [
  { mode: 'connected',       suffix: 'conn' },
  { mode: 'offline',         suffix: 'disc' },
  { mode: 'semi-offload',    suffix: 'semi' },
  { mode: 'cloud-judge-only', suffix: 'cjo'  },
];

// Capabilities: static LLM_PROFILE_ALIASES + key agentic-system profile keys.
// Short tag kept to ≤4 chars so model names stay readable in assertion output.
const CAPABILITIES = [
  { name: 'workhorse',    tag: 'wh'   },
  { name: 'judge',        tag: 'jdg'  },
  { name: 'deep-coder',   tag: 'dc'   },
  { name: 'orchestrator', tag: 'orch' },
  { name: 'classifier',   tag: 'clf'  },
  { name: 'explorer',     tag: 'expl' },
  { name: 'reviewer',     tag: 'rev'  },
  { name: 'coder',        tag: 'cdr'  },
];

// ── Fixture helpers ─────────────────────────────────────────────────────────

// Concrete model name for a given (cap tag, tier, mode suffix) — no @sigil.
function modelName(tag, tier, suffix) {
  return `${tag}-${tier}-${suffix}`;
}

// Profile entry for one capability in one tier.
// Every capability gets all four modes[] entries so the fixture is uniform.
function profileEntry(tag, tier) {
  return {
    connected_model:  `${modelName(tag, tier, 'conn')}@stub`,
    disconnect_model: `${modelName(tag, tier, 'disc')}@stub`,
    modes: {
      'semi-offload':      `${modelName(tag, tier, 'semi')}@stub`,
      'cloud-judge-only':  `${modelName(tag, tier, 'cjo')}@stub`,
    },
  };
}

function buildConfig(stubPort) {
  const llm_profiles = {};
  for (const tier of TIERS) {
    llm_profiles[tier] = {};
    for (const { name, tag } of CAPABILITIES) {
      llm_profiles[tier][name] = profileEntry(tag, tier);
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

      for (const { mode, suffix } of MODES) {
        console.log(`  mode: ${mode}`);

        await withProxy(
          { configPath, profile: tier, env: { ...proxyEnv, CLAUDE_LLM_MODE: mode } },
          async ({ port }) => {
            for (const { name, tag } of CAPABILITIES) {
              const expected = modelName(tag, tier, suffix);
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

              // 3. x-claude-proxy-served-by header matches.
              assert(
                r.headers['x-claude-proxy-served-by'] === expected,
                `${tier}/${mode}/${name}: x-claude-proxy-served-by=${expected}`
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
