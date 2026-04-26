#!/usr/bin/env node
'use strict';
// Unit-test the SHIPPED config/model-map.json across (capability × mode × tier).
// Drives resolveProfileModel directly — no proxy spawn — so it runs in milliseconds
// and gives precise failure attribution: "FAIL 64gb/cloud-thinking/judge: served_by=null"
// instead of a generic "test broke".
//
// This catches: missing slots in shipped config, accidentally-removed capabilities,
// modes whose resolution returns null (which would hard_fail at runtime).
//
// Run: node test/resolution-coverage.test.js

const fs   = require('fs');
const path = require('path');

const {
  resolveProfileModel,
  LLM_MODE_ENUM,
} = require('../tools/model-map-resolve');

const { assert, assertEq, summary } = require('./helpers');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'model-map.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const profiles = config.llm_profiles || {};

const TIERS = Object.keys(profiles).sort();
const MODES = [...LLM_MODE_ENUM].sort();

console.log(`resolution-coverage: ${TIERS.length} tiers × ${MODES.length} modes × N capabilities (shipped config)\n`);

// ── Test 1: every (tier × mode × capability) cell resolves to non-null ─────
console.log('1. every defined capability resolves to a non-null model in every mode');
let nullCount = 0;
let totalCells = 0;

for (const tier of TIERS) {
  const tierProfile = profiles[tier] || {};
  const caps = Object.keys(tierProfile).sort();
  for (const mode of MODES) {
    for (const cap of caps) {
      totalCells++;
      const entry = tierProfile[cap];
      const resolved = resolveProfileModel(entry, mode);
      if (resolved == null || resolved === '') {
        nullCount++;
        // First few null cells get a FAIL line; rest just counted
        if (nullCount <= 10) {
          assert(false, `${tier}/${mode}/${cap}: resolved to null/empty`);
        }
      }
    }
  }
}
assertEq(nullCount, 0, `no null resolutions across ${totalCells} cells`);

// ── Test 2: critical capabilities are defined at every tier ────────────────
// Some capabilities should exist at every tier — if they're missing, agents
// that route to them will fail unpredictably depending on the user's hardware.
console.log('\n2. critical capabilities defined at every tier');
const CRITICAL = ['workhorse', 'judge', 'deep-coder', 'orchestrator', 'coder', 'classifier'];

for (const cap of CRITICAL) {
  for (const tier of TIERS) {
    const entry = profiles[tier]?.[cap];
    assert(!!entry, `tier ${tier} has capability '${cap}' defined`);
  }
}

// ── Test 3: every capability has connected_model AND disconnect_model ─────
// Required slots — if missing, the proxy can't resolve in connected/offline modes.
console.log('\n3. every capability has connected_model and disconnect_model');
let missingSlots = 0;
for (const tier of TIERS) {
  const tierProfile = profiles[tier] || {};
  for (const [cap, entry] of Object.entries(tierProfile)) {
    if (typeof entry.connected_model !== 'string' || !entry.connected_model) {
      missingSlots++;
      if (missingSlots <= 5) {
        assert(false, `${tier}/${cap}: missing connected_model`);
      }
    }
    if (typeof entry.disconnect_model !== 'string' || !entry.disconnect_model) {
      missingSlots++;
      if (missingSlots <= 5) {
        assert(false, `${tier}/${cap}: missing disconnect_model`);
      }
    }
  }
}
assertEq(missingSlots, 0, 'no missing required slots across shipped config');

// ── Test 4: cloud-thinking has overrides on cognitive caps at 48gb+ ───────
// Documents the intent: if these override entries vanish, cloud-thinking degrades.
console.log('\n4. cloud-thinking has overrides on judge/judge-strict at 48gb+');
const COGNITIVE = ['judge', 'judge-strict'];
for (const tier of ['48gb', '64gb', '128gb']) {
  for (const cap of COGNITIVE) {
    const entry = profiles[tier]?.[cap];
    if (!entry) continue;
    const override = entry.modes?.['cloud-thinking'];
    assert(typeof override === 'string' && override.length > 0,
      `${tier}/${cap} has modes['cloud-thinking'] (got ${JSON.stringify(override)})`);
  }
}

// ── Test 5: local-review has overrides on review caps at 48gb+ ────────────
console.log('\n5. local-review has overrides on reviewer/code-analyst at 48gb+');
const REVIEW = ['reviewer', 'code-analyst'];
for (const tier of ['48gb', '64gb', '128gb']) {
  for (const cap of REVIEW) {
    const entry = profiles[tier]?.[cap];
    if (!entry) continue;
    const override = entry.modes?.['local-review'];
    assert(typeof override === 'string' && override.length > 0,
      `${tier}/${cap} has modes['local-review'] (got ${JSON.stringify(override)})`);
  }
}

// ── Test 6: agent_to_capability values all map to capabilities defined at every tier ─
// If an agent maps to a capability that isn't defined at a tier, the request
// to that agent on that hardware fails. Catches "agent X routes to nonexistent
// capability" or "capability Y is missing from tier Z".
console.log('\n6. every agent_to_capability target exists at every tier');
const a2c = config.agent_to_capability || {};
const targetCaps = new Set(Object.values(a2c));
let missingPerTier = 0;
for (const tier of TIERS) {
  const tierCaps = new Set(Object.keys(profiles[tier] || {}));
  for (const target of targetCaps) {
    if (!tierCaps.has(target)) {
      missingPerTier++;
      if (missingPerTier <= 5) {
        // List which agents reference this capability
        const orphanAgents = Object.entries(a2c).filter(([, c]) => c === target).map(([a]) => a);
        assert(false,
          `${tier}: capability '${target}' missing — referenced by agents [${orphanAgents.join(', ')}]`);
      }
    }
  }
}
assertEq(missingPerTier, 0, 'every agent_to_capability target exists at every tier');

// ── Test 7: cloud_best_model and local_best_model present where expected ──
// These slots gate cloud-best-quality and local-best-quality modes. If absent,
// resolution falls through but the "best quality" intent is silently lost.
// This test documents which capabilities have explicit quality-best slots.
console.log('\n7. capabilities with cloud_best_model / local_best_model (informational)');
let withCloudBest = 0, withLocalBest = 0;
for (const tier of TIERS) {
  for (const entry of Object.values(profiles[tier] || {})) {
    if (entry.cloud_best_model) withCloudBest++;
    if (entry.local_best_model) withLocalBest++;
  }
}
assert(withCloudBest > 0,
  `at least some capability has cloud_best_model defined (got ${withCloudBest})`);
assert(withLocalBest > 0,
  `at least some capability has local_best_model defined (got ${withLocalBest})`);

console.log(`\nCovered: ${totalCells} (capability × mode × tier) cells`);
const failed = summary();
process.exit(failed ? 1 : 0);
