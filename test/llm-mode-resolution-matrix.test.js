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

// Mirrors resolveProfileModel() in tools/claude-proxy and model-map-resolve.js
function resolveProfileModel(entry, mode) {
  if (!entry) return null;
  if (entry.modes && Object.prototype.hasOwnProperty.call(entry.modes, mode)) {
    return entry.modes[mode];
  }
  if (mode === 'offline') return entry.disconnect_model;
  if (mode === 'connected') return entry.connected_model;
  if (mode === 'semi-offload' || mode === 'cloud-judge-only') return entry.disconnect_model;
  if (mode === 'cloud-best-quality') return entry.cloud_best_model ?? entry.connected_model;
  if (mode === 'local-best-quality') return entry.local_best_model ?? entry.disconnect_model;
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
  assert(opusEntry && opusEntry.equivalents && opusEntry.equivalents.includes('qwen3.6:35b'), 'equivalents includes qwen3.6:35b');
}

// ── 10. cloud-best-quality: uses cloud_best_model ?? connected_model ──
console.log('\n10. cloud-best-quality: cloud_best_model preferred, falls back to connected_model');
{
  for (const tier of ['48gb', '64gb', '128gb']) {
    const entry = profiles[tier] && profiles[tier]['judge'];
    const model = resolveProfileModel(entry, 'cloud-best-quality');
    assert(model === 'claude-opus-4-6', `${tier} judge cloud-best-quality → claude-opus-4-6 (got ${model})`);

    const orchEntry = profiles[tier] && profiles[tier]['orchestrator'];
    const orchModel = resolveProfileModel(orchEntry, 'cloud-best-quality');
    assert(orchModel === 'claude-sonnet-4-6', `${tier} orchestrator cloud-best-quality → claude-sonnet-4-6 (got ${orchModel})`);
  }
  // Entry without cloud_best_model falls through to connected_model
  const syntheticEntry = { connected_model: 'model-conn', disconnect_model: 'model-disc' };
  assert(resolveProfileModel(syntheticEntry, 'cloud-best-quality') === 'model-conn',
    'entry without cloud_best_model falls through to connected_model');
}

// ── 11. local-best-quality: uses local_best_model ?? disconnect_model ─
console.log('\n11. local-best-quality: local_best_model preferred, falls back to disconnect_model');
{
  for (const tier of ['48gb', '64gb', '128gb']) {
    const entry = profiles[tier] && profiles[tier]['judge'];
    const model = resolveProfileModel(entry, 'local-best-quality');
    assert(model === 'qwen3.6:35b', `${tier} judge local-best-quality → qwen3.6:35b (got ${model})`);

    const deepCoderEntry = profiles[tier] && profiles[tier]['deep-coder'];
    if (deepCoderEntry && deepCoderEntry.local_best_model) {
      const dcModel = resolveProfileModel(deepCoderEntry, 'local-best-quality');
      assert(typeof dcModel === 'string' && dcModel.length > 0,
        `${tier} deep-coder local-best-quality → non-empty model (got ${dcModel})`);
    }
  }
  // Entry without local_best_model falls through to disconnect_model
  const syntheticEntry = { connected_model: 'model-conn', disconnect_model: 'model-disc' };
  assert(resolveProfileModel(syntheticEntry, 'local-best-quality') === 'model-disc',
    'entry without local_best_model falls through to disconnect_model');
}

// ── 12. local-terminal guarantee: disconnect_model always local ────────
console.log('\n12. local-terminal guarantee: all disconnect_model entries are local (not cloud, not anthropic)');
{
  const localSuffixes = ['ollama_local'];
  const modelRoutes = shipped.model_routes || {};
  for (const [tier, tierProfile] of Object.entries(profiles)) {
    for (const [cap, entry] of Object.entries(tierProfile)) {
      if (!entry || typeof entry !== 'string') {
        const dm = entry && entry.disconnect_model;
        if (!dm) continue;
        // The model must NOT be a cloud API model (claude-*) or end with :cloud
        const isCloudApi = /^claude-/i.test(dm);
        const isCloudSuffix = dm.endsWith(':cloud');
        assert(!isCloudApi && !isCloudSuffix,
          `${tier}.${cap}.disconnect_model '${dm}' is local (not cloud API, not :cloud suffix)`);
      }
    }
  }
}

// ── 13. quality-tolerance tiebreaker logic ─────────────────────────────
console.log('\n13. quality-tolerance tiebreaker: within 5% band, higher speed_score wins');
{
  // Simulates applyQualityTolerance with tolerance=5%
  function applyQualityTolerance(candidates, tolerancePct) {
    if (candidates.length <= 1) return candidates;
    const topScore = candidates[0].quality_score ?? 0;
    const threshold = topScore * (1 - tolerancePct / 100);
    const inBand = candidates.filter(c => (c.quality_score ?? 0) >= threshold);
    const outBand = candidates.filter(c => (c.quality_score ?? 0) < threshold);
    inBand.sort((a, b) => (b.speed_score ?? 0) - (a.speed_score ?? 0));
    return [...inBand, ...outBand];
  }

  // Chain: A=95, B=93, C=80 — tolerance 5%. With A failing (cooled), band check from A.
  // 5% of 95 = 4.75, threshold = 90.25. B=93 is in-band, C=80 is out-of-band.
  // Top candidate A=95, threshold = 95 * 0.95 = 90.25.
  // In-band: A(95), B(93). Out-band: C(80).
  // Speed: A=50, B=70, C=95. Within in-band, sort by speed: B(70) > A(50).
  // Reordered: B, A, C.
  const chain = [
    { model: 'A', quality_score: 95, speed_score: 50 },
    { model: 'B', quality_score: 93, speed_score: 70 },
    { model: 'C', quality_score: 80, speed_score: 95 },
  ];
  const reordered = applyQualityTolerance(chain, 5);
  assert(reordered[0].model === 'B', `tiebreaker: first pick is B (in-band, highest speed) (got ${reordered[0].model})`);
  assert(reordered[1].model === 'A', `tiebreaker: second pick is A (in-band, lower speed) (got ${reordered[1].model})`);
  assert(reordered[2].model === 'C', `tiebreaker: third pick is C (out-of-band) (got ${reordered[2].model})`);

  // Strict quality with no speed advantage: order preserved within band
  const chain2 = [
    { model: 'X', quality_score: 100, speed_score: 50 },
    { model: 'Y', quality_score: 80,  speed_score: 90 },
  ];
  const reordered2 = applyQualityTolerance(chain2, 5);
  // 5% of 100 = 5, threshold = 95. Y=80 is out-of-band. Order: X, Y.
  assert(reordered2[0].model === 'X', 'out-of-band candidate stays after in-band (got ' + reordered2[0].model + ')');
  assert(reordered2[1].model === 'Y', 'out-of-band Y stays at position 2 (got ' + reordered2[1].model + ')');
}

// ── 14. fallback_chains present for seeded capabilities ───────────────
console.log('\n14. fallback_chains seeded for key capabilities');
{
  const chains = shipped.fallback_chains || {};
  for (const tier of ['48gb', '64gb', '128gb']) {
    for (const cap of ['judge', 'orchestrator', 'deep-coder', 'local-planner', 'coder', 'workhorse']) {
      assert(Array.isArray(chains[tier] && chains[tier][cap]),
        `fallback_chains[${tier}][${cap}] is an array`);
      const chain = chains[tier] && chains[tier][cap];
      assert(chain && chain.length >= 2, `fallback_chains[${tier}][${cap}] has at least 2 candidates`);
      const allHaveModel = chain && chain.every(c => typeof c.model === 'string' && c.model.length > 0);
      assert(allHaveModel, `fallback_chains[${tier}][${cap}] all candidates have model string`);
    }
  }
}

// ── 15. resolveProfileModel null-guard ────────────────────────────────
console.log('\n15. resolveProfileModel: null entry returns null for all modes');
{
  for (const mode of ['connected', 'offline', 'semi-offload', 'cloud-judge-only', 'cloud-best-quality', 'local-best-quality']) {
    assert(resolveProfileModel(null, mode) === null,
      `resolveProfileModel(null, '${mode}') === null`);
  }
  assert(resolveProfileModel(undefined, 'connected') === null,
    'resolveProfileModel(undefined, connected) === null');
}

// ── 16. applyQualityTolerance: all-null scores preserves original order ──
console.log('\n16. applyQualityTolerance: all-null scores preserves original chain order');
{
  function applyQualityTolerance(candidates, tolerancePct) {
    if (candidates.length <= 1) return candidates;
    const topScore = candidates[0].quality_score ?? 0;
    const threshold = topScore * (1 - tolerancePct / 100);
    const inBand = candidates.filter(c => (c.quality_score ?? 0) >= threshold);
    const outBand = candidates.filter(c => (c.quality_score ?? 0) < threshold);
    inBand.sort((a, b) => (b.speed_score ?? 0) - (a.speed_score ?? 0));
    return [...inBand, ...outBand];
  }

  // When no candidate has quality_score, some() is false → tiebreaker skipped
  // (tested by proxy code branch: isBestQualityMode && candidateObjects.some(c => c.quality_score != null))
  // The pure tolerance function receives all-zero scores; original order preserved via stable sort.
  const nullChain = [
    { model: 'P', quality_score: null, speed_score: null },
    { model: 'Q', quality_score: null, speed_score: null },
    { model: 'R', quality_score: null, speed_score: null },
  ];
  const result = applyQualityTolerance(nullChain, 5);
  assert(result[0].model === 'P', 'null-score chain: position 0 unchanged (got ' + result[0].model + ')');
  assert(result[1].model === 'Q', 'null-score chain: position 1 unchanged (got ' + result[1].model + ')');
  assert(result[2].model === 'R', 'null-score chain: position 2 unchanged (got ' + result[2].model + ')');

  // Partially scored chain: null scores treated as 0 → fall out of band of a scored top
  const partialChain = [
    { model: 'A', quality_score: 90, speed_score: 50 },
    { model: 'B', quality_score: null, speed_score: 99 },
  ];
  const partialResult = applyQualityTolerance(partialChain, 5);
  // threshold = 90 * 0.95 = 85.5; B has effective score 0 → out-of-band → stays after A
  assert(partialResult[0].model === 'A', 'partially-scored: in-band A stays first');
  assert(partialResult[1].model === 'B', 'partially-scored: null-score B stays after A');
}

// ── 17. general-default fallback chains seeded ────────────────────────
console.log('\n17. general-default fallback chains seeded at 48gb/64gb/128gb');
{
  const chains = shipped.fallback_chains || {};
  for (const tier of ['48gb', '64gb', '128gb']) {
    const chain = chains[tier] && chains[tier]['default'];
    assert(Array.isArray(chain), `fallback_chains[${tier}][default] is an array`);
    assert(chain && chain.length >= 2, `fallback_chains[${tier}][default] has ≥2 candidates`);

    // Last candidate must be a local model (terminates on local)
    const last = chain && chain[chain.length - 1];
    const modelRoutes = shipped.model_routes || {};
    const backends = shipped.backends || {};
    const lastBackendId = last && modelRoutes[last.model];
    const lastBackend = lastBackendId && backends[lastBackendId];
    const lastIsLocal = lastBackend && lastBackend.kind === 'ollama' && !last.model.endsWith(':cloud');
    assert(lastIsLocal, `fallback_chains[${tier}][default] terminates on local model (got ${last && last.model})`);
  }
  // cloud_best_model and local_best_model set on default profile entries
  for (const tier of ['48gb', '64gb', '128gb']) {
    const entry = profiles[tier] && profiles[tier]['default'];
    assert(entry && typeof entry.cloud_best_model === 'string',
      `llm_profiles[${tier}].default has cloud_best_model`);
    assert(entry && typeof entry.local_best_model === 'string',
      `llm_profiles[${tier}].default has local_best_model`);
  }
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
