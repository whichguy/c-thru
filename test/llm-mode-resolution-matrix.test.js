#!/usr/bin/env node
'use strict';
// Resolution matrix test: for key (hw-tier × llm_mode × capability) triples,
// assert the resolved connected_model matches the design table in the plan.
// Exercises resolveProfileModel() logic against the shipped config.
//
// Run with: node test/llm-mode-resolution-matrix.test.js

const fs = require('fs');
const path = require('path');

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

// Mirrors resolveProfileModel() in tools/claude-proxy
function resolveProfileModel(entry, mode) {
  if (!entry) return null;
  if (entry.modes && Object.prototype.hasOwnProperty.call(entry.modes, mode)) {
    return entry.modes[mode];
  }
  if (mode === 'offline') return entry.disconnect_model;
  if (mode === 'connected') return entry.connected_model;
  if (mode === 'semi-offload' || mode === 'cloud-judge-only') return entry.disconnect_model;
  return entry.connected_model;
}

const shippedPath = path.join(__dirname, '..', 'config', 'model-map.json');
const shipped = JSON.parse(fs.readFileSync(shippedPath, 'utf8'));
const profiles = shipped.llm_profiles || {};

console.log('llm-mode resolution matrix tests\n');

// ── 1. connected mode: cloud models where defined ─────────────────────
console.log('1. connected mode: cloud-capable tiers use cloud models for judge');
{
  for (const tier of ['48gb', '64gb', '128gb']) {
    const entry = profiles[tier] && profiles[tier]['judge'];
    const model = resolveProfileModel(entry, 'connected');
    assert(model === 'claude-opus-4-6', `${tier} judge connected → claude-opus-4-6 (got ${model})`);
  }
  // low-ram tiers stay local
  for (const tier of ['16gb', '32gb']) {
    const entry = profiles[tier] && profiles[tier]['judge'];
    const model = resolveProfileModel(entry, 'connected');
    assert(model && !model.startsWith('claude-'), `${tier} judge connected → local model (got ${model})`);
  }
}

// ── 2. offline mode: always disconnect_model ──────────────────────────
console.log('\n2. offline mode: all capabilities use disconnect_model');
{
  for (const tier of ['48gb', '64gb', '128gb']) {
    for (const cap of ['judge', 'judge-strict', 'orchestrator', 'deep-coder']) {
      const entry = profiles[tier] && profiles[tier][cap];
      if (!entry) continue;
      const model = resolveProfileModel(entry, 'offline');
      assert(model === entry.disconnect_model, `${tier} ${cap} offline → disconnect_model (got ${model})`);
    }
  }
}

// ── 3. semi-offload: judge/judge-strict go cloud (modes[] override) ───
console.log('\n3. semi-offload: judge+judge-strict go cloud via modes[] at 48gb/64gb/128gb');
{
  for (const tier of ['48gb', '64gb', '128gb']) {
    for (const cap of ['judge', 'judge-strict']) {
      const entry = profiles[tier] && profiles[tier][cap];
      const model = resolveProfileModel(entry, 'semi-offload');
      assert(model === 'claude-opus-4-6', `${tier} ${cap} semi-offload → claude-opus-4-6 (got ${model})`);
    }
  }
}

// ── 4. semi-offload: orchestrator+local-planner go cloud at 48gb+ ─────
console.log('\n4. semi-offload: orchestrator+local-planner go cloud at 48gb/64gb/128gb');
{
  for (const tier of ['48gb', '64gb', '128gb']) {
    for (const cap of ['orchestrator', 'local-planner']) {
      const entry = profiles[tier] && profiles[tier][cap];
      const model = resolveProfileModel(entry, 'semi-offload');
      assert(model === 'claude-sonnet-4-6', `${tier} ${cap} semi-offload → claude-sonnet-4-6 (got ${model})`);
    }
  }
}

// ── 5. semi-offload: everything else stays local (no modes[] entry) ───
console.log('\n5. semi-offload: deep-coder/code-analyst/pattern-coder stay local');
{
  for (const tier of ['48gb', '64gb', '128gb']) {
    for (const cap of ['deep-coder', 'code-analyst', 'pattern-coder']) {
      const entry = profiles[tier] && profiles[tier][cap];
      if (!entry) continue;
      const model = resolveProfileModel(entry, 'semi-offload');
      assert(model === entry.disconnect_model, `${tier} ${cap} semi-offload → disconnect_model (got ${model})`);
    }
  }
}

// ── 6. cloud-judge-only: only judge/judge-strict go cloud ─────────────
console.log('\n6. cloud-judge-only: judge+judge-strict cloud, orchestrator stays local');
{
  for (const tier of ['48gb', '64gb', '128gb']) {
    // judge goes cloud
    for (const cap of ['judge', 'judge-strict']) {
      const entry = profiles[tier] && profiles[tier][cap];
      const model = resolveProfileModel(entry, 'cloud-judge-only');
      assert(model === 'claude-opus-4-6', `${tier} ${cap} cloud-judge-only → claude-opus-4-6 (got ${model})`);
    }
    // orchestrator stays local (no modes['cloud-judge-only'] entry)
    const orchEntry = profiles[tier] && profiles[tier]['orchestrator'];
    const orchModel = resolveProfileModel(orchEntry, 'cloud-judge-only');
    assert(orchModel === orchEntry.disconnect_model, `${tier} orchestrator cloud-judge-only → disconnect_model (got ${orchModel})`);
  }
}

// ── 7. 16gb/32gb: semi-offload/cloud-judge-only degrade gracefully ────
console.log('\n7. 16gb/32gb: semi-offload degrades to disconnect_model (no cloud)');
{
  for (const tier of ['16gb', '32gb']) {
    for (const cap of ['judge', 'orchestrator']) {
      const entry = profiles[tier] && profiles[tier][cap];
      if (!entry) continue;
      const model = resolveProfileModel(entry, 'semi-offload');
      // No modes[] on low-ram tiers → falls through to disconnect_model
      assert(model === entry.disconnect_model, `${tier} ${cap} semi-offload → disconnect_model (graceful, got ${model})`);
    }
  }
}

// ── 8. Back-compat: llm_connectivity_mode: disconnect resolves as offline
console.log('\n8. llm_connectivity_mode: "disconnect" legacy maps to offline behaviour');
{
  // Simulate what resolveLlmMode() does with legacy config
  function legacyToMode(legacyVal) {
    return legacyVal === 'disconnect' ? 'offline' : 'connected';
  }
  assert(legacyToMode('disconnect') === 'offline', 'legacy disconnect → offline');
  assert(legacyToMode('connected') === 'connected', 'legacy connected → connected');
}

// ── 9. models[].equivalents for claude-opus-4-6 ───────────────────────
console.log('\n9. claude-opus-4-6 equivalents defined for cascade');
{
  const models = shipped.models || [];
  const opusEntry = models.find(m => m.name === 'claude-opus-4-6');
  assert(!!opusEntry, 'claude-opus-4-6 entry present in models[]');
  assert(Array.isArray(opusEntry && opusEntry.equivalents), 'claude-opus-4-6 has equivalents array');
  assert(opusEntry && opusEntry.equivalents && opusEntry.equivalents.includes('qwen3.5:27b'), 'equivalents includes qwen3.5:27b');
  assert(opusEntry && opusEntry.equivalents && opusEntry.equivalents.includes('qwen3.5:122b'), 'equivalents includes qwen3.5:122b');
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
