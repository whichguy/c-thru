#!/usr/bin/env node
'use strict';
// Fixture-driven tests for the 5-mode × 5-tier × 12-agent pipeline schema.
// Run with: node test/model-map-v12-adapter.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLayeredConfig } = require('../tools/model-map-layered.js');
const { validateConfig } = require('../tools/model-map-validate.js');
const {
  resolveProfileModel,
  resolveLocalFallback,
  resolveCapabilityAlias,
  isChineseOrigin,
  MODEL_PIN_PREFIX,
  LLM_MODE_ENUM,
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

function withTmpFile(content, fn) {
  const p = path.join(os.tmpdir(), `v12-adapter-test-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(p, JSON.stringify(content));
    return fn(p);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
}

// Minimal valid new-schema config for use in fixtures
const MIN_CAPABILITY_ENTRY = {
  'best-cloud':     { '16gb': 'model-a', '32gb': 'model-a', '48gb': 'model-a', '64gb': 'model-a', '128gb': 'model-a' },
  'best-cloud-oss': { '16gb': 'model-a', '32gb': 'model-a', '48gb': 'model-a', '64gb': 'model-a', '128gb': 'model-a' },
  'best-local-oss': { '16gb': 'model-a', '32gb': 'model-a', '48gb': 'model-a', '64gb': 'model-a', '128gb': 'model-a' },
  'best-cloud-gov': { '16gb': 'model-a', '32gb': 'model-a', '48gb': 'model-a', '64gb': 'model-a', '128gb': 'model-a' },
  'best-local-gov': { '16gb': 'model-a', '32gb': 'model-a', '48gb': 'model-a', '64gb': 'model-a', '128gb': 'model-a' },
};

console.log('model-map-v12-adapter tests\n');

// ── Test 1: adapter fires on legacy shape (fallback_strategies) ────────
console.log('1. Adapter synthesizes v1.2 keys from legacy fallback_strategies');
{
  // New-format llm_profiles (capability-outer) alongside legacy fallback_strategies.
  // The adapter reads fallback_strategies → synthesizes models[]; reads llm_capabilities → synthesizes
  // tool_capability_to_profile. Neither relies on llm_profiles format.
  const legacy = {
    llm_profiles: {
      planner:    { ...MIN_CAPABILITY_ENTRY },
      classifier: { ...MIN_CAPABILITY_ENTRY },
      explorer:   { ...MIN_CAPABILITY_ENTRY },
    },
    llm_capabilities: {
      classify_intent: { model: 'classifier' },
      explore_local:   { model: 'explorer'   },
    },
    fallback_strategies: {
      'model-a': {
        event: {
          network_failure: ['model-b'],
          rate_limit:      ['model-b'],
        },
      },
      'model-x': {
        event: {
          network_failure: ['model-c', 'model-d'],
          rate_limit:      ['model-c'],
        },
      },
    },
    models: [],
    tool_capability_to_profile: null,
  };

  // Remove the pre-set tool_capability_to_profile so adapter fires
  delete legacy.tool_capability_to_profile;

  withTmpFile(legacy, (p) => {
    const { effective } = loadLayeredConfig(p, null);
    assert(!!effective.tool_capability_to_profile, 'tool_capability_to_profile synthesized');
    assert(effective.tool_capability_to_profile.classify_intent === 'classifier', 'classify_intent → classifier');
    assert(effective.tool_capability_to_profile.explore_local === 'explorer', 'explore_local → explorer');
    assert(Array.isArray(effective.models), 'models array synthesized');
    const aEntry = effective.models.find(m => m.name === 'model-a');
    assert(!!aEntry, 'model-a entry present');
    assert(Array.isArray(aEntry.equivalents) && aEntry.equivalents.includes('model-b'), 'model-a equivalents correct');
    const xEntry = effective.models.find(m => m.name === 'model-x');
    assert(!!xEntry, 'model-x entry present');
    assert(xEntry.equivalents.includes('model-c') && xEntry.equivalents.includes('model-d'), 'model-x equivalents union correct');
    assert(!!effective.fallback_strategies, 'fallback_strategies preserved for proxy');
  });
}

// ── Test 2: adapter does NOT fire when tool_capability_to_profile present ─
console.log('\n2. Adapter skips when tool_capability_to_profile already present');
{
  const v12 = {
    llm_profiles: {
      planner:    { ...MIN_CAPABILITY_ENTRY },
      classifier: { ...MIN_CAPABILITY_ENTRY },
    },
    tool_capability_to_profile: { classify_intent: 'classifier' },
    models: [{ name: 'model-a', equivalents: ['model-b'] }],
  };

  withTmpFile(v12, (p) => {
    const { effective } = loadLayeredConfig(p, null);
    assert(effective.tool_capability_to_profile.classify_intent === 'classifier', 'existing tool_capability_to_profile unchanged');
    assert(!effective.fallback_strategies, 'fallback_strategies absent on v1.2 config');
  });
}

// ── Test 3: warning fires at most once ─────────────────────────────────
console.log('\n3. Legacy-shape warning fires once per process');
{
  const legacy = {
    llm_profiles: { planner: { ...MIN_CAPABILITY_ENTRY } },
    fallback_strategies: { 'model-a': { event: { network_failure: ['model-b'] } } },
  };
  // The warning was already emitted in Test 1 — this call should be silent.
  const stderrChunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    if (typeof chunk === 'string' && chunk.includes('legacy fallback_strategies')) {
      stderrChunks.push(chunk);
      return true;
    }
    return origWrite(chunk, ...args);
  };
  withTmpFile(legacy, (p) => { loadLayeredConfig(p, null); });
  process.stderr.write = origWrite;
  assert(stderrChunks.length === 0, 'no duplicate warning emitted (module-scope guard works)');
}

// ── Test 4: shipped config validates ──────────────────────────────────
console.log('\n4. Shipped config/model-map.json passes validator');
{
  const shippedPath = path.join(__dirname, '..', 'config', 'model-map.json');
  try {
    const { validateConfig } = require('../tools/model-map-validate.js');
    const shipped = JSON.parse(fs.readFileSync(shippedPath, 'utf8'));
    const errors = [];
    validateConfig(shipped, errors);
    assert(errors.length === 0, 'shipped config validates with zero errors');
    assert(!shipped.fallback_strategies, 'fallback_strategies absent from shipped config');
    assert(!!shipped.tool_capability_to_profile, 'tool_capability_to_profile present in shipped config');
    assert(Array.isArray(shipped.models), 'models array present in shipped config');
  } catch (e) {
    assert(false, `shipped config read/validate failed: ${e.message}`);
  }
}

// ── Test 5: LLM_MODE_ENUM has exactly the 5 new modes ─────────────────
console.log('\n5. LLM_MODE_ENUM contains exactly the 5 new routing modes');
{
  const expected = ['best-cloud', 'best-cloud-oss', 'best-local-oss', 'best-cloud-gov', 'best-local-gov'];
  assert(LLM_MODE_ENUM.size === 5, 'LLM_MODE_ENUM has exactly 5 entries');
  for (const m of expected) {
    assert(LLM_MODE_ENUM.has(m), `LLM_MODE_ENUM contains '${m}'`);
  }
  for (const old of ['connected', 'offline', 'local-only', 'cloud-best-quality', 'best-opensource']) {
    assert(!LLM_MODE_ENUM.has(old), `LLM_MODE_ENUM does NOT contain old mode '${old}'`);
  }
}

// ── Test 6: resolveProfileModel — string value (tier-uniform) ──────────
console.log('\n6. resolveProfileModel: string mode value returns same model for all tiers');
{
  const entry = {
    'best-cloud': 'claude-opus-4-7',
    'best-local-oss': { '16gb': 'phi4-mini', '32gb': 'qwen3:14b', '48gb': 'qwen3:30b', '64gb': 'qwen3:30b', '128gb': 'qwen3:30b' },
  };
  for (const tier of ['16gb', '32gb', '48gb', '64gb', '128gb']) {
    assert(
      resolveProfileModel(entry, tier, 'best-cloud') === 'claude-opus-4-7',
      `tier ${tier}: best-cloud string value returns 'claude-opus-4-7'`,
    );
  }
  assert(resolveProfileModel(entry, '16gb', 'best-local-oss') === 'phi4-mini', '16gb: best-local-oss returns phi4-mini');
  assert(resolveProfileModel(entry, '32gb', 'best-local-oss') === 'qwen3:14b', '32gb: best-local-oss returns qwen3:14b');
  assert(resolveProfileModel(entry, '64gb', 'best-local-oss') === 'qwen3:30b', '64gb: best-local-oss returns qwen3:30b');
}

// ── Test 7: resolveProfileModel — fallback to best-cloud on missing mode ──
console.log('\n7. resolveProfileModel: falls back to best-cloud when mode not defined');
{
  const entry = {
    'best-cloud': { '16gb': 'claude-opus-4-7', '64gb': 'qwen3:30b' },
  };
  assert(
    resolveProfileModel(entry, '16gb', 'best-cloud-oss') === 'claude-opus-4-7',
    'missing best-cloud-oss at 16gb falls back to best-cloud value',
  );
  assert(
    resolveProfileModel(entry, '64gb', 'best-local-gov') === 'qwen3:30b',
    'missing best-local-gov at 64gb falls back to best-cloud value',
  );
  assert(
    resolveProfileModel(null, '64gb', 'best-cloud') === null,
    'null entry returns null',
  );
  assert(
    resolveProfileModel({}, '64gb', 'best-cloud') === null,
    'empty entry with no best-cloud returns null',
  );
}

// ── Test 8: isChineseOrigin filter ─────────────────────────────────────
console.log('\n8. isChineseOrigin correctly classifies models');
{
  const chinese = ['qwen3:30b', 'deepseek/deepseek-r2', 'moonshotai/kimi-k2', 'thudm/glm-4-plus', 'glm-4:latest'];
  const nonChinese = ['claude-opus-4-7', 'phi4-reasoning:plus', 'llama4:scout', 'gemma4:e4b', 'gpt-oss-120b'];
  for (const m of chinese) {
    assert(isChineseOrigin(m), `isChineseOrigin('${m}') === true`);
  }
  for (const m of nonChinese) {
    assert(!isChineseOrigin(m), `isChineseOrigin('${m}') === false`);
  }
}

// ── Test 9: new llm_profiles schema validation ─────────────────────────
console.log('\n9. Validator accepts new capability-outer schema and rejects old one');
{
  // Valid new schema
  const goodErrs = [];
  validateConfig({
    llm_profiles: {
      planner: {
        'best-cloud':     { '16gb': 'claude-opus-4-7', '32gb': 'claude-opus-4-7', '48gb': 'claude-opus-4-7', '64gb': 'qwen3:30b', '128gb': 'qwen3:30b' },
        'best-cloud-oss': 'deepseek/deepseek-r2',
        'best-local-oss': { '16gb': 'phi4-reasoning:plus', '32gb': 'qwen3:14b', '48gb': 'qwen3:30b', '64gb': 'qwen3:30b', '128gb': 'qwen3:30b' },
        'best-cloud-gov': 'claude-opus-4-7',
        'best-local-gov': { '16gb': 'phi4-reasoning:plus', '32gb': 'phi4-reasoning:plus', '48gb': 'gpt-oss-20b:TODO', '64gb': 'gpt-oss-120b:TODO', '128gb': 'gpt-oss-120b:TODO' },
        'on_failure': 'cascade',
      },
    },
    models: [],
    tool_capability_to_profile: {},
  }, goodErrs);
  assert(goodErrs.length === 0, 'new capability-outer schema with tier-object and string values passes validation');

  // Old schema with connected_model/disconnect_model should fail
  const badErrs = [];
  validateConfig({
    llm_profiles: {
      '64gb': {
        planner: { connected_model: 'claude-opus-4-7', disconnect_model: 'qwen3:30b' },
      },
    },
    models: [],
    tool_capability_to_profile: {},
  }, badErrs);
  assert(badErrs.length > 0, 'old connected_model/disconnect_model schema is rejected by validator');

  // Invalid mode key in capability entry
  const badModeErrs = [];
  validateConfig({
    llm_profiles: {
      planner: {
        'best-cloud': 'claude-opus-4-7',
        'cloud-best-quality': 'claude-opus-4-7',
      },
    },
    models: [],
    tool_capability_to_profile: {},
  }, badModeErrs);
  assert(badModeErrs.length > 0, "old mode name 'cloud-best-quality' is rejected as invalid key");
}

// ── Test 10: llm_mode validation accepts new modes ─────────────────────
console.log('\n10. llm_mode field validation accepts new modes, rejects old');
{
  const minProfile = {
    llm_profiles: { planner: { ...MIN_CAPABILITY_ENTRY } },
    models: [],
    tool_capability_to_profile: {},
  };
  for (const m of ['best-cloud', 'best-cloud-oss', 'best-local-oss', 'best-cloud-gov', 'best-local-gov']) {
    const errs = [];
    validateConfig({ ...minProfile, llm_mode: m }, errs);
    assert(errs.length === 0, `llm_mode '${m}' is valid`);
  }
  // Legacy mode names still accepted in llm_mode for backward compat (old overrides)
  const legacyErrs = [];
  validateConfig({ ...minProfile, llm_mode: 'connected' }, legacyErrs);
  assert(legacyErrs.length === 0, "legacy llm_mode 'connected' is still accepted for backward compat");
  // Garbage values are rejected
  const badErrs = [];
  validateConfig({ ...minProfile, llm_mode: 'not-a-real-mode' }, badErrs);
  assert(badErrs.length > 0, "nonsense llm_mode is rejected");
}

// ── Test 11: resolveLocalFallback walks local modes in order ───────────
console.log('\n11. resolveLocalFallback picks first available local mode');
{
  const entry = {
    'best-cloud': 'claude-opus-4-7',
    'best-local-oss': { '16gb': 'phi4-mini', '64gb': 'qwen3:30b' },
    'best-local-gov': { '16gb': 'phi4-reasoning:plus', '64gb': 'phi4-reasoning:plus' },
  };
  assert(resolveLocalFallback(entry, '16gb') === 'phi4-mini', 'resolveLocalFallback at 16gb returns best-local-oss value');
  assert(resolveLocalFallback(entry, '64gb') === 'qwen3:30b', 'resolveLocalFallback at 64gb returns best-local-oss value');
  // No local modes defined → falls back to best-cloud
  const cloudOnlyEntry = { 'best-cloud': 'claude-opus-4-7' };
  assert(resolveLocalFallback(cloudOnlyEntry, '64gb') === 'claude-opus-4-7', 'resolveLocalFallback with no local modes falls back to best-cloud');
  assert(resolveLocalFallback(null, '64gb') === null, 'resolveLocalFallback with null entry returns null');
}

// ── Test 12: model: prefix in agent_to_capability ─────────────────────
console.log('\n12. model: prefix — validator + resolver');
{
  const minProfile = {
    llm_profiles: { planner: { ...MIN_CAPABILITY_ENTRY } },
    models: [],
    tool_capability_to_profile: {},
  };

  // 12a: validator accepts model: prefix without requiring capability in llm_profiles
  const errors12a = [];
  validateConfig({
    ...minProfile,
    agent_to_capability: { 'test-agent': 'model:qwen3:30b' },
    endpoints: { anthropic: { url: 'http://localhost', format: 'anthropic', auth: 'none' } },
  }, errors12a);
  assert(errors12a.length === 0, 'model: prefix value passes validator');

  // 12b: validator rejects model: prefix with empty name
  const errors12b = [];
  validateConfig({
    ...minProfile,
    agent_to_capability: { 'test-agent': 'model:' },
    endpoints: {},
  }, errors12b);
  assert(errors12b.some(e => e.includes('non-empty')), 'model: prefix with empty name is rejected');

  // 12c: resolveCapabilityAlias returns raw model: value
  const cfg12c = { agent_to_capability: { implementer: 'model:qwen3:30b' } };
  const alias = resolveCapabilityAlias('implementer', cfg12c, '64gb');
  assert(alias === 'model:qwen3:30b', 'resolveCapabilityAlias returns model: prefixed value');

  // 12d: MODEL_PIN_PREFIX exported
  assert(MODEL_PIN_PREFIX === 'model:', "MODEL_PIN_PREFIX exported as 'model:'");
}

// ── Test 13: agent-reset restores system default ───────────────────────
console.log('\n13. agent-reset restores system default (not null-delete)');
{
  const { applyUpdates } = require('../tools/model-map-edit.js');

  const defaults = {
    agent_to_capability: { planner: 'planner', coder: 'coder' },
    llm_profiles: { planner: { ...MIN_CAPABILITY_ENTRY }, coder: { ...MIN_CAPABILITY_ENTRY } },
    endpoints: {},
    models: [],
    tool_capability_to_profile: {},
  };
  const withOverride = {
    ...defaults,
    agent_to_capability: { planner: 'coder', coder: 'coder' },
  };

  // Reset planner → should restore to 'planner' from defaults
  const after = applyUpdates(withOverride, { agent_to_capability: { planner: null } }, defaults);
  assert(
    after.agent_to_capability.planner === 'planner',
    'null reset restores planner to system default (not undefined/null)',
  );
  assert(
    after.agent_to_capability.coder === 'coder',
    'coder (no override) unchanged after reset',
  );
}

// ── Test 14: shipped config capabilities match agent fleet ────────────
console.log('\n14. Shipped config has identity agent_to_capability for all 12 pipeline agents');
{
  const shippedPath = path.join(__dirname, '..', 'config', 'model-map.json');
  try {
    const shipped = JSON.parse(fs.readFileSync(shippedPath, 'utf8'));
    const a2c = shipped.agent_to_capability || {};
    const profiles = shipped.llm_profiles || {};
    const pipelineAgents = [
      'planner', 'planner-hard', 'explore', 'coder', 'coder-fallback',
      'tester', 'docs', 'reviewer-routine', 'reviewer-security',
      'debugger-hypothesis', 'debugger-investigate', 'debugger-hard',
    ];
    for (const agent of pipelineAgents) {
      assert(a2c[agent] === agent, `agent_to_capability['${agent}'] === '${agent}' (identity mapping)`);
      assert(!!profiles[agent], `llm_profiles['${agent}'] is defined`);
      for (const mode of ['best-cloud', 'best-cloud-oss', 'best-local-oss', 'best-cloud-gov', 'best-local-gov']) {
        assert(profiles[agent][mode] !== undefined, `llm_profiles['${agent}']['${mode}'] is defined`);
      }
    }
  } catch (e) {
    assert(false, `shipped config agent check failed: ${e.message}`);
  }
}

// ── Test 15: USGov filter — gov modes block Chinese-origin models ──────
console.log('\n15. USGov filter: best-cloud-gov and best-local-gov block Chinese-origin models');
{
  const shippedPath = path.join(__dirname, '..', 'config', 'model-map.json');
  try {
    const shipped = JSON.parse(fs.readFileSync(shippedPath, 'utf8'));
    const profiles = shipped.llm_profiles || {};
    let allGovNonChinese = true;
    for (const [cap, entry] of Object.entries(profiles)) {
      for (const govMode of ['best-cloud-gov', 'best-local-gov']) {
        const modeVal = entry[govMode];
        if (!modeVal) continue;
        const models = typeof modeVal === 'string' ? [modeVal] : Object.values(modeVal);
        for (const m of models) {
          if (isChineseOrigin(m)) {
            console.error(`  FAIL  ${cap}['${govMode}'] = '${m}' is Chinese-origin — blocked in gov mode`);
            allGovNonChinese = false;
          }
        }
      }
    }
    assert(allGovNonChinese, 'all best-cloud-gov and best-local-gov entries are non-Chinese-origin');
  } catch (e) {
    assert(false, `USGov filter test failed: ${e.message}`);
  }
}

// ── Test 16: resolveLocalFallback gov filter ───────────────────────────
console.log('\n16. resolveLocalFallback: gov mode skips Chinese-origin models');
{
  const entry = {
    'best-cloud':     { '16gb': 'claude-opus-4-7' },
    'best-local-oss': { '16gb': 'qwen3:7b', '64gb': 'qwen3:30b' },
    'best-local-gov': { '16gb': 'phi4-mini', '64gb': 'phi4-reasoning:plus' },
  };
  // Non-gov: best-local-oss returns first (even if Chinese-origin)
  assert(resolveLocalFallback(entry, '16gb', 'best-cloud') === 'qwen3:7b', 'non-gov: returns Chinese-origin best-local-oss model');
  // Gov: skips qwen3:7b (Chinese-origin in best-local-oss), returns phi4-mini from best-local-gov
  assert(resolveLocalFallback(entry, '16gb', 'best-local-gov') === 'phi4-mini', 'gov: skips Chinese-origin, returns phi4-mini from best-local-gov');
  assert(resolveLocalFallback(entry, '64gb', 'best-cloud-gov') === 'phi4-reasoning:plus', 'gov (best-cloud-gov): skips Chinese-origin qwen3:30b, returns phi4-reasoning:plus');
  // Gov where all local modes are Chinese-origin → falls back to cloud
  const cloudOnlyGov = {
    'best-cloud':     'claude-opus-4-7',
    'best-local-oss': 'qwen3:30b',
    'best-local-gov': 'qwen3:7b',
  };
  assert(resolveLocalFallback(cloudOnlyGov, '64gb', 'best-local-gov') === 'claude-opus-4-7', 'gov: all local are Chinese-origin, falls back to best-cloud');
}

// ── Test 17: applyLlmProfilesUpdates partial-mode deep-merge ──────────
console.log('\n17. applyLlmProfilesUpdates: partial mode edit preserves unspecified mode keys');
{
  const { applyUpdates } = require('../tools/model-map-edit.js');
  const { computeOverrideDiff, mergeConfigLayers } = require('../tools/model-map-layered.js');

  const base = {
    llm_profiles: {
      planner: { ...MIN_CAPABILITY_ENTRY },
    },
    models: [],
    tool_capability_to_profile: {},
    endpoints: {},
    agent_to_capability: {},
  };

  // User edits only best-cloud at 64gb
  const partialSpec = {
    llm_profiles: {
      planner: { 'best-cloud': { '64gb': 'custom-model' } },
    },
  };

  const after = applyUpdates(base, partialSpec, base);

  // best-cloud.64gb updated
  assert(
    after.llm_profiles.planner['best-cloud']['64gb'] === 'custom-model',
    'partial edit: best-cloud.64gb updated to custom-model',
  );
  // best-cloud.16gb preserved
  assert(
    after.llm_profiles.planner['best-cloud']['16gb'] === 'model-a',
    'partial edit: best-cloud.16gb preserved from original',
  );
  // Other mode keys preserved
  assert(
    typeof after.llm_profiles.planner['best-local-oss'] === 'object',
    'partial edit: best-local-oss mode key preserved',
  );
  assert(
    typeof after.llm_profiles.planner['best-cloud-gov'] === 'object',
    'partial edit: best-cloud-gov mode key preserved',
  );

  // Round-trip: computeOverrideDiff then mergeConfigLayers should not null-wipe any modes
  const diff = computeOverrideDiff(base, after);
  const roundTripped = mergeConfigLayers(base, diff || {});
  assert(
    roundTripped.llm_profiles.planner['best-cloud']['64gb'] === 'custom-model',
    'round-trip: best-cloud.64gb survives computeOverrideDiff + mergeConfigLayers',
  );
  assert(
    typeof roundTripped.llm_profiles.planner['best-local-oss'] === 'object',
    'round-trip: best-local-oss not null-wiped by computeOverrideDiff',
  );
}

// ── Test 18: fallback_to cross-reference validation ────────────────────
console.log('\n18. Validator rejects fallback_to referencing unknown capability');
{
  const badErrs = [];
  validateConfig({
    llm_profiles: {
      planner: {
        ...MIN_CAPABILITY_ENTRY,
        'fallback_to': 'typo-capability',
      },
    },
    models: [],
    tool_capability_to_profile: {},
  }, badErrs);
  assert(badErrs.some(e => e.includes('typo-capability')), "fallback_to referencing unknown key is rejected");

  // Self-referential fallback_to (capability points to itself) — also invalid
  const selfErrs = [];
  validateConfig({
    llm_profiles: {
      planner: {
        ...MIN_CAPABILITY_ENTRY,
        'fallback_to': 'planner',
      },
    },
    models: [],
    tool_capability_to_profile: {},
  }, selfErrs);
  // Note: self-reference is technically valid (key exists in profiles) — expect no error
  assert(selfErrs.length === 0, "fallback_to pointing to self is not an error (capability exists)");

  // Valid fallback_to
  const goodErrs = [];
  validateConfig({
    llm_profiles: {
      planner:      { ...MIN_CAPABILITY_ENTRY, 'fallback_to': 'planner-hard' },
      'planner-hard': { ...MIN_CAPABILITY_ENTRY },
    },
    models: [],
    tool_capability_to_profile: {},
  }, goodErrs);
  assert(goodErrs.length === 0, "fallback_to pointing to existing capability passes");
}

// ── Test 19: llm_capabilities.model cross-validation ──────────────────
console.log('\n19. Validator rejects llm_capabilities.model referencing unknown capability');
{
  const badErrs = [];
  validateConfig({
    llm_profiles: { 'fast-scout': { ...MIN_CAPABILITY_ENTRY } },
    llm_capabilities: { classify_intent: { model: 'typo-capability' } },
    models: [],
    tool_capability_to_profile: {},
  }, badErrs);
  assert(badErrs.some(e => e.includes('typo-capability')), "llm_capabilities.model referencing unknown capability is rejected");

  // model: prefix is exempt from cross-reference check
  const pinErrs = [];
  validateConfig({
    llm_profiles: { 'fast-scout': { ...MIN_CAPABILITY_ENTRY } },
    llm_capabilities: { classify_intent: { model: 'model:qwen3:7b' } },
    models: [],
    tool_capability_to_profile: {},
  }, pinErrs);
  assert(pinErrs.length === 0, "llm_capabilities.model with model: prefix passes without cross-reference");
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
