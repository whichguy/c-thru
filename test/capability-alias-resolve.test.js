#!/usr/bin/env node
'use strict';
// 2-hop graph traversal tests for capability alias resolution.
// Focuses on: production config completeness, edge cases not in resolve-capability.test.js.
// Run: node test/capability-alias-resolve.test.js

const fs   = require('fs');
const path = require('path');
const {
  resolveCapabilityAlias,
  resolveProfileModel,
  resolveLlmMode,
} = require('../tools/model-map-resolve.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    failed++;
  }
}

const PROD_CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'model-map.json');
const PROD_CONFIG = JSON.parse(fs.readFileSync(PROD_CONFIG_PATH, 'utf8'));

// Helper: strip @backend sigil from a model name.
function stripSigil(model) {
  if (typeof model !== 'string') return model;
  const m = model.match(/^(.+)@[A-Za-z0-9_-]+$/);
  return m ? m[1] : model;
}

// ── 1. Every agent in production agent_to_capability resolves to a non-null alias ──
console.log('1. All production agents → non-null capability alias (at each declared tier)');
{
  const a2c = PROD_CONFIG.agent_to_capability || {};
  const tiers = Object.keys(PROD_CONFIG.llm_profiles || {});
  assert(Object.keys(a2c).length > 0, `agent_to_capability is non-empty in production config (got ${Object.keys(a2c).length})`);
  assert(tiers.length > 0, `llm_profiles declares at least one tier (got ${tiers.length})`);
  let allResolved = true;
  for (const [agent, expectedAlias] of Object.entries(a2c)) {
    for (const tier of tiers) {
      const alias = resolveCapabilityAlias(agent, PROD_CONFIG, tier);
      if (alias === null) {
        console.error(`  FAIL  ${agent} @ ${tier} → null (expected alias '${expectedAlias}')`);
        failed++;
        allResolved = false;
      } else {
        passed++;
      }
    }
  }
  if (allResolved) console.log(`  (all ${Object.keys(a2c).length} agents × ${tiers.length} tiers resolved)`);
}

// ── 2. Full chain: every agent → alias → concrete model at each tier ──────────
console.log('\n2. Full chain: agent → alias → concrete model (non-empty string)');
{
  const a2c = PROD_CONFIG.agent_to_capability || {};
  const tiers = Object.keys(PROD_CONFIG.llm_profiles || {});
  const modes = ['connected', 'offline'];
  let combos = 0;
  let misses = 0;
  for (const [agent] of Object.entries(a2c)) {
    for (const tier of tiers) {
      const alias = resolveCapabilityAlias(agent, PROD_CONFIG, tier);
      if (!alias) continue;
      const tierProfile = (PROD_CONFIG.llm_profiles || {})[tier] || {};
      const entry = tierProfile[alias];
      if (!entry) continue; // alias not declared in this tier — ok
      for (const mode of modes) {
        const model = resolveProfileModel(entry, mode);
        const stripped = stripSigil(model);
        if (typeof stripped === 'string' && stripped.length > 0) {
          combos++;
        } else {
          console.error(`  FAIL  ${agent} → ${alias} @ ${tier} / ${mode} → empty model`);
          misses++;
          failed++;
        }
      }
    }
  }
  if (misses === 0) {
    console.log(`  PASS  all ${combos} agent×tier×mode combos yield non-empty model`);
    passed++;
  }
}

// ── 3. Unknown agent → null (not silent fallback) ─────────────────────────────
console.log('\n3. Unknown agent → resolveCapabilityAlias returns null');
{
  const result = resolveCapabilityAlias('completely-unknown-agent-xyz', PROD_CONFIG, '64gb');
  assert(result === null, `unknown agent → null (got: ${JSON.stringify(result)})`);
}

// ── 4. Direct alias passthrough — known profile key is identity ───────────────
console.log('\n4. Direct capability alias used as model name → identity');
{
  const fixtureCfg = { llm_profiles: { '64gb': { judge: { connected_model: 'j', disconnect_model: 'j' } } } };
  assert(resolveCapabilityAlias('judge', fixtureCfg, '64gb') === 'judge', `judge → judge (identity) (got ${resolveCapabilityAlias('judge', fixtureCfg, '64gb')})`);
  assert(resolveCapabilityAlias('workhorse', fixtureCfg, '64gb') === 'workhorse', `workhorse → workhorse (static set) (got ${resolveCapabilityAlias('workhorse', fixtureCfg, '64gb')})`);
}

// ── 5. model_overrides field declared in production config ────────────────────
console.log('\n5. model_overrides field in production config has valid structure');
{
  const overrides = PROD_CONFIG.model_overrides;
  if (overrides) {
    let allValid = true;
    for (const [from, to] of Object.entries(overrides)) {
      if (typeof to !== 'string' || !to || from === to) {
        console.error(`  FAIL  model_overrides.${from} → '${to}' is invalid`);
        failed++;
        allValid = false;
      }
    }
    if (allValid) {
      console.log(`  PASS  model_overrides has ${Object.keys(overrides).length} valid entries`);
      passed++;
    }
  } else {
    console.log('  PASS  model_overrides absent (optional — OK)');
    passed++;
  }
}

// ── 6. on_failure: production judge entries use hard_fail ────────────────────
console.log('\n6. on_failure field values are well-formed in production config');
{
  const validValues = new Set(['cascade', 'hard_fail']);
  const profiles = PROD_CONFIG.llm_profiles || {};
  let checked = 0;
  let badCount = 0;
  for (const [tier, tierProfile] of Object.entries(profiles)) {
    for (const [alias, entry] of Object.entries(tierProfile)) {
      if (entry && entry.on_failure !== undefined) {
        if (!validValues.has(entry.on_failure)) {
          console.error(`  FAIL  ${alias}@${tier}.on_failure='${entry.on_failure}' is not cascade|hard_fail`);
          badCount++;
          failed++;
        }
        checked++;
      }
    }
  }
  assert(badCount === 0, `all ${checked} on_failure values are cascade or hard_fail (got ${badCount} bad)`);
}

// ── 7. @backend sigil stripping ───────────────────────────────────────────────
console.log('\n7. @backend sigil stripping from model names');
{
  assert(stripSigil('mymodel@ollama_local') === 'mymodel', `@ollama_local stripped (got ${stripSigil('mymodel@ollama_local')})`);
  assert(stripSigil('qwen3:1.7b@cloud_backend') === 'qwen3:1.7b', `@cloud_backend stripped (got ${stripSigil('qwen3:1.7b@cloud_backend')})`);
  assert(stripSigil('plain-model') === 'plain-model', `no sigil unchanged (got ${stripSigil('plain-model')})`);
  assert(stripSigil('model@') === 'model@', `trailing @ alone not stripped (invalid sigil) (got ${stripSigil('model@')})`);
}

// ── 8. Synthetic: agent_to_capability → missing tier gracefully handled ────────
console.log('\n8. Agent on tier where alias has no profile entry → resolveProfileModel handles null entry');
{
  const cfg = {
    llm_profiles: { '16gb': { workhorse: { connected_model: 'wh', disconnect_model: 'wh' } } },
    agent_to_capability: { 'my-agent': 'deep-coder' },
  };
  const alias = resolveCapabilityAlias('my-agent', cfg, '16gb');
  assert(alias === 'deep-coder', `alias resolves even when tier lacks the profile entry (got ${alias})`);
  const entry = (cfg.llm_profiles['16gb'] || {})['deep-coder']; // undefined
  const model = resolveProfileModel(entry, 'connected');
  assert(model === null, `resolveProfileModel(undefined, mode) → null (no crash) (got ${model})`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
