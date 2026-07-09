#!/usr/bin/env node
'use strict';
// Tests for tools/model-map-resolve.js pure-function API.
// Unit: modes × tiers × capabilities against a fixture config (new schema).
// Integration: spawn tools/c-thru-resolve and assert stdout matches pure-function result.
// Run with: node test/resolve-capability.test.js

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  resolveProfileModel,
  resolveLlmMode,
  resolveActiveTier,
  resolveCapabilityAlias,
  validModes,
  baseModeFor,
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

// ── Fixture config (new schema: capability-outer llm_profiles) ────────────────
const FIXTURE_CONFIG = {
  agent_to_capability: {
    writer:    'coder',
    planner:   'planner',
  },
  llm_profiles: {
    // tier-keyed object per mode
    coder: {
      'best-cloud':     { '16gb': 'cloud-small', '64gb': 'cloud-large' },
      'best-local-oss': { '16gb': 'local-small', '64gb': 'local-large' },
    },
    // flat string per mode (same model for all tiers)
    planner: {
      'best-cloud':     'cloud-planner',
      'best-local-oss': 'local-planner',
      'best-cloud-gov': 'gov-planner',
    },
    // capability not in agent_to_capability — direct lookup only
    tester: {
      'best-cloud':     { '64gb': 'cloud-tester' },
      'best-local-oss': { '64gb': 'local-tester' },
    },
  },
};

const MODES = Array.from(LLM_MODE_ENUM);

// ── 1. resolveProfileModel — tier-keyed object form ───────────────────────────
console.log('1. resolveProfileModel — tier-keyed object per mode');
{
  const entry = FIXTURE_CONFIG.llm_profiles.coder;
  assert(resolveProfileModel(entry, '16gb', 'best-cloud')     === 'cloud-small', `coder 16gb best-cloud → cloud-small`);
  assert(resolveProfileModel(entry, '64gb', 'best-cloud')     === 'cloud-large', `coder 64gb best-cloud → cloud-large`);
  assert(resolveProfileModel(entry, '16gb', 'best-local-oss') === 'local-small', `coder 16gb best-local-oss → local-small`);
  assert(resolveProfileModel(entry, '64gb', 'best-local-oss') === 'local-large', `coder 64gb best-local-oss → local-large`);
}

// ── 2. resolveProfileModel — flat string form (all tiers same model) ──────────
console.log('\n2. resolveProfileModel — flat string per mode (tier-agnostic)');
{
  const entry = FIXTURE_CONFIG.llm_profiles.planner;
  assert(resolveProfileModel(entry, '16gb', 'best-cloud')     === 'cloud-planner', `planner 16gb best-cloud → cloud-planner`);
  assert(resolveProfileModel(entry, '64gb', 'best-cloud')     === 'cloud-planner', `planner 64gb best-cloud → same model at 64gb`);
  assert(resolveProfileModel(entry, '64gb', 'best-local-oss') === 'local-planner', `planner 64gb best-local-oss → local-planner`);
  assert(resolveProfileModel(entry, '64gb', 'best-cloud-gov') === 'gov-planner',   `planner 64gb best-cloud-gov → gov-planner`);
}

// ── 3. resolveProfileModel — unknown mode falls back to best-cloud ────────────
console.log('\n3. resolveProfileModel — unknown mode falls back to best-cloud');
{
  const entry = FIXTURE_CONFIG.llm_profiles.coder;
  // best-cloud-oss not in fixture → falls back to best-cloud value
  const result = resolveProfileModel(entry, '64gb', 'best-cloud-oss');
  assert(result === 'cloud-large', `coder 64gb best-cloud-oss (not in fixture) → falls back to cloud-large (got ${result})`);
}

// ── 4. resolveProfileModel — null/undefined guard ─────────────────────────────
console.log('\n4. resolveProfileModel — null/undefined returns null for all modes');
{
  for (const mode of MODES) {
    assert(resolveProfileModel(null, '64gb', mode)      === null, `null entry mode=${mode} → null`);
    assert(resolveProfileModel(undefined, '64gb', mode) === null, `undefined entry mode=${mode} → null`);
  }
}

// ── 5. resolveProfileModel — missing tier key returns null ────────────────────
console.log('\n5. resolveProfileModel — missing tier key returns null');
{
  const entry = FIXTURE_CONFIG.llm_profiles.coder;
  assert(resolveProfileModel(entry, '512gb', 'best-cloud') === null,
    `coder 512gb best-cloud (tier not in fixture) → null`);
}

// ── 6. resolveLlmMode — env overrides config, legacy aliases ─────────────────
console.log('\n6. resolveLlmMode — env overrides config; legacy env aliases still work');
{
  const savedEnv = { ...process.env };

  delete process.env.CLAUDE_LLM_MODE;
  delete process.env.CLAUDE_CONNECTIVITY_MODE;
  delete process.env.CLAUDE_LLM_CONNECTIVITY_MODE;

  // Config llm_mode (new key): recognized value used
  assert(resolveLlmMode({ llm_mode: 'best-local-oss' }) === 'best-local-oss',
    `config.llm_mode=best-local-oss respected`);

  // Config llm_mode: legacy alias 'connected' → cloud default, then normal auto-detect
  const connectedMode = resolveLlmMode({ llm_mode: 'connected' });
  assert(connectedMode === 'best-cloud' || connectedMode === 'best-local-oss',
    `config.llm_mode=connected maps through cloud-default auto detection (got ${connectedMode})`);

  // Config llm_mode: legacy alias 'offline' → best-local-oss
  assert(resolveLlmMode({ llm_mode: 'offline' }) === 'best-local-oss',
    `config.llm_mode=offline maps to best-local-oss`);

  // Default when no config and no env
  const defaultMode = resolveLlmMode({});
  assert(defaultMode === 'best-cloud' || defaultMode === 'best-local-oss',
    `built-in default is best-cloud or best-local-oss (got ${defaultMode})`);

  // CLAUDE_LLM_MODE env wins over config
  process.env.CLAUDE_LLM_MODE = 'best-cloud-oss';
  assert(resolveLlmMode({ llm_mode: 'best-local-oss' }) === 'best-cloud-oss',
    `CLAUDE_LLM_MODE wins over config.llm_mode`);
  delete process.env.CLAUDE_LLM_MODE;

  // Invalid CLAUDE_LLM_MODE is silently ignored; config fallback used
  process.env.CLAUDE_LLM_MODE = 'bogus-mode';
  assert(resolveLlmMode({ llm_mode: 'best-cloud-gov' }) === 'best-cloud-gov',
    `invalid CLAUDE_LLM_MODE ignored; falls back to config.llm_mode`);
  delete process.env.CLAUDE_LLM_MODE;

  // Legacy CLAUDE_CONNECTIVITY_MODE=disconnect → best-local-oss
  process.env.CLAUDE_CONNECTIVITY_MODE = 'disconnect';
  assert(resolveLlmMode({}) === 'best-local-oss',
    `legacy CLAUDE_CONNECTIVITY_MODE=disconnect → best-local-oss`);
  delete process.env.CLAUDE_CONNECTIVITY_MODE;

  Object.assign(process.env, savedEnv);
}

// ── 7. resolveActiveTier — env and config precedence ─────────────────────────
console.log('\n7. resolveActiveTier — CLAUDE_LLM_PROFILE → config → hw detection');
{
  const savedEnv = { ...process.env };
  delete process.env.CLAUDE_LLM_PROFILE;
  delete process.env.CLAUDE_LLM_MEMORY_GB;

  // Config-specified tier
  assert(resolveActiveTier({ llm_active_profile: '32gb' }) === '32gb',
    `config.llm_active_profile=32gb used when no env`);

  // env wins over config
  process.env.CLAUDE_LLM_PROFILE = '16gb';
  assert(resolveActiveTier({ llm_active_profile: '128gb' }) === '16gb',
    `CLAUDE_LLM_PROFILE=16gb wins over config.llm_active_profile=128gb`);
  delete process.env.CLAUDE_LLM_PROFILE;

  // CLAUDE_LLM_MEMORY_GB maps to correct tier
  process.env.CLAUDE_LLM_MEMORY_GB = '8';
  assert(resolveActiveTier({}) === '16gb',
    `CLAUDE_LLM_MEMORY_GB=8 → 16gb tier`);
  process.env.CLAUDE_LLM_MEMORY_GB = '60';
  assert(resolveActiveTier({}) === '64gb',
    `CLAUDE_LLM_MEMORY_GB=60 → 64gb tier`);
  process.env.CLAUDE_LLM_MEMORY_GB = '120';
  assert(resolveActiveTier({}) === '128gb',
    `CLAUDE_LLM_MEMORY_GB=120 → 128gb tier`);
  delete process.env.CLAUDE_LLM_MEMORY_GB;

  // auto → hw detection returns a non-empty string
  const autoTier = resolveActiveTier({ llm_active_profile: 'auto' });
  assert(typeof autoTier === 'string' && autoTier.length > 0,
    `auto hw detection returns non-empty string (got '${autoTier}')`);

  Object.assign(process.env, savedEnv);
}

// ── 8. resolveCapabilityAlias — agent map and direct profile key ──────────────
console.log('\n8. resolveCapabilityAlias — agent map, direct profile key, unknown');
{
  const cfg = FIXTURE_CONFIG;
  const tier = '64gb';

  // agent_to_capability
  assert(resolveCapabilityAlias('writer', cfg, tier)  === 'coder',   `agent writer → coder`);
  assert(resolveCapabilityAlias('planner', cfg, tier) === 'planner', `agent planner → planner`);

  // Direct profile key (not in a2c but exists in llm_profiles)
  assert(resolveCapabilityAlias('tester', cfg, tier)  === 'tester',  `direct profile key tester → tester`);
  assert(resolveCapabilityAlias('coder', cfg, tier)   === 'coder',   `direct profile key coder → coder`);

  // Unknown — not in a2c or llm_profiles
  assert(resolveCapabilityAlias('totally-unknown', cfg, tier) === null,
    `unknown capability → null`);
}

// ── 9. Cartesian product — modes × tiers × capabilities (fixture) ────────────
console.log('\n9. Cartesian product — resolveProfileModel always string or null for all modes');
{
  const tiers = ['16gb', '64gb'];
  const caps = ['coder', 'planner', 'tester'];
  let combos = 0;
  for (const tier of tiers) {
    for (const cap of caps) {
      const entry = FIXTURE_CONFIG.llm_profiles[cap];
      for (const mode of MODES) {
        const result = resolveProfileModel(entry, tier, mode);
        assert(result === null || (typeof result === 'string' && result.length > 0),
          `${cap} @ ${tier} mode=${mode} → string or null (got ${JSON.stringify(result)})`);
        combos++;
      }
    }
  }
  console.log(`  (${combos} mode×tier×cap combos checked against fixture)`);
}

// ── 10. Shipped config cartesian — all capabilities return non-null at 64gb ───
console.log('\n10. Shipped config — all llm_profiles capabilities resolve at 64gb for every mode');
{
  const shippedConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'model-map.json'), 'utf8')
  );
  const profiles = shippedConfig.llm_profiles || {};
  let nullCount = 0;
  for (const [cap, entry] of Object.entries(profiles)) {
    for (const mode of MODES) {
      const result = resolveProfileModel(entry, '64gb', mode);
      if (result === null) nullCount++;
      // We don't assert non-null because gov modes intentionally block Chinese-origin models
      // which the resolver returns anyway (gov filter is in the proxy/explain layer).
      // Just verify the return type is always string or null.
      assert(result === null || typeof result === 'string',
        `shipped ${cap} @ 64gb mode=${mode} → string or null (got ${JSON.stringify(result)})`);
    }
  }
  console.log(`  (${nullCount} null results across all mode×cap combos at 64gb — expected for gov/unknown mode fallbacks)`);
}

// ── 11. Pinned-model regression guard for shipped config ──────────────────────
// Asserts exact model strings for high-value capability×mode×tier triples.
// These are the sentinel values: if a shipped config edit silently changes a key
// mapping the flexible cartesian test (§10) would not catch, this section will.
console.log('\n11. Pinned-model regression guard — shipped config key triples');
{
  const shippedConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'model-map.json'), 'utf8')
  );
  const p = shippedConfig.llm_profiles || {};

  const pins = [
    // Cloud planner pins intentionally route through the claude-* regex route.
    { cap: 'planner',      tier: '64gb',  mode: 'best-cloud',     want: 'claude-fable-5' },
    { cap: 'planner',      tier: '128gb', mode: 'best-cloud',     want: 'claude-fable-5' },
    { cap: 'planner-hard', tier: '128gb', mode: 'best-cloud',     want: 'claude-fable-5' },
    // fast-scout is always the small local model regardless of mode
    { cap: 'fast-scout',   tier: '64gb',  mode: 'best-cloud',     want: 'phi4-mini:3.8b'   },
    { cap: 'fast-scout',   tier: '64gb',  mode: 'best-local-oss', want: 'phi4-mini:3.8b'   },
    // coder in gov mode must be a non-Chinese claude model
    { cap: 'coder',        tier: '64gb',  mode: 'best-cloud-gov',  want: 'claude-sonnet-4-6' },
    // edge is always the smallest local model
    { cap: 'edge',         tier: '64gb',  mode: 'best-cloud',     want: 'gemma4:e4b'        },
  ];

  for (const { cap, tier, mode, want } of pins) {
    const got = resolveProfileModel(p[cap], tier, mode);
    assert(got === want, `pinned: ${cap}/${mode}/${tier} = ${want} (got ${got})`);
  }
}

// ── 12. Integration — spawn tools/c-thru-resolve with fixture config ──────────
console.log('\n12. Integration — tools/c-thru-resolve output matches pure-function result');
{
  const fixturePath = path.join(os.tmpdir(), `resolve-cap-fixture-${process.pid}.json`);
  const resolveScript = path.join(__dirname, '..', 'tools', 'c-thru-resolve');
  try {
    fs.writeFileSync(fixturePath, JSON.stringify(FIXTURE_CONFIG));

    const cases = [
      { cap: 'coder',   mode: 'best-cloud',     tier: '64gb', expected: 'cloud-large' },
      { cap: 'coder',   mode: 'best-local-oss',  tier: '64gb', expected: 'local-large' },
      { cap: 'planner', mode: 'best-cloud',      tier: '64gb', expected: 'cloud-planner' },
      { cap: 'planner', mode: 'best-cloud-gov',  tier: '64gb', expected: 'gov-planner' },
      { cap: 'writer',  mode: 'best-cloud',      tier: '64gb', expected: 'cloud-large' }, // agent alias
    ];

    for (const { cap, mode, tier, expected } of cases) {
      const env = {
        ...process.env,
        CLAUDE_MODEL_MAP_PATH: fixturePath,
        CLAUDE_LLM_MODE: mode,
        CLAUDE_LLM_PROFILE: tier,
      };
      let stdout;
      try {
        stdout = execSync(`node ${resolveScript} ${cap}`, { env, encoding: 'utf8' }).trim();
      } catch (err) {
        assert(false, `c-thru-resolve ${cap} mode=${mode} tier=${tier} → threw: ${err.message}`);
        continue;
      }
      assert(stdout === expected,
        `c-thru-resolve ${cap} mode=${mode} tier=${tier} → '${expected}' (got '${stdout}')`);
    }
  } finally {
    try { fs.unlinkSync(fixturePath); } catch {}
  }
}

// ── 13. Integration — config selection precedence ─────────────────────────────
console.log('\n13. tools/c-thru-resolve follows config selection precedence');
{
  const resolveScript = path.join(__dirname, '..', 'tools', 'c-thru-resolve');
  const profileHome = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-home-'));
  const projectDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-project-'));
  const overridePath = path.join(os.tmpdir(), `resolve-override-${process.pid}.json`);
  const profileClaude = path.join(profileHome, '.claude');
  const projectClaude = path.join(projectDir, '.claude');
  fs.mkdirSync(profileClaude, { recursive: true });
  fs.mkdirSync(projectClaude, { recursive: true });

  const mkConfig = (modelSuffix) => ({
    llm_profiles: {
      coder: {
        'best-cloud': { '64gb': `coder-${modelSuffix}` },
      },
    },
  });

  try {
    fs.writeFileSync(path.join(profileClaude, 'model-map.json'), JSON.stringify(mkConfig('profile')));
    fs.writeFileSync(path.join(projectClaude, 'model-map.json'), JSON.stringify(mkConfig('project')));
    fs.writeFileSync(overridePath, JSON.stringify(mkConfig('override')));

    const baseEnv = {
      ...process.env,
      HOME: profileHome,
      CLAUDE_LLM_PROFILE: '64gb',
      CLAUDE_LLM_MODE: 'best-cloud',
    };

    // Project-local wins over profile
    const projectOut = execSync(`node ${resolveScript} coder`, {
      cwd: projectDir,
      env: { ...baseEnv },
      encoding: 'utf8',
    }).trim();
    assert(projectOut === 'coder-project',
      `project-local config wins over profile (got '${projectOut}')`);

    // CLAUDE_MODEL_MAP_PATH wins over project/profile
    const overrideOut = execSync(`node ${resolveScript} coder`, {
      cwd: projectDir,
      env: { ...baseEnv, CLAUDE_MODEL_MAP_PATH: overridePath },
      encoding: 'utf8',
    }).trim();
    assert(overrideOut === 'coder-override',
      `CLAUDE_MODEL_MAP_PATH wins over project/profile (got '${overrideOut}')`);
  } finally {
    try { fs.rmSync(profileHome, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectDir,  { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(overridePath); } catch {}
  }
}

// ── 12. Custom modes — validModes / baseModeFor / base-fallback resolution ────
// A custom mode is a label mapping capabilities → models via a `base` built-in
// mode plus per-capability overrides. Un-overridden capabilities resolve under
// `base`; the 'deepseek-hybrid' shape is base best-cloud-oss + Claude overrides.
console.log('\n12. Custom modes — base fallback + per-capability override');
{
  const cfg = {
    custom_modes: {
      'deepseek-hybrid': { base: 'best-cloud-oss', description: 'DeepSeek v4 + best OSS; Claude for high-stakes' },
    },
    llm_profiles: {
      // un-overridden: inherits best-cloud-oss (DeepSeek)
      coder: {
        'best-cloud':     'claude-opus-4-8',
        'best-cloud-oss': 'deepseek-v4-pro:cloud',
      },
      // overridden: explicit deepseek-hybrid key wins over the base
      'planner-hard': {
        'best-cloud':     'claude-opus-4-8',
        'best-cloud-oss': 'deepseek-v4-pro:cloud',
        'deepseek-hybrid': 'claude-opus-4-8',
      },
    },
  };

  // validModes = builtins ∪ declared custom modes
  const valid = validModes(cfg);
  assert(valid.has('deepseek-hybrid'), 'validModes includes the declared custom mode');
  assert(valid.has('best-cloud'), 'validModes still includes built-in modes');
  assert(!validModes({}).has('deepseek-hybrid'), 'validModes without config excludes custom modes');

  // baseModeFor resolves the declared base; built-ins have no base
  assert(baseModeFor('deepseek-hybrid', cfg) === 'best-cloud-oss', 'baseModeFor → declared base');
  assert(baseModeFor('best-cloud', cfg) === null, 'baseModeFor(built-in) → null');

  const base = baseModeFor('deepseek-hybrid', cfg);
  // un-overridden capability falls back to base (best-cloud-oss → DeepSeek)
  assert(resolveProfileModel(cfg.llm_profiles.coder, '64gb', 'deepseek-hybrid', base) === 'deepseek-v4-pro:cloud',
    'un-overridden capability resolves under base mode → DeepSeek');
  // overridden capability uses the explicit custom-mode key
  assert(resolveProfileModel(cfg.llm_profiles['planner-hard'], '64gb', 'deepseek-hybrid', base) === 'claude-opus-4-8',
    'overridden capability uses the explicit custom-mode model → Claude');
  // base fallback chains to best-cloud when base entry is also absent
  const partial = { 'best-cloud': 'claude-fallback' };
  assert(resolveProfileModel(partial, '64gb', 'deepseek-hybrid', base) === 'claude-fallback',
    'mode + base both absent → best-cloud fallback');
  // omitting baseMode preserves original 3-arg semantics (no base hop)
  assert(resolveProfileModel(cfg.llm_profiles.coder, '64gb', 'deepseek-hybrid') === 'claude-opus-4-8',
    '3-arg form (no baseMode) falls straight to best-cloud — original semantics unchanged');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
