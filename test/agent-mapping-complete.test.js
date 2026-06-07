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
const AGENTS  = fs.readdirSync(path.join(REPO, 'agents'))
  .filter(f => f.endsWith('.md'))
  .map(f => f.replace(/\.md$/, ''))
  .sort();

const MODES = [...LLM_MODE_ENUM];
const TIERS = ['16gb', '32gb', '48gb', '64gb', '128gb'];
const ROUTES    = CONFIG.model_routes || {};
const ENDPOINTS = CONFIG.endpoints || CONFIG.backends || {};

// Resolve a model name to its endpoint id via model_routes (direct key, then
// regex `re:` key), honoring an explicit @sigil endpoint pin. Mirrors the
// proxy's resolveBackend route lookup. Returns null on no match.
function routeEndpointId(model) {
  const sig = typeof model === 'string' ? model.match(/^(.+)@([A-Za-z0-9_-]+)$/) : null;
  const base = sig ? sig[1] : model;
  if (sig) return { base, endpointId: sig[2] };
  let route = Object.prototype.hasOwnProperty.call(ROUTES, base) ? ROUTES[base] : undefined;
  if (route === undefined) {
    for (const k of Object.keys(ROUTES)) {
      if (!k.startsWith('re:')) continue;
      try { if (new RegExp(k.slice(3)).test(base)) { route = ROUTES[k]; break; } } catch {}
    }
  }
  if (route === undefined) return { base, endpointId: null };
  if (typeof route === 'string') return { base, endpointId: route };
  if (route && typeof route === 'object') return { base, endpointId: route.endpoint || null };
  return { base, endpointId: null };
}

console.log(`agent-mapping-complete: ${AGENTS.length} agents × ${MODES.length} modes × ${TIERS.length} tiers\n`);

// ── 0. Roster sanity — exactly the documented 22-agent fleet ─────────────────
assert(AGENTS.length === 22, `agents/*.md roster has 22 files (got ${AGENTS.length})`);

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
        const { base, endpointId } = routeEndpointId(model);
        if (!endpointId) {
          assert(false, `${agent} → ${cap} @ ${mode}/${tier} model='${base}': no model_routes match`);
          brokeOne = true;
          continue;
        }
        if (!ENDPOINTS[endpointId]) {
          assert(false, `${agent} → ${cap} @ ${mode}/${tier} model='${base}' endpoint='${endpointId}': not in endpoints`);
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

// ── 3. The two documented non-1:1 remaps are exactly as the README claims ─────
console.log('\n3. Documented non-1:1 remaps hold (guards the README "⚠" rows)');
{
  const a2c = CONFIG.agent_to_capability || {};
  assert(a2c['reviewer-plan'] === 'code-reviewer',
    `reviewer-plan → code-reviewer (got ${JSON.stringify(a2c['reviewer-plan'])})`);
  assert(a2c['plan-scheduler'] === 'fast-generalist',
    `plan-scheduler → fast-generalist (got ${JSON.stringify(a2c['plan-scheduler'])})`);
  // Every OTHER agent maps 1:1 to its own name.
  const remapped = new Set(['reviewer-plan', 'plan-scheduler']);
  for (const agent of AGENTS) {
    if (remapped.has(agent)) continue;
    assert(a2c[agent] === agent,
      `${agent} maps 1:1 (capability === name) (got ${JSON.stringify(a2c[agent])})`);
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
