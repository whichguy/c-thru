#!/usr/bin/env node
'use strict';
// Unit-test the SHIPPED config/model-map.json across (capability × mode × tier).
// Drives resolveProfileModel directly — no proxy spawn — so it runs in milliseconds
// and gives precise failure attribution: "FAIL 64gb/best-cloud/judge: served_by=null"
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

// New schema: llm_profiles[capability][mode][tier]
// Capability names are top-level keys; tiers are inside mode objects.
const CAPS  = Object.keys(profiles).sort();
const TIERS = ['16gb', '32gb', '48gb', '64gb', '128gb'];
const MODES = [...LLM_MODE_ENUM].sort();

console.log(`resolution-coverage: ${CAPS.length} capabilities × ${MODES.length} modes × ${TIERS.length} tiers (shipped config)\n`);

// ── Test 1: every (capability × mode × tier) cell resolves to non-null ─────
// resolveProfileModel falls back to 'best-cloud' for modes with no explicit entry,
// so null means the capability has no best-cloud entry at that tier either.
console.log('1. every defined capability resolves to a non-null model in best-cloud mode');
let nullCount = 0;
let totalCells = 0;

for (const cap of CAPS) {
  const entry = profiles[cap];
  for (const tier of TIERS) {
    totalCells++;
    const resolved = resolveProfileModel(entry, tier, 'best-cloud');
    if (resolved == null || resolved === '') {
      nullCount++;
      if (nullCount <= 10) {
        assert(false, `${cap}/${tier}/best-cloud: resolved to null/empty`);
      }
    }
  }
}
assertEq(nullCount, 0, `no null resolutions across ${totalCells} best-cloud cells`);

// ── Test 2: critical capabilities are defined at every tier ────────────────
// If a capability is missing from a tier, agents that route to it will fail.
console.log('\n2. critical capabilities defined (non-null best-cloud) at every tier');
const CRITICAL = ['coder', 'explore', 'planner', 'generalist'];

for (const cap of CRITICAL) {
  const entry = profiles[cap];
  assert(!!entry, `capability '${cap}' exists in shipped config`);
  for (const tier of TIERS) {
    const resolved = entry ? resolveProfileModel(entry, tier, 'best-cloud') : null;
    assert(!!resolved, `'${cap}' at tier '${tier}' resolves in best-cloud mode`);
  }
}

// ── Test 3: all 5 modes resolve for coder at each tier ─────────────────────
// coder is the primary coding capability. If any mode fails to resolve,
// basic routing is broken for that tier+mode combo.
console.log('\n3. all 5 modes resolve for coder at every tier');
{
  const coderEntry = profiles['coder'];
  assert(!!coderEntry, 'coder capability is present in shipped config');
  if (coderEntry) {
    for (const mode of MODES) {
      for (const tier of TIERS) {
        const resolved = resolveProfileModel(coderEntry, tier, mode);
        assert(!!resolved, `coder/${tier}/${mode} resolves to non-null`);
      }
    }
  }
}

// ── Test 4: mode fallback works — unknown mode falls back to best-cloud ────
// resolveProfileModel falls back to best-cloud when the requested mode has no
// entry. This is the graceful-degradation path; it must not return null.
console.log('\n4. unknown mode falls back to best-cloud (graceful degradation)');
{
  const coderEntry = profiles['coder'];
  if (coderEntry) {
    const resolved = resolveProfileModel(coderEntry, '64gb', 'nonexistent-mode-xyz');
    assert(resolved != null && resolved !== '',
      `coder/64gb/nonexistent-mode-xyz falls back to best-cloud (got ${resolved})`);
    const cloud = resolveProfileModel(coderEntry, '64gb', 'best-cloud');
    assertEq(resolved, cloud,
      `fallback value matches best-cloud resolution (${cloud})`);
  }
}

// ── Test 5: agent_to_capability values all map to known capabilities ────────
// If an agent maps to a capability not in llm_profiles, requests to that agent
// will fail at runtime (capability lookup returns null → 404/503).
console.log('\n5. every agent_to_capability target is a known capability in llm_profiles');
const a2c = config.agent_to_capability || {};
const targetCaps = new Set(Object.values(a2c));
let missingCaps = 0;
for (const target of targetCaps) {
  if (!Object.prototype.hasOwnProperty.call(profiles, target)) {
    missingCaps++;
    if (missingCaps <= 5) {
      const orphanAgents = Object.entries(a2c).filter(([, c]) => c === target).map(([a]) => a);
      assert(false, `capability '${target}' referenced by agents [${orphanAgents.join(', ')}] is missing from llm_profiles`);
    }
  }
}
assertEq(missingCaps, 0, 'every agent_to_capability target exists in llm_profiles');

// ── Test 6: model_overrides has no cycles ─────────────────────────────────
console.log('\n6. model_overrides has no cycles');
const overrides = config.model_overrides || {};
for (const start of Object.keys(overrides)) {
  const visited = new Set();
  let cur = start;
  while (Object.prototype.hasOwnProperty.call(overrides, cur)) {
    if (visited.has(cur)) {
      assert(false, `model_overrides cycle detected involving '${cur}' (chain from '${start}')`);
      break;
    }
    visited.add(cur);
    cur = overrides[cur];
  }
}
assert(true, 'model_overrides has no cycles');

// ── Test 7: every agent file model: name is in agent_to_capability ─────────
console.log('\n7. every agent file model: name is in agent_to_capability');
const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const agentFiles = fs.readdirSync(AGENTS_DIR)
  .filter(f => f.endsWith('.md'))
  .sort();

let agentIssues = 0;
const agentModelNames = new Set();

for (const filename of agentFiles) {
  const basename = path.basename(filename, '.md');
  const content = fs.readFileSync(path.join(AGENTS_DIR, filename), 'utf8');

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    agentIssues++;
    assert(false, `${filename}: no YAML frontmatter found`);
    continue;
  }

  const modelMatch = frontmatterMatch[1].match(/^model:\s*(.+)$/m);
  if (!modelMatch) {
    agentIssues++;
    assert(false, `${filename}: no model: field in frontmatter`);
    continue;
  }

  const modelName = modelMatch[1].trim();
  agentModelNames.add(modelName);

  if (modelName !== basename) {
    agentIssues++;
    assert(false, `${filename}: model: '${modelName}' doesn't match filename '${basename}'`);
  }

  if (!Object.prototype.hasOwnProperty.call(a2c, modelName)) {
    agentIssues++;
    assert(false, `${filename}: model '${modelName}' not in agent_to_capability`);
  }
}

assertEq(agentIssues, 0,
  `no agent file / agent_to_capability mismatches (${agentFiles.length} agents checked)`);

const ghostEntries = Object.keys(a2c).filter(k => !agentModelNames.has(k));
if (ghostEntries.length > 0) {
  console.log(`  NOTE  ${ghostEntries.length} config-only alias(es) in agent_to_capability with no .md file: [${ghostEntries.join(', ')}]`);
}

// ── Test 8: model names in llm_profiles are routable ─────────────────────
// Models with @backend sigils are self-routing. Others must be in model_routes.
// Catches stale names after renames or new names never registered.
console.log('\n8. every model name referenced in llm_profiles exists in model_routes or has @sigil');

const modelRoutes = config.model_routes || {};
const SIGIL_RE = /^(.+)@([A-Za-z0-9_-]+)$/;

function isRoutable(model) {
  if (!model) return false;
  if (SIGIL_RE.test(model)) return true;
  if (Object.prototype.hasOwnProperty.call(modelRoutes, model)) return true;
  return Object.keys(modelRoutes).some(k => {
    if (!k.startsWith('re:')) return false;
    try { return new RegExp(k.slice(3)).test(model); } catch { return false; }
  });
}

let unroutableCount = 0;
const seenUnroutable = new Set();
for (const cap of CAPS) {
  const capEntry = profiles[cap];
  if (!capEntry || typeof capEntry !== 'object') continue;
  for (const [key, modeOrMeta] of Object.entries(capEntry)) {
    // Skip non-mode metadata keys at capability level
    if (key === 'on_failure' || key === 'fallback_to') continue;
    if (typeof modeOrMeta !== 'object' || modeOrMeta === null) continue;
    // modeOrMeta is the tier→model map for this mode
    for (const model of Object.values(modeOrMeta)) {
      if (typeof model !== 'string') continue;
      if (!isRoutable(model)) {
        unroutableCount++;
        const key2 = `${model}`;
        if (!seenUnroutable.has(key2)) {
          seenUnroutable.add(key2);
          assert(false, `model '${model}' (referenced in ${cap}) is not in model_routes`);
        }
      }
    }
  }
}
assertEq(unroutableCount, 0, `no unroutable model names across all profile entries`);

console.log(`\nCovered: ${totalCells} best-cloud cells, ${CAPS.length} capabilities`);
const failed = summary();
process.exit(failed ? 1 : 0);
