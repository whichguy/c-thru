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

// ── Test 8: every model name referenced in profiles is routable ──────────
// resolveProfileModel returns a string but never checks model_routes. A model
// name that's absent from model_routes causes a silent passthrough at runtime
// (the proxy may forward it as-is to the wrong backend, or error). This test
// catches stale names after renames and new names that were never registered.
console.log('\n8. every model name referenced in llm_profiles exists in model_routes');

const modelRoutes = config.model_routes || {};
const SIGIL_RE = /^(.+)@([A-Za-z0-9_-]+)$/;

function isRoutable(model) {
  if (!model) return false;
  if (SIGIL_RE.test(model)) return true; // @backend sigil — self-routing
  if (Object.prototype.hasOwnProperty.call(modelRoutes, model)) return true;
  // match regex-pattern keys (re:...)
  return Object.keys(modelRoutes).some(k => {
    if (!k.startsWith('re:')) return false;
    try { return new RegExp(k.slice(3)).test(model); } catch { return false; }
  });
}

let unroutableCount = 0;
const seenUnroutable = new Set();
for (const tier of TIERS) {
  const tierProfile = profiles[tier] || {};
  for (const [cap, entry] of Object.entries(tierProfile)) {
    const candidates = [
      entry.connected_model,
      entry.disconnect_model,
      entry.cloud_best_model,
      entry.local_best_model,
      ...Object.values(entry.modes || {}),
    ].filter(Boolean);
    for (const model of candidates) {
      if (!isRoutable(model)) {
        unroutableCount++;
        const key = `${model}`;
        if (!seenUnroutable.has(key)) {
          seenUnroutable.add(key);
          assert(false, `model '${model}' (referenced in ${tier}/${cap}) is not in model_routes`);
        }
      }
    }
  }
}
assertEq(unroutableCount, 0, `no unroutable model names across all profile entries`);

// ── Test 9: model_overrides has no cycles ─────────────────────────────────
// model_overrides is applied unconditionally before route resolution. A→B→A
// would cause infinite loops. model-map-validate.js catches self-maps (A→A)
// but not multi-hop cycles.
console.log('\n9. model_overrides has no cycles');
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

// ── Test 10: best-opensource-local/cloud overrides on judge/judge-strict at 48gb+ ─
// best-opensource-local must be a LOCAL model (never :cloud) — it's the best
// in-process open-source judge for the form factor, chosen to minimise extra
// memory pressure on top of what's already warm at that tier.
// best-opensource-cloud must be a cloud model (ends with :cloud).
// If these entries vanish the modes fall through to disconnect_model silently.
console.log('\n10. best-opensource-local/cloud overrides on judge/judge-strict at 48gb+');
for (const tier of ['48gb', '64gb', '128gb']) {
  for (const cap of ['judge', 'judge-strict']) {
    const entry = profiles[tier]?.[cap];
    if (!entry) continue;
    const localOverride = entry.modes?.['best-opensource-local'];
    assert(typeof localOverride === 'string' && localOverride.length > 0,
      `${tier}/${cap} has modes['best-opensource-local'] (got ${JSON.stringify(localOverride)})`);
    assert(!localOverride?.endsWith(':cloud'),
      `${tier}/${cap} best-opensource-local must be a local model, not cloud (got ${localOverride})`);
    const cloudOverride = entry.modes?.['best-opensource-cloud'];
    assert(typeof cloudOverride === 'string' && cloudOverride.length > 0,
      `${tier}/${cap} has modes['best-opensource-cloud'] (got ${JSON.stringify(cloudOverride)})`);
    assert(cloudOverride?.endsWith(':cloud'),
      `${tier}/${cap} best-opensource-cloud must be a cloud model (got ${cloudOverride})`);
  }
}

// ── Test 11: every agent file's model: name is in agent_to_capability ─────
// Agents injected via --agents have a `model:` frontmatter field. That value
// is what Claude Code sends in requests. If it's absent from agent_to_capability
// the proxy never routes it through the capability tier system — it falls
// through as a raw model name (wrong tier, wrong backend).
//
// Also checks filename == model: to surface copy-paste divergence where the
// file is `foo.md` but declares `model: bar` — Claude routes as `bar` but the
// file was registered as `foo`, causing silent wrong-agent routing.
//
// Config-only aliases (e.g. judge-evaluator) have no .md file intentionally;
// they are listed informally but do NOT fail the test.
console.log('\n11. every agent file model: name is in agent_to_capability');
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

// ── Test 12: local model RAM fits within tier capacity minus headroom ──────
// Cloud models (backed by ollama_cloud, anthropic, or openrouter) have no
// local RAM requirement and are skipped. Models absent from benchmark.json
// are noted but not failed.
//
// Representative machine RAM per tier (tier name = typical machine size):
//   16gb=16, 32gb=32, 48gb=48, 64gb=64, 128gb=128
// Headroom per tier (OS + Claude Code overhead):
//   16gb: 6GB  — minimal setup, fewer background processes
//   32gb+: 10GB — general-purpose machines with typical load
// Applies to all profile slots: connected, disconnect, local_best, modes.
console.log('\n12. local model RAM fits within tier capacity minus 12GB headroom');

const BENCHMARK_PATH = path.join(__dirname, '..', 'docs', 'benchmark.json');
const benchModels = JSON.parse(fs.readFileSync(BENCHMARK_PATH, 'utf8')).models || {};

const TIER_RAM_GB      = { '16gb': 16, '32gb': 32, '48gb': 48, '64gb': 64, '128gb': 128 };
const TIER_HEADROOM_GB = { '16gb':  6, '32gb': 10, '48gb': 10, '64gb': 10, '128gb':  10 };

function isLocalRoute(modelName) {
  if (!modelName) return false;
  const sigilMatch = /^(.+)@([A-Za-z0-9_-]+)$/.exec(modelName);
  if (sigilMatch) return sigilMatch[2] === 'ollama_local';
  const route = modelRoutes[modelName];
  return route === 'ollama_local';
}

let ramViolations = 0;
const noRamData = new Set();
const modeOverfits = [];  // mode overrides that exceed headroom — explicit opt-ins, noted not failed

for (const tier of TIERS) {
  const tierRam = TIER_RAM_GB[tier];
  if (tierRam == null) continue;
  const headroom = TIER_HEADROOM_GB[tier] || 10;
  const available = tierRam - headroom;
  const tierProfile = profiles[tier] || {};

  for (const [cap, entry] of Object.entries(tierProfile)) {
    const defaultSlots = {
      connected_model:  entry.connected_model,
      disconnect_model: entry.disconnect_model,
      local_best_model: entry.local_best_model,
      cloud_best_model: entry.cloud_best_model,
    };
    const modeSlots = Object.fromEntries(
      Object.entries(entry.modes || {}).map(([k, v]) => [`modes.${k}`, v])
    );

    for (const [slot, model] of Object.entries(defaultSlots)) {
      if (!model || !isLocalRoute(model)) continue;
      const meta = benchModels[model];
      if (!meta) { noRamData.add(model); continue; }
      if (meta.ram_gb == null) continue;
      if (meta.ram_gb > available) {
        ramViolations++;
        assert(false,
          `${tier}/${cap}/${slot}: '${model}' needs ${meta.ram_gb}GB but tier allows ${available}GB (${tierRam}GB - ${headroom}GB headroom)`);
      }
    }

    for (const [slot, model] of Object.entries(modeSlots)) {
      if (!model || !isLocalRoute(model)) continue;
      const meta = benchModels[model];
      if (!meta) { noRamData.add(model); continue; }
      if (meta.ram_gb == null) continue;
      if (meta.ram_gb > available) {
        modeOverfits.push(`${tier}/${cap}/${slot}: '${model}' needs ${meta.ram_gb}GB > ${available}GB available (${tierRam}GB - ${headroom}GB headroom)`);
      }
    }
  }
}

assertEq(ramViolations, 0, `no RAM capacity violations in default slots across all tiers`);
if (modeOverfits.length > 0) {
  console.log(`  NOTE  ${modeOverfits.length} mode override(s) exceed headroom (explicit opt-in, not a FAIL):`);
  for (const m of modeOverfits) console.log(`    ${m}`);
}
if (noRamData.size > 0) {
  const sorted = [...noRamData].sort();
  console.log(`  NOTE  ${noRamData.size} local model(s) not in benchmark.json (RAM unknown, skipped): [${sorted.join(', ')}]`);
}

// ── Test 13: cloud connected_model always has a local disconnect_model ───────
// When the network is disconnected, the proxy falls back to disconnect_model.
// If connected_model is cloud but disconnect_model is also cloud, the fallback
// path is broken in fully-offline scenarios. Every cloud-connected capability
// must have a local (ollama_local) disconnect_model.
//
// Exception: capabilities where connected_model IS a local model (e.g., 16gb
// tiers often use local-only for both slots — that's fine, no cloud dependency).
// Also: capabilities where both slots are identical and local (intended offline-only).
console.log('\n13. cloud connected_model always has a local disconnect_model fallback');

// Build set of models that route to non-local destinations
function isCloudModel(model) {
  if (!model) return false;
  const sigilMatch = SIGIL_RE.exec(model);
  if (sigilMatch) {
    const backend = sigilMatch[2];
    return backend !== 'ollama_local';
  }
  const route = modelRoutes[model];
  return route != null && route !== 'ollama_local';
}

let cloudFallbackViolations = 0;
const cloudFallbackNotes = [];

for (const tier of TIERS) {
  const tierProfile = profiles[tier] || {};
  for (const [cap, entry] of Object.entries(tierProfile)) {
    const connected  = entry.connected_model;
    const disconnect = entry.disconnect_model;
    if (!isCloudModel(connected)) continue;  // local connected — no fallback constraint
    if (isLocalRoute(disconnect)) continue;   // local disconnect — all good
    // disconnect is cloud too — is it the same model? (intentional cloud-only tier)
    // Cloud-only tiers are allowed on capabilities backed by hard_fail (caller already
    // expects a cloud-only hard_fail contract) but flagged if on cascade capabilities.
    if (connected === disconnect && entry.on_failure === 'hard_fail') {
      cloudFallbackNotes.push(
        `${tier}/${cap}: connected=disconnect=${connected} (hard_fail cloud-only, no local fallback)`
      );
      continue;
    }
    cloudFallbackViolations++;
    assert(false,
      `${tier}/${cap}: connected_model='${connected}' is cloud but disconnect_model='${disconnect}' is also cloud — no local fallback`);
  }
}

assertEq(cloudFallbackViolations, 0,
  'every cloud-connected capability has a local disconnect_model (offline fallback)');
if (cloudFallbackNotes.length > 0) {
  console.log(`  NOTE  ${cloudFallbackNotes.length} cloud-only hard_fail slot(s) (no local fallback by design):`);
  for (const n of cloudFallbackNotes) console.log(`    ${n}`);
}

// ── Test 14: phi4-reasoning:plus not used as judge-tier disconnect_model ────
// Tournament (2026-04-25): phi4-reasoning:plus regresses on J1/J2 judge prompts
// (q=1, 464–1137s). phi4-reasoning:latest scores q=5 across all four judge prompts.
// :plus must not be the fallback for judge/judge-strict/large-general capabilities.
console.log('\n14. phi4-reasoning:plus not used as disconnect_model for judge-tier capabilities');
const JUDGE_CAPS = new Set(['judge', 'judge-strict', 'large-general', 'evaluator', 'auditor']);

let phi4PlusViolations = 0;
for (const tier of TIERS) {
  const tierProfile = profiles[tier] || {};
  for (const [cap, entry] of Object.entries(tierProfile)) {
    if (!JUDGE_CAPS.has(cap)) continue;
    for (const slot of ['disconnect_model', 'local_best_model']) {
      if (entry[slot] === 'phi4-reasoning:plus') {
        phi4PlusViolations++;
        assert(false,
          `${tier}/${cap}/${slot}: phi4-reasoning:plus regresses on judge prompts J1/J2 — use phi4-reasoning:latest`);
      }
    }
  }
}
assertEq(phi4PlusViolations, 0,
  'no judge-tier capabilities use phi4-reasoning:plus as fallback (tournament regression)');

console.log(`\nCovered: ${totalCells} (capability × mode × tier) cells`);
const failed = summary();
process.exit(failed ? 1 : 0);
