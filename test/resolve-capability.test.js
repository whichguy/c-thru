#!/usr/bin/env node
'use strict';
// Tests for tools/model-map-resolve.js pure-function API.
// Unit: cartesian product of modes × tiers × capabilities against a fixture config.
// Integration: spawn tools/c-thru-resolve and assert stdout matches pure-function result.
// Run with: node test/resolve-capability.test.js

const { execSync } = require('child_process');
const path = require('path');
const {
  resolveProfileModel,
  resolveLlmMode,
  resolveActiveTier,
  resolveCapabilityAlias,
  LLM_MODE_ENUM,
} = require('../tools/model-map-resolve.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log('  PASS  ' + message);
    passed++;
  } else {
    console.error('  FAIL  ' + message);
    failed++;
  }
}

// ── Fixture config ────────────────────────────────────────────────────────────
const FIXTURE_CONFIG = {
  llm_mode: 'connected',
  llm_active_profile: '64gb',
  agent_to_capability: {
    implementer:  'deep-coder',
    scaffolder:   'pattern-coder',
    planner:      'judge',
  },
  llm_profiles: {
    '16gb': {
      'deep-coder':   { connected_model: 'small-cloud', disconnect_model: 'small-local' },
      'judge':        { connected_model: 'small-cloud', disconnect_model: 'small-local',
                        modes: { 'semi-offload': 'mid-local' } },
      'orchestrator': { connected_model: 'small-cloud', disconnect_model: 'small-local' },
    },
    '64gb': {
      'deep-coder':   { connected_model: 'dc-cloud',  disconnect_model: 'dc-local' },
      'judge':        { connected_model: 'j-cloud',   disconnect_model: 'j-local',
                        modes: { 'semi-offload': 'j-mid', 'cloud-judge-only': 'j-cloud' } },
      'orchestrator': { connected_model: 'orch-cloud', disconnect_model: 'orch-local' },
      'pattern-coder':{ connected_model: 'pc-cloud',  disconnect_model: 'pc-local' },
      'workhorse':    { connected_model: 'wh-cloud',  disconnect_model: 'wh-local' },
    },
  },
};

const MODES = Array.from(LLM_MODE_ENUM);
const TIERS = Object.keys(FIXTURE_CONFIG.llm_profiles);
const CAPABILITIES = ['deep-coder', 'judge', 'orchestrator', 'workhorse'];

// ── 1. resolveProfileModel — cartesian product ────────────────────────────────
console.log('1. resolveProfileModel — 4 modes × entries with and without modes sub-map');
{
  const entryWithModes = FIXTURE_CONFIG.llm_profiles['64gb']['judge'];
  assert(resolveProfileModel(entryWithModes, 'connected')       === 'j-cloud', 'judge connected');
  assert(resolveProfileModel(entryWithModes, 'offline')         === 'j-local', 'judge offline');
  assert(resolveProfileModel(entryWithModes, 'semi-offload')    === 'j-mid',   'judge semi-offload (modes[])');
  assert(resolveProfileModel(entryWithModes, 'cloud-judge-only')=== 'j-cloud', 'judge cloud-judge-only (modes[])');

  const plainEntry = FIXTURE_CONFIG.llm_profiles['64gb']['deep-coder'];
  assert(resolveProfileModel(plainEntry, 'connected')       === 'dc-cloud', 'dc connected');
  assert(resolveProfileModel(plainEntry, 'offline')         === 'dc-local', 'dc offline');
  assert(resolveProfileModel(plainEntry, 'semi-offload')    === 'dc-local', 'dc semi-offload (no modes[])');
  assert(resolveProfileModel(plainEntry, 'cloud-judge-only')=== 'dc-local', 'dc cloud-judge-only (no modes[])');
  assert(resolveProfileModel(plainEntry, 'unknown-mode')    === 'dc-cloud', 'dc unknown mode → conservative default');
}

// ── 2. resolveLlmMode — config + env precedence ───────────────────────────────
console.log('\n2. resolveLlmMode — env overrides config; legacy env aliases');
{
  const savedEnv = { ...process.env };

  // Default from config
  delete process.env.CLAUDE_LLM_MODE;
  delete process.env.CLAUDE_CONNECTIVITY_MODE;
  delete process.env.CLAUDE_LLM_CONNECTIVITY_MODE;
  assert(resolveLlmMode({ llm_mode: 'offline' }) === 'offline', 'config.llm_mode respected');
  assert(resolveLlmMode({}) === 'connected', 'built-in default when config absent');

  // Env wins over config
  process.env.CLAUDE_LLM_MODE = 'semi-offload';
  assert(resolveLlmMode({ llm_mode: 'offline' }) === 'semi-offload', 'CLAUDE_LLM_MODE wins over config');
  delete process.env.CLAUDE_LLM_MODE;

  // Legacy env
  process.env.CLAUDE_CONNECTIVITY_MODE = 'disconnect';
  assert(resolveLlmMode({}) === 'offline', 'legacy disconnect → offline');
  process.env.CLAUDE_CONNECTIVITY_MODE = 'connected';
  assert(resolveLlmMode({}) === 'connected', 'legacy connected → connected');
  delete process.env.CLAUDE_CONNECTIVITY_MODE;

  // Invalid env is ignored
  process.env.CLAUDE_LLM_MODE = 'bogus';
  assert(resolveLlmMode({ llm_mode: 'offline' }) === 'offline', 'invalid CLAUDE_LLM_MODE ignored, falls back');
  delete process.env.CLAUDE_LLM_MODE;

  Object.assign(process.env, savedEnv);
}

// ── 3. resolveActiveTier — env and config precedence ─────────────────────────
console.log('\n3. resolveActiveTier — CLAUDE_LLM_PROFILE → config.llm_active_profile → hw detection');
{
  const savedEnv = { ...process.env };
  delete process.env.CLAUDE_LLM_PROFILE;
  delete process.env.CLAUDE_LLM_MEMORY_GB;

  assert(resolveActiveTier({ llm_active_profile: '32gb' }) === '32gb', 'config.llm_active_profile used');
  assert(resolveActiveTier({ llm_active_profile: 'auto', }) !== '', 'auto → hw detection returns non-empty string');

  process.env.CLAUDE_LLM_PROFILE = '16gb';
  assert(resolveActiveTier({ llm_active_profile: '64gb' }) === '16gb', 'CLAUDE_LLM_PROFILE wins over config');
  delete process.env.CLAUDE_LLM_PROFILE;

  process.env.CLAUDE_LLM_MEMORY_GB = '8';
  assert(resolveActiveTier({}) === '16gb', 'CLAUDE_LLM_MEMORY_GB=8 → 16gb tier');
  process.env.CLAUDE_LLM_MEMORY_GB = '48';
  assert(resolveActiveTier({}) === '48gb', 'CLAUDE_LLM_MEMORY_GB=48 → 48gb tier');
  delete process.env.CLAUDE_LLM_MEMORY_GB;

  Object.assign(process.env, savedEnv);
}

// ── 4. resolveCapabilityAlias — static set, agent_to_capability, profile key ──
console.log('\n4. resolveCapabilityAlias — static aliases, agent map, profile key, unknown');
{
  const tier = '64gb';
  const cfg  = FIXTURE_CONFIG;

  // Static LLM_PROFILE_ALIASES
  assert(resolveCapabilityAlias('workhorse', cfg, tier) === 'workhorse', 'static alias identity');
  assert(resolveCapabilityAlias('coder', cfg, tier)     === 'coder',     'static alias identity (coder)');

  // agent_to_capability
  assert(resolveCapabilityAlias('implementer', cfg, tier) === 'deep-coder',   'agent → deep-coder');
  assert(resolveCapabilityAlias('scaffolder',  cfg, tier) === 'pattern-coder', 'agent → pattern-coder');
  assert(resolveCapabilityAlias('planner',     cfg, tier) === 'judge',         'agent → judge');

  // Direct profile key (not in static set, not in a2c)
  assert(resolveCapabilityAlias('deep-coder',   cfg, tier) === 'deep-coder',   'profile key → identity');
  assert(resolveCapabilityAlias('orchestrator', cfg, tier) === 'orchestrator', 'profile key → identity');

  // Unknown
  assert(resolveCapabilityAlias('unknown-thing', cfg, tier) === null, 'unknown → null');

  // Wrong tier: capability exists in 64gb but not 16gb, and not in static set or a2c
  assert(resolveCapabilityAlias('pattern-coder', cfg, '16gb') === null, 'profile key miss on wrong tier → null');
}

// ── 5. Cartesian product — modes × tiers × capabilities ──────────────────────
console.log('\n5. Cartesian product — resolveProfileModel output is always a non-empty string');
{
  let combos = 0;
  for (const tier of TIERS) {
    const tierProfile = FIXTURE_CONFIG.llm_profiles[tier];
    for (const cap of CAPABILITIES) {
      const entry = tierProfile[cap];
      if (!entry) continue;
      for (const mode of MODES) {
        const result = resolveProfileModel(entry, mode);
        assert(typeof result === 'string' && result.length > 0,
          `${cap} @ ${tier} / mode=${mode} → '${result}'`);
        combos++;
      }
    }
  }
  console.log(`  (${combos} mode×tier×cap combos checked)`);
}

// ── 6. Integration — spawn tools/c-thru-resolve ──────────────────────────────
console.log('\n6. Integration — tools/c-thru-resolve output matches pure-function result');
{
  const fs = require('fs');
  const os = require('os');
  const fixturePath = path.join(os.tmpdir(), `resolve-cap-fixture-${process.pid}.json`);
  try {
    fs.writeFileSync(fixturePath, JSON.stringify(FIXTURE_CONFIG));

    const cases = [
      { cap: 'deep-coder',  mode: 'connected', tier: '64gb', expected: 'dc-cloud' },
      { cap: 'deep-coder',  mode: 'offline',   tier: '64gb', expected: 'dc-local' },
      { cap: 'judge',       mode: 'semi-offload', tier: '64gb', expected: 'j-mid' },
      { cap: 'implementer', mode: 'connected', tier: '64gb', expected: 'dc-cloud' }, // agent alias
    ];

    for (const { cap, mode, tier, expected } of cases) {
      const env = {
        ...process.env,
        CLAUDE_MODEL_MAP_DEFAULTS_PATH: fixturePath,
        CLAUDE_LLM_MODE: mode,
        CLAUDE_LLM_PROFILE: tier,
      };
      const resolveScript = path.join(__dirname, '..', 'tools', 'c-thru-resolve');
      const stdout = execSync(`node ${resolveScript} ${cap}`, { env, encoding: 'utf8' }).trim();
      assert(stdout === expected, `c-thru-resolve ${cap} mode=${mode} tier=${tier} → '${stdout}' (want '${expected}')`);
    }
  } finally {
    try { fs.unlinkSync(fixturePath); } catch {}
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + (failed === 0 ? '✓' : '✗') + ` ${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
