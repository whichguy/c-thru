#!/usr/bin/env node
'use strict';
// Static contract tests for apply_background_model_overrides() in tools/c-thru.
//
// Why this file exists (two distinct regressions, both shipped undetected):
//
//   1. Dangling capability. The Opus slot exported ANTHROPIC_DEFAULT_OPUS_MODEL=
//      "large-general", a name present in NEITHER llm_profiles, agent_to_capability,
//      NOR model_routes. resolveBackend falls through such a name to bare-Ollama
//      passthrough, so the slot tried to run a nonexistent Ollama tag. Nothing
//      caught it because no test referenced the function at all.
//
//   2. Missing mode. best-cloud-oss was absent from the mode gate, so the
//      background slots kept vendor claude-* ids in the shipped daily-driver mode.
//      Those resolve via model_routes straight to the anthropic endpoint.
//
// These are STATIC assertions against the shipped config — they need no proxy, no
// Ollama, and no network, so they run in the hermetic suite. The launch-time
// behavior (which env vars actually reach the child) is covered by test 29 in
// test/cli-e2e-flags.test.js; the two are complementary, not redundant.
//
// Run: node test/background-model-overrides.test.js

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const CTHRU = path.join(REPO, 'tools', 'c-thru');
const CONFIG = path.join(REPO, 'config', 'model-map.json');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else            { console.error(`  FAIL  ${message}`); failed++; }
}

const source = fs.readFileSync(CTHRU, 'utf8');
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

// Slice out just the function body so we never pick up an `export ANTHROPIC_*`
// from elsewhere in the launcher.
function extractFunctionBody(text, name) {
  const start = text.indexOf(`${name}() {`);
  if (start === -1) return null;
  // The function is closed by a `}` in column 0 — the launcher's consistent style.
  const end = text.indexOf('\n}\n', start);
  if (end === -1) return null;
  return text.slice(start, end);
}

const body = extractFunctionBody(source, 'apply_background_model_overrides');

console.log('\n1. function is present and parseable');
assert(body !== null, 'apply_background_model_overrides() found in tools/c-thru');

if (body === null) {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

// ── 2. Every capability name the function exports must exist in llm_profiles ──
console.log('\n2. every exported background-slot target is a real capability');
{
  const profiles = config.llm_profiles || {};
  const slotRe = /export\s+(ANTHROPIC_(?:SMALL_FAST|DEFAULT_HAIKU|DEFAULT_SONNET|DEFAULT_OPUS)_MODEL)="([^"]+)"/g;
  const found = [];
  let m;
  while ((m = slotRe.exec(body)) !== null) found.push([m[1], m[2]]);

  assert(found.length >= 4,
    `all four background slots are assigned (found ${found.length}: ${found.map(f => f[0]).join(', ')})`);

  for (const [slot, capability] of found) {
    assert(Object.prototype.hasOwnProperty.call(profiles, capability),
      `${slot}="${capability}" exists in llm_profiles`);
  }

  // A capability that exists must also resolve to a concrete model in every mode
  // the gate covers — an empty cell grid would fail at request time, not launch.
  for (const [slot, capability] of found) {
    const entry = profiles[capability];
    const cells = entry && typeof entry === 'object'
      ? Object.keys(entry).filter(k => k !== 'on_failure')
      : [];
    assert(cells.length > 0, `${slot} capability "${capability}" has mode cells (got ${cells.length})`);
  }
}

// ── 3. The mode gate covers every non-Anthropic mode in the shipped config ─────
// The gate matches the mode name LITERALLY (resolve_llm_mode does not expand a
// custom mode's `base`), so this asserts against the literal case list.
console.log('\n3. mode gate covers the shipped non-Anthropic modes');
{
  const caseMatch = body.match(/case\s+"\$llm_mode"\s+in\s+([\s\S]*?)\)\s*\n/);
  const gate = caseMatch ? caseMatch[1].replace(/\\\s*\n\s*/g, '') : '';
  assert(gate.length > 0, 'mode gate case list is parseable');

  // Modes whose generalist capability resolves away from Anthropic in the shipped
  // map. best-cloud is deliberately EXCLUDED — it is meant to serve Claude.
  const mustCover = [
    'best-cloud-oss',
    'best-cloud-gov',
    'best-local-oss',
    'best-local-gov',
    'offline',
  ];
  for (const mode of mustCover) {
    assert(gate.split('|').map(s => s.trim()).includes(mode),
      `gate covers "${mode}"`);
  }

  assert(!gate.split('|').map(s => s.trim()).includes('best-cloud'),
    'gate does NOT cover "best-cloud" (that mode intentionally serves Claude)');
}

// ── 4. Cross-check: the covered modes really do route generalist off Anthropic ──
// Guards the inverse mistake — adding a mode to the gate that actually wants Claude.
console.log('\n4. covered modes route generalist to a non-Anthropic endpoint');
{
  const generalist = (config.llm_profiles || {}).generalist || {};
  const modelRoutes = config.model_routes || {};
  for (const mode of ['best-cloud-oss', 'best-cloud-gov']) {
    const cells = generalist[mode] || {};
    const targets = Object.values(cells).filter(v => typeof v === 'string');
    assert(targets.length > 0, `${mode} has generalist cells (got ${targets.length})`);
    const anthropicBacked = targets.filter(t => modelRoutes[t] === 'anthropic');
    assert(anthropicBacked.length === 0,
      `${mode} generalist never routes to anthropic (offenders: ${JSON.stringify(anthropicBacked)})`);
  }
}

// ── 5. Context-window enforcement for unrecognized models ──────────────────
// Claude Code assumes 200k for any non-Anthropic model id. apply_background_
// model_overrides must declare the real window (CLAUDE_CODE_MAX_CONTEXT_TOKENS)
// when the launch model is in the model-map's context_windows, and fall back to
// CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 for unknown models.
console.log('\n5. context-window enforcement logic is present');
{
  assert(body.includes('context_windows'),
    'function reads the model-map context_windows map');
  assert(body.includes('CLAUDE_CODE_MAX_CONTEXT_TOKENS'),
    'function exports CLAUDE_CODE_MAX_CONTEXT_TOKENS for known windows');
  assert(body.includes('CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT'),
    'function exports CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT as fallback');
  assert(body.includes('is_claude_native_model_name'),
    'function skips Claude-native models (Claude Code knows their windows)');
}

// ── 6. Shipped context_windows covers the daily-driver fleet ───────────────
// Every concrete model the background slots resolve to in best-cloud-oss must
// have a declared window, so the daily-driver fleet gets real windows instead
// of the disable-enforcement fallback.
console.log('\n6. shipped context_windows covers the background-slot fleet');
{
  const cw = config.context_windows || {};
  assert(typeof cw === 'object' && !Array.isArray(cw),
    'config has a context_windows object');

  for (const [model, tokens] of Object.entries(cw)) {
    assert(Number.isInteger(tokens) && tokens > 0,
      `context_windows.${model} is a positive integer (got ${JSON.stringify(tokens)})`);
  }

  const slotCapabilities = ['fast-generalist', 'generalist', 'planner-hard'];
  const concrete = new Set();
  for (const cap of slotCapabilities) {
    const cells = ((config.llm_profiles || {})[cap] || {})['best-cloud-oss'] || {};
    for (const v of Object.values(cells)) {
      if (typeof v === 'string') concrete.add(v);
    }
  }
  for (const model of concrete) {
    assert(Object.prototype.hasOwnProperty.call(cw, model),
      `context_windows covers "${model}" (resolved by a background slot in best-cloud-oss)`);
  }
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
