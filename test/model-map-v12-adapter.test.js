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

// ── Test 8: fallback chains — proprietary → cloud-oss → local ─────────
console.log('\n8. Every proprietary connected_model has a cloud-oss step before local in fallback_chains');
{
  const shippedPath = path.join(__dirname, '..', 'config', 'model-map.json');
  try {
    const shipped = JSON.parse(fs.readFileSync(shippedPath, 'utf8'));
    const profiles = shipped.llm_profiles || {};
    const chains = shipped.fallback_chains || {};

    // Models that are "local-only" — never intended as cloud-oss intermediates.
    // We detect them by: no ':cloud' suffix AND not starting with 'claude-' AND
    // not a known cloud-oss provider pattern (openrouter, together, etc.).
    function isLocalModel(name) {
      if (!name) return false;
      if (name.includes(':cloud')) return false;
      if (name.startsWith('claude-')) return false;
      // openrouter-style models contain '/'
      if (name.includes('/')) return false;
      return true;
    }

    function hasCloudOssBeforeLocal(chain) {
      // Returns true if chain contains a ':cloud' model that appears
      // at a lower index than the first local-only model.
      let cloudOssIdx = -1;
      let firstLocalIdx = -1;
      for (let i = 0; i < chain.length; i++) {
        const m = chain[i].model || '';
        if (m.includes(':cloud') && cloudOssIdx === -1) cloudOssIdx = i;
        if (isLocalModel(m) && firstLocalIdx === -1) firstLocalIdx = i;
      }
      // If there is no local model at all, the chain ends in cloud — acceptable.
      if (firstLocalIdx === -1) return true;
      return cloudOssIdx !== -1 && cloudOssIdx < firstLocalIdx;
    }

    let missingChain = [];
    let missingCloudOss = [];

    for (const [tier, capMap] of Object.entries(profiles)) {
      for (const [cap, entry] of Object.entries(capMap)) {
        const connected = entry.connected_model || '';
        if (!connected.startsWith('claude-')) continue;
        // This is a proprietary primary — check fallback coverage.
        const chain = (chains[tier] || {})[cap];
        if (!Array.isArray(chain) || chain.length === 0) {
          missingChain.push(`${tier}.${cap}`);
        } else if (!hasCloudOssBeforeLocal(chain)) {
          missingCloudOss.push(`${tier}.${cap}`);
        }
      }
    }

    assert(
      missingChain.length === 0,
      `all proprietary-primary capabilities have fallback_chains: missing=[${missingChain.join(', ')}]`
    );
    assert(
      missingCloudOss.length === 0,
      `all fallback chains contain cloud-oss before local: missing=[${missingCloudOss.join(', ')}]`
    );
  } catch (e) {
    assert(false, `fallback-chain coverage test failed: ${e.message}`);
  }
}

// ── Test 9: cloud-oss models in chains have a local terminal ──────────
console.log('\n9. Every :cloud model in fallback_chains has a local terminal after it');
{
  const shippedPath = path.join(__dirname, '..', 'config', 'model-map.json');
  try {
    const shipped = JSON.parse(fs.readFileSync(shippedPath, 'utf8'));
    const chains = shipped.fallback_chains || {};
    const profiles = shipped.llm_profiles || {};

    function hasLocalTerminal(chain) {
      // Returns true if there is at least one non-cloud, non-proprietary model
      // after the last ':cloud' entry.
      let lastCloudIdx = -1;
      for (let i = 0; i < chain.length; i++) {
        if ((chain[i].model || '').includes(':cloud')) lastCloudIdx = i;
      }
      if (lastCloudIdx === -1) return true; // no cloud entry — N/A
      for (let i = lastCloudIdx + 1; i < chain.length; i++) {
        const m = chain[i].model || '';
        if (!m.includes(':cloud') && !m.startsWith('claude-') && !m.includes('/')) return true;
      }
      return false;
    }

    let missingLocal = [];

    for (const [tier, capChains] of Object.entries(chains)) {
      for (const [cap, chain] of Object.entries(capChains)) {
        if (!Array.isArray(chain) || chain.length === 0) continue;
        // Only apply this check to chains where the capability tier is a local tier
        // (i.e., the profile's disconnect_model is a local model).
        const entry = (profiles[tier] || {})[cap];
        if (!entry) continue;
        const disconnect = entry.disconnect_model || '';
        const isLocalTier = !disconnect.includes(':cloud') && !disconnect.startsWith('claude-');
        if (!isLocalTier) continue;
        if (!hasLocalTerminal(chain)) {
          missingLocal.push(`${tier}.${cap}`);
        }
      }
    }

    assert(
      missingLocal.length === 0,
      `all local-tier chains have a local terminal after cloud-oss: missing=[${missingLocal.join(', ')}]`
    );
  } catch (e) {
    assert(false, `cloud-oss local-terminal test failed: ${e.message}`);
  }
}

// ── Test 10: model: prefix in agent_to_capability ────────────────────────────
console.log('\n10. model: prefix — validator + resolver');
{
  const { validateConfig } = require('../tools/model-map-validate.js');
  const { resolveCapabilityAlias, MODEL_PIN_PREFIX } = require('../tools/model-map-resolve.js');

  // 10a: validator accepts model: prefix without requiring it to be in llm_profiles
  const errors10a = [];
  const cfg10a = {
    llm_profiles: { '64gb': { judge: { connected_model: 'claude-opus-4-6', disconnect_model: 'qwen3:1.7b' } } },
    agent_to_capability: { 'test-agent': 'model:qwen3.5:9b' },
    endpoints: { anthropic: { url: 'http://localhost', format: 'anthropic', auth: 'none' } },
  };
  validateConfig(cfg10a, errors10a);
  assert(errors10a.length === 0, 'model: prefix value passes validator (no alias-existence check)');

  // 10b: validator rejects model: prefix with empty model name
  const errors10b = [];
  const cfg10b = { ...cfg10a, agent_to_capability: { 'test-agent': 'model:' } };
  validateConfig(cfg10b, errors10b);
  assert(errors10b.some(e => e.includes('non-empty')), 'model: prefix with empty name is rejected');

  // 10c: resolveCapabilityAlias returns raw model: value from agent_to_capability
  const cfg10c = { agent_to_capability: { implementer: 'model:qwen3.5:9b' } };
  const alias = resolveCapabilityAlias('implementer', cfg10c, '64gb');
  assert(alias === 'model:qwen3.5:9b', 'resolveCapabilityAlias returns model: prefixed value');

  // 10d: MODEL_PIN_PREFIX exported and equals 'model:'
  assert(MODEL_PIN_PREFIX === 'model:', "MODEL_PIN_PREFIX exported from model-map-resolve.js as 'model:'");

  // 10e: cycle guard — model: pin → agent name that also has model: pin terminates (not stack-overflow).
  //      Covered at runtime by the existing seen-set in resolveBackend which detects revisits.
  //      Validate here that resolveCapabilityAlias does NOT recurse (it returns raw string only).
  const cfg10e = { agent_to_capability: { 'a': 'model:b', 'b': 'model:a' } };
  const aliasA = resolveCapabilityAlias('a', cfg10e, '64gb');
  assert(aliasA === 'model:b', 'resolveCapabilityAlias is non-recursive (cycle guard is in resolveBackend)');
}

// ── Test 11: applyAgentToCapabilityUpdates reset restores system default ──────
console.log('\n11. agent-reset restores system default (not null-delete)');
{
  const { applyUpdates } = require('../tools/model-map-edit.js');

  const defaults = {
    agent_to_capability: { implementer: 'deep-coder', planner: 'judge' },
    llm_profiles: { '64gb': {} },
    endpoints: {},
  };
  const withOverride = {
    ...defaults,
    agent_to_capability: { implementer: 'judge', planner: 'judge' },
  };

  // Reset implementer → should restore to 'deep-coder' from defaults
  const after = applyUpdates(withOverride, { agent_to_capability: { implementer: null } }, defaults);
  assert(
    after.agent_to_capability.implementer === 'deep-coder',
    'null reset restores implementer to system default deep-coder (not undefined/null)',
  );
  assert(
    after.agent_to_capability.planner === 'judge',
    'planner (no override) unchanged after reset',
  );

  // When agent has NO system default, null falls through to delete
  const defaultsNoPlanner = {
    agent_to_capability: { implementer: 'deep-coder' },
    llm_profiles: { '64gb': {} },
    endpoints: {},
  };
  const withExtra = {
    ...defaultsNoPlanner,
    agent_to_capability: { implementer: 'deep-coder', 'new-agent': 'judge' },
  };
  const afterExtra = applyUpdates(withExtra, { agent_to_capability: { 'new-agent': null } }, defaultsNoPlanner);
  assert(
    !Object.prototype.hasOwnProperty.call(afterExtra.agent_to_capability, 'new-agent'),
    'null reset of agent with no system default removes key from effective',
  );
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
