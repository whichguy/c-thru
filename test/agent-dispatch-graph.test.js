#!/usr/bin/env node
'use strict';
// Inter-agent dispatch-graph validation.
//
// Each agents/*.md ends with an UNBLOCKED_TASKS block of
//   Task("…", subagent_type="X")
// calls naming the next agent(s) the orchestrator should dispatch. Today every
// target happens to resolve, but nothing ENFORCES it — c-thru-contract-check.sh
// Check 2 only validates subagent_type inside SKILL.md, and Check 8 only checks
// that an UNBLOCKED_TASKS block is *present*. An agent could ship
// subagent_type="nonexistent" undetected.
//
// This test parses EVERY agents/*.md body and extracts ALL subagent_type="…"
// tokens — active AND commented (the dispatch grammar at agents/coder.md uses
// commented Task() lines as uncommenting templates; a typo there still ships
// broken). For each referenced target X it asserts:
//   1. X is an existing agents/X.md file OR an allowlisted built-in;
//   2. X is a key in config/model-map.json#agent_to_capability;
//   3. X resolves end-to-end: capability alias → llm_profiles/model:-pin →
//      resolveProfileModel (non-empty at best-cloud/64gb) → route → endpoint.
// Plus: file roster == agent_to_capability keys minus the 3 utility
// passthroughs (WebSearch/WebFetch/Monitor), so a new agent file without a
// mapping (or vice-versa) fails closed.
//
// This is the programmatic "the agents call the right agents which map to
// models" guard. Reuses the same model-map-resolve.js exports and the
// routeEndpointId pattern from agent-mapping-complete.test.js.
//
// Run: node test/agent-dispatch-graph.test.js

const fs   = require('fs');
const path = require('path');
const {
  resolveCapabilityAlias,
  resolveProfileModel,
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
const AGENTS_DIR = path.join(REPO, 'agents');
const AGENT_FILES = fs.readdirSync(AGENTS_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => f.replace(/\.md$/, ''))
  .sort();
const AGENT_SET = new Set(AGENT_FILES);

// Claude Code built-in subagent types — not agent files, allowlisted per
// c-thru-contract-check.sh Check 2.
const BUILTINS = new Set(['general-purpose', 'Explore']);

// Reference resolution point: a target is "reachable" if it produces a live
// endpoint at the default mode and the workhorse reference tier.
const REF_MODE = 'best-cloud';
const REF_TIER = '64gb';

const ROUTES    = CONFIG.model_routes || {};
const ENDPOINTS = CONFIG.endpoints || CONFIG.backends || {};
const A2C       = CONFIG.agent_to_capability || {};

// routeEndpointId — model name → endpoint id via model_routes (direct key, then
// regex `re:` key), honoring an explicit @sigil endpoint pin. Mirrors the proxy
// resolveBackend route lookup. Identical to agent-mapping-complete.test.js.
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

// resolveTarget — full chain for a dispatch target at the reference mode/tier.
// Returns { model, endpointId } or { error }.
function resolveTarget(target) {
  const cap = resolveCapabilityAlias(target, CONFIG);
  if (cap === null) return { error: 'resolveCapabilityAlias returned null' };
  const pinned = cap.startsWith(MODEL_PIN_PREFIX);
  const entry  = pinned ? null : (CONFIG.llm_profiles || {})[cap];
  if (!pinned && !entry) return { error: `no llm_profiles entry for capability '${cap}'` };
  const model = pinned
    ? cap.slice(MODEL_PIN_PREFIX.length)
    : resolveProfileModel(entry, REF_TIER, REF_MODE);
  if (!model || typeof model !== 'string') return { error: `empty model at ${REF_MODE}/${REF_TIER}` };
  const { base, endpointId } = routeEndpointId(model);
  if (!endpointId) return { error: `model '${base}': no model_routes match` };
  if (!ENDPOINTS[endpointId]) return { error: `model '${base}' endpoint '${endpointId}': not in endpoints` };
  return { cap, model: base, endpointId };
}

// ── Parse every agent body for subagent_type tokens (active AND commented) ────
// The dispatch grammar (agents/coder.md UNBLOCKED_TASKS) places real Task()
// calls AND commented uncommenting-template Task() calls; both carry
// subagent_type="…". A typo in a commented template still ships, so we check
// ALL tokens regardless of comment status.
const SUBTYPE_RE = /subagent_type\s*=\s*"([A-Za-z0-9_-]+)"/g;

const graph = {}; // source agent → sorted unique targets
for (const agent of AGENT_FILES) {
  const body = fs.readFileSync(path.join(AGENTS_DIR, `${agent}.md`), 'utf8');
  const targets = new Set();
  let m;
  SUBTYPE_RE.lastIndex = 0;
  while ((m = SUBTYPE_RE.exec(body)) !== null) targets.add(m[1]);
  graph[agent] = [...targets].sort();
}

console.log(`agent-dispatch-graph: ${AGENT_FILES.length} agent files\n`);

// ── 0. Roster == agent_to_capability keys minus the 3 utility passthroughs ────
console.log('0. File roster == agent_to_capability keys (minus utility passthroughs)');
{
  const PASSTHROUGHS = new Set(['WebSearch', 'WebFetch', 'Monitor']);
  const mappedAgents = Object.keys(A2C).filter(k => !PASSTHROUGHS.has(k)).sort();
  const missingMapping = AGENT_FILES.filter(a => !(a in A2C));
  const orphanMapping  = mappedAgents.filter(a => !AGENT_SET.has(a));
  assert(missingMapping.length === 0,
    `every agent file has an agent_to_capability entry (missing: ${JSON.stringify(missingMapping)})`);
  assert(orphanMapping.length === 0,
    `every non-passthrough mapping key has an agent file (orphans: ${JSON.stringify(orphanMapping)})`);
  assert(JSON.stringify(mappedAgents) === JSON.stringify(AGENT_FILES),
    `roster set equals mapping set (${AGENT_FILES.length} agents)`);
  // Guard: the 3 passthroughs are actually present (so the filter isn't a no-op).
  for (const p of PASSTHROUGHS) {
    assert(p in A2C, `utility passthrough '${p}' present in agent_to_capability`);
  }
}

// ── 1. Every dispatch target is a real agent file or allowlisted built-in ─────
console.log('\n1. Every subagent_type target resolves to a real agent or built-in');
{
  for (const agent of AGENT_FILES) {
    for (const target of graph[agent]) {
      const ok = AGENT_SET.has(target) || BUILTINS.has(target);
      assert(ok, `${agent} → "${target}" is a real agents/${target}.md or allowlisted built-in`);
    }
  }
}

// ── 2. Every (non-builtin) target is a key in agent_to_capability ─────────────
console.log('\n2. Every dispatch target has an agent_to_capability mapping');
{
  for (const agent of AGENT_FILES) {
    for (const target of graph[agent]) {
      if (BUILTINS.has(target)) continue; // built-ins resolve at the harness, not via config
      assert(typeof A2C[target] === 'string' && A2C[target].length > 0,
        `${agent} → "${target}" present in agent_to_capability (got ${JSON.stringify(A2C[target])})`);
    }
  }
}

// ── 3. Every target resolves end-to-end to a live endpoint ────────────────────
console.log(`\n3. Every dispatch target resolves agent → capability → model → endpoint @ ${REF_MODE}/${REF_TIER}`);
{
  // Collect the unique set of non-builtin targets across the whole graph.
  const allTargets = new Set();
  for (const agent of AGENT_FILES) for (const t of graph[agent]) if (!BUILTINS.has(t)) allTargets.add(t);
  for (const target of [...allTargets].sort()) {
    const r = resolveTarget(target);
    assert(!r.error, `"${target}" resolves → ${r.error ? r.error : `${r.cap} → ${r.model} → ${r.endpointId}`}`);
  }
}

// ── Print the resolved directed dispatch graph (log readability) ──────────────
console.log('\nResolved dispatch graph (source → targets):');
for (const agent of AGENT_FILES) {
  const targets = graph[agent];
  if (targets.length === 0) { console.log(`  ${agent} → (leaf)`); continue; }
  const annotated = targets.map(t => {
    if (BUILTINS.has(t)) return `${t} [builtin]`;
    const r = resolveTarget(t);
    return r.error ? `${t} [BROKEN]` : `${t}→${r.model}`;
  });
  console.log(`  ${agent} → ${annotated.join(', ')}`);
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
