#!/usr/bin/env node
'use strict';
// A4 — mapping-completeness guard.
//
// For EVERY agents/*.md file, assert the documented routing chain resolves all
// the way through the production config — closing the loop between the README
// "Agent routing reference" table and reality so docs can't silently drift:
//
//   agents/<name>.md
//     → agent_to_capability[name]            (must exist)
//     → capability alias (or model:-pin)     (must resolve)
//     → llm_profiles[capability]             (must exist, unless model:-pinned)
//     → resolveProfileModel(entry,tier,mode) (non-empty for EVERY mode × tier)
//     → model_routes[model]                  (direct, regex, or @sigil endpoint)
//     → endpoints[endpoint]                  (must exist)
//
// This is the programmatic "the mapping goes all the way through the
// implementation" check. It reuses the same model-map-resolve.js exports the
// proxy and c-thru-explain use, so a green run means every README agent row is
// backed by a live, resolvable config path.
//
// Run: node test/agent-mapping-complete.test.js

const fs   = require('fs');
const path = require('path');
const {
  resolveCapabilityAlias,
  resolveProfileModel,
  resolveModelRoute,
  LLM_MODE_ENUM,
  MODEL_PIN_PREFIX,
} = require('../tools/model-map-resolve.js');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}

const REPO    = path.resolve(__dirname, '..');
const CONFIG  = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'model-map.json'), 'utf8'));
const RESERVED_AGENT_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);
const AGENTS  = fs.readdirSync(path.join(REPO, 'agents'))
  .filter(f => f.endsWith('.md') && !RESERVED_AGENT_FILES.has(f))
  .map(f => f.replace(/\.md$/, ''))
  .sort();

const MODES = [...LLM_MODE_ENUM];
const TIERS = ['16gb', '32gb', '48gb', '64gb', '128gb'];
const ROUTES    = CONFIG.model_routes || {};
const ENDPOINTS = CONFIG.endpoints || CONFIG.backends || {};

console.log(`agent-mapping-complete: ${AGENTS.length} agents × ${MODES.length} modes × ${TIERS.length} tiers\n`);

// ── 0. Roster sanity — pipeline/utility + brand-name model-pin agents ────────
// Brand leaves are generated from config/brand-agents.json; count = agents/*.md.
const BRAND_CATALOG = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'brand-agents.json'), 'utf8'));
function brandIdsFromCatalog(cat) {
  const ids = [];
  for (const a of cat.agents || []) {
    ids.push(a.id);
    for (const al of a.aliases || []) ids.push(typeof al === 'string' ? al : al.id);
  }
  return ids;
}
const BRAND_IDS = brandIdsFromCatalog(BRAND_CATALOG);
const EXPECTED_ROSTER = AGENTS.length;
assert(AGENTS.length === EXPECTED_ROSTER,
  `agents/*.md roster has ${EXPECTED_ROSTER} files (got ${AGENTS.length})`);
assert(BRAND_IDS.every(id => AGENTS.includes(id)),
  `every brand-agents.json id has agents/<id>.md (missing: ${JSON.stringify(BRAND_IDS.filter(id => !AGENTS.includes(id)))})`);
assert(AGENTS.length >= 28 + BRAND_IDS.length - 5,
  `roster grew with brand catalog (got ${AGENTS.length}, brand entries ${BRAND_IDS.length})`);

// ── 1. Every agent has an agent_to_capability entry ──────────────────────────
console.log('\n1. Every agent → agent_to_capability entry');
{
  const a2c = CONFIG.agent_to_capability || {};
  for (const agent of AGENTS) {
    assert(typeof a2c[agent] === 'string' && a2c[agent].length > 0,
      `${agent} → agent_to_capability['${agent}'] present (got ${JSON.stringify(a2c[agent])})`);
  }
}

// ── 2. Full chain resolves for every agent × mode × tier ─────────────────────
console.log('\n2. Full chain: agent → capability → model → route → endpoint (every mode × tier)');
{
  let combos = 0;
  let brokeOne = false;
  for (const agent of AGENTS) {
    const cap = resolveCapabilityAlias(agent, CONFIG);
    if (cap === null) {
      assert(false, `${agent}: resolveCapabilityAlias returned null`);
      brokeOne = true;
      continue;
    }

    const pinned = cap.startsWith(MODEL_PIN_PREFIX);
    const entry  = pinned ? null : (CONFIG.llm_profiles || {})[cap];
    if (!pinned && !entry) {
      assert(false, `${agent} → ${cap}: no llm_profiles entry and not model:-pinned`);
      brokeOne = true;
      continue;
    }

    for (const mode of MODES) {
      for (const tier of TIERS) {
        combos++;
        const model = pinned
          ? cap.slice(MODEL_PIN_PREFIX.length)
          : resolveProfileModel(entry, tier, mode);
        if (!model || typeof model !== 'string') {
          assert(false, `${agent} → ${cap} @ ${mode}/${tier}: empty model (got ${JSON.stringify(model)})`);
          brokeOne = true;
          continue;
        }
        const resolved = resolveModelRoute(model, {
          routes: ROUTES,
          endpoints: ENDPOINTS,
          mode,
          latest_models: CONFIG.latest_models,
        });
        if (!resolved?.endpointId) {
          assert(false, `${agent} → ${cap} @ ${mode}/${tier} model='${model}': no model_routes match`);
          brokeOne = true;
          continue;
        }
        const { endpointId } = resolved;
        if (!ENDPOINTS[endpointId]) {
          assert(false, `${agent} → ${cap} @ ${mode}/${tier} model='${model}' endpoint='${endpointId}': not in endpoints`);
          brokeOne = true;
          continue;
        }
      }
    }
  }
  if (!brokeOne) {
    assert(true, `all ${combos} agent×mode×tier chains resolve to a live endpoint`);
  }
}

// ── 3. Documented non-1:1 remaps + brand model: pins ─────────────────────────
console.log('\n3. Documented non-1:1 remaps hold (guards the README "⚠" rows + brand pins)');
{
  const a2c = CONFIG.agent_to_capability || {};
  assert(a2c['plan-reviewer'] === 'code-reviewer',
    `plan-reviewer → code-reviewer (got ${JSON.stringify(a2c['plan-reviewer'])})`);
  assert(a2c['plan-scheduler'] === 'fast-generalist',
    `plan-scheduler → fast-generalist (got ${JSON.stringify(a2c['plan-scheduler'])})`);
  assert(a2c['advisors'] === 'planner-hard',
    `advisors → planner-hard (got ${JSON.stringify(a2c['advisors'])})`);
  // Brand agents pin via model: (catalog is source of truth).
  const brandPins = {};
  for (const a of BRAND_CATALOG.agents || []) {
    brandPins[a.id] = a.pin;
    for (const al of a.aliases || []) {
      const id = typeof al === 'string' ? al : al.id;
      brandPins[id] = typeof al === 'string' ? a.pin : (al.pin || a.pin);
    }
  }
  for (const [agent, pin] of Object.entries(brandPins)) {
    assert(a2c[agent] === pin,
      `${agent} → brand pin ${pin} (got ${JSON.stringify(a2c[agent])})`);
  }
  // Claude-family brand leaves pin through their public shorthands.
  for (const name of ['opus', 'sonnet', 'haiku', 'fable']) {
    assert(a2c[name] === `model:${name}` && typeof CONFIG.latest_models?.[name] === 'string',
      `${name} brand leaf pins model:${name} with latest_models expansion (got ${JSON.stringify(a2c[name])})`);
  }
  // Every OTHER agent maps 1:1 to its own name.
  const remapped = new Set(['plan-reviewer', 'plan-scheduler', 'advisors', ...Object.keys(brandPins)]);
  for (const agent of AGENTS) {
    if (remapped.has(agent)) continue;
    assert(a2c[agent] === agent,
      `${agent} maps 1:1 (capability === name) (got ${JSON.stringify(a2c[agent])})`);
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
