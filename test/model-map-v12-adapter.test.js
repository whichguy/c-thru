#!/usr/bin/env node
'use strict';
// Fixture-driven test for the v1.2 loader-level adapter in model-map-layered.js.
// Run with: node test/model-map-v12-adapter.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLayeredConfig } = require('../tools/model-map-layered.js');

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

console.log('model-map-v12-adapter tests\n');

// ── Test 1: adapter fires on legacy shape ──────────��───────────────────
console.log('1. Adapter synthesizes v1.2 keys from legacy fallback_strategies');
{
  const legacy = {
    llm_profiles: {
      '64gb': {
        default:     { connected_model: 'glm-5.1:cloud',   disconnect_model: 'qwen3:1.7b'  },
        classifier:  { connected_model: 'qwen3:1.7b',      disconnect_model: 'qwen3:1.7b'  },
        explorer:    { connected_model: 'gemma4:e2b',       disconnect_model: 'qwen3:1.7b'  },
        reviewer:    { connected_model: 'gemma4:26b',       disconnect_model: 'qwen3:1.7b'  },
        workhorse:   { connected_model: 'gemma4:26b',       disconnect_model: 'qwen3:1.7b'  },
        coder:       { connected_model: 'qwen3-coder:30b',  disconnect_model: 'qwen3:1.7b'  },
      },
    },
    llm_capabilities: {
      classify_intent: { model: 'classifier' },
      explore_local:   { model: 'explorer'   },
    },
    fallback_strategies: {
      'glm-5.1:cloud': {
        event: {
          network_failure: ['gemma4:26b-a4b'],
          rate_limit:      ['gemma4:26b-a4b'],
        },
      },
      'model-b': {
        event: {
          network_failure: ['model-c', 'model-d'],
          rate_limit:      ['model-c'],
        },
      },
    },
  };

  withTmpFile(legacy, (p) => {
    const { effective } = loadLayeredConfig(p, null);
    assert(!!effective.tool_capability_to_profile, 'tool_capability_to_profile synthesized');
    assert(effective.tool_capability_to_profile.classify_intent === 'classifier', 'classify_intent → classifier');
    assert(effective.tool_capability_to_profile.explore_local === 'explorer', 'explore_local → explorer');
    assert(Array.isArray(effective.models), 'models array synthesized');
    const glmEntry = effective.models.find(m => m.name === 'glm-5.1:cloud');
    assert(!!glmEntry, 'glm-5.1:cloud entry present');
    assert(Array.isArray(glmEntry.equivalents) && glmEntry.equivalents.includes('gemma4:26b-a4b'), 'glm equivalents correct');
    const mbEntry = effective.models.find(m => m.name === 'model-b');
    assert(!!mbEntry, 'model-b entry present');
    assert(mbEntry.equivalents.includes('model-c') && mbEntry.equivalents.includes('model-d'), 'model-b equivalents union correct');
    // fallback_strategies still present for proxy backward-compat
    assert(!!effective.fallback_strategies, 'fallback_strategies preserved for proxy');
  });
}

// ── Test 2: adapter does NOT fire on v1.2 shape ────────────────────────
console.log('\n2. Adapter skips when tool_capability_to_profile already present');
{
  const v12 = {
    llm_profiles: {
      '64gb': {
        default:    { connected_model: 'model-a', disconnect_model: 'model-a' },
        classifier: { connected_model: 'model-a', disconnect_model: 'model-a' },
        explorer:   { connected_model: 'model-a', disconnect_model: 'model-a' },
        reviewer:   { connected_model: 'model-a', disconnect_model: 'model-a' },
        workhorse:  { connected_model: 'model-a', disconnect_model: 'model-a' },
        coder:      { connected_model: 'model-a', disconnect_model: 'model-a' },
      },
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

// ── Test 3: warning fires at most once ────────────────────────────────
console.log('\n3. Warning fires once per process');
{
  const legacy = {
    llm_profiles: {
      '64gb': {
        default:    { connected_model: 'x', disconnect_model: 'x' },
        classifier: { connected_model: 'x', disconnect_model: 'x' },
        explorer:   { connected_model: 'x', disconnect_model: 'x' },
        reviewer:   { connected_model: 'x', disconnect_model: 'x' },
        workhorse:  { connected_model: 'x', disconnect_model: 'x' },
        coder:      { connected_model: 'x', disconnect_model: 'x' },
      },
    },
    fallback_strategies: { 'x': { event: { network_failure: ['y'] } } },
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
  withTmpFile(legacy, (p) => {
    loadLayeredConfig(p, null);
  });
  process.stderr.write = origWrite;
  assert(stderrChunks.length === 0, 'no duplicate warning emitted (module-scope guard works)');
}

// ── Test 4: shipped config validates (no fallback_strategies) ─────────
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

// ── Test 5: llm_mode enum validation ──────────────────────────────────
console.log('\n5. llm_mode enum validation');
{
  const { validateConfig } = require('../tools/model-map-validate.js');
  const base = {
    llm_profiles: { '64gb': {
      default: { connected_model: 'x', disconnect_model: 'x' },
      classifier: { connected_model: 'x', disconnect_model: 'x' },
      explorer: { connected_model: 'x', disconnect_model: 'x' },
      reviewer: { connected_model: 'x', disconnect_model: 'x' },
      workhorse: { connected_model: 'x', disconnect_model: 'x' },
      coder: { connected_model: 'x', disconnect_model: 'x' },
    }},
  };
  for (const m of ['connected', 'semi-offload', 'cloud-judge-only', 'offline']) {
    const errs = [];
    validateConfig({ ...base, llm_mode: m }, errs);
    assert(errs.length === 0, `llm_mode '${m}' is valid`);
  }
  const badErrs = [];
  validateConfig({ ...base, llm_mode: 'disconnect' }, badErrs);
  assert(badErrs.length > 0, "llm_mode 'disconnect' (legacy) is rejected");
}

// ── Test 6: modes sub-map key validation ──────────────────────────────
console.log('\n6. modes sub-map keys are validated against llm_mode enum');
{
  const { validateConfig } = require('../tools/model-map-validate.js');
  const withModes = {
    llm_profiles: { '64gb': {
      default: { connected_model: 'x', disconnect_model: 'x' },
      classifier: { connected_model: 'x', disconnect_model: 'x' },
      explorer: { connected_model: 'x', disconnect_model: 'x' },
      reviewer: { connected_model: 'x', disconnect_model: 'x' },
      workhorse: { connected_model: 'x', disconnect_model: 'x' },
      coder: { connected_model: 'x', disconnect_model: 'x' },
      judge: { connected_model: 'a', disconnect_model: 'b', modes: { 'semi-offload': 'a', 'cloud-judge-only': 'a' } },
    }},
  };
  const okErrs = [];
  validateConfig(withModes, okErrs);
  assert(okErrs.length === 0, 'valid modes sub-map passes validation');

  const badModes = JSON.parse(JSON.stringify(withModes));
  badModes.llm_profiles['64gb'].judge.modes['bad-mode'] = 'a';
  const badErrs = [];
  validateConfig(badModes, badErrs);
  assert(badErrs.length > 0, 'invalid modes key is rejected');
}

// ── Test 7: llm_connectivity_mode: "disconnect" back-compat ───────────
console.log('\n7. llm_connectivity_mode: "disconnect" still validates (back-compat)');
{
  const { validateConfig } = require('../tools/model-map-validate.js');
  const legacy = {
    llm_connectivity_mode: 'disconnect',
    llm_profiles: { '64gb': {
      default: { connected_model: 'x', disconnect_model: 'x' },
      classifier: { connected_model: 'x', disconnect_model: 'x' },
      explorer: { connected_model: 'x', disconnect_model: 'x' },
      reviewer: { connected_model: 'x', disconnect_model: 'x' },
      workhorse: { connected_model: 'x', disconnect_model: 'x' },
      coder: { connected_model: 'x', disconnect_model: 'x' },
    }},
  };
  const errs = [];
  validateConfig(legacy, errs);
  assert(errs.length === 0, 'llm_connectivity_mode: "disconnect" validates without errors (back-compat)');
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
