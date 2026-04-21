#!/usr/bin/env node
'use strict';
// Schema validator golden corpus — tests validateConfig() directly via its
// exported errors-array API, plus one CLI process-spawn to confirm exit code.
// Run: node test/model-map-validate.test.js

const { spawnSync } = require('child_process');
const path = require('path');
const { validateConfig, validateRecommendedMappings } = require('../tools/model-map-validate.js');

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

function validate(config) {
  const errors = [];
  validateConfig(config, errors);
  return errors;
}

// Minimal valid config used as a base throughout.
const VALID_BASE = {
  backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
  model_routes: { 'test-model': 'local' },
  llm_profiles: {
    '16gb': {
      workhorse: { connected_model: 'test-model', disconnect_model: 'test-model' },
      judge:     { connected_model: 'test-model', disconnect_model: 'test-model' },
    },
  },
  llm_mode: 'connected',
};

// ── 1. Valid config passes ─────────────────────────────────────────────────
console.log('1. Valid minimal config');
{
  const errs = validate(VALID_BASE);
  assert(errs.length === 0, 'valid config → no errors');
}

// ── 2. Invalid llm_mode value ──────────────────────────────────────────────
console.log('\n2. Invalid llm_mode value');
{
  const cfg = Object.assign({}, VALID_BASE, { llm_mode: 'disconnect' });
  const errs = validate(cfg);
  assert(errs.length > 0, 'bad llm_mode → error');
  assert(errs.some(e => e.includes('llm_mode')), `error mentions llm_mode (got: ${errs[0]})`);
}

// ── 3. Route cycle detected ────────────────────────────────────────────────
console.log('\n3. Route cycle');
{
  const cfg = Object.assign({}, VALID_BASE, { routes: { a: 'b', b: 'a' } });
  const errs = validate(cfg);
  assert(errs.length > 0, 'route cycle → error');
  assert(errs.some(e => e.includes('cycle')), `error mentions cycle (got: ${errs[0]})`);
}

// ── 4. model_overrides maps key to itself ──────────────────────────────────
console.log('\n4. model_overrides self-map');
{
  const cfg = Object.assign({}, VALID_BASE, { model_overrides: { 'test-model': 'test-model' } });
  const errs = validate(cfg);
  assert(errs.length > 0, 'self-referencing override → error');
  assert(errs.some(e => e.includes('model_overrides')), `error mentions model_overrides (got: ${errs[0]})`);
}

// ── 5. agent_to_capability references unknown alias ────────────────────────
console.log('\n5. agent_to_capability unknown alias');
{
  const cfg = Object.assign({}, VALID_BASE, { agent_to_capability: { 'my-agent': 'nonexistent-alias' } });
  const errs = validate(cfg);
  assert(errs.length > 0, 'unknown capability alias → error');
  assert(errs.some(e => e.includes('agent_to_capability')), `error mentions agent_to_capability (got: ${errs[0]})`);
}

// ── 6. llm_profiles entry missing connected_model ─────────────────────────
console.log('\n6. llm_profiles entry missing connected_model');
{
  const cfg = {
    backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
    model_routes: { 'test-model': 'local' },
    llm_profiles: {
      '16gb': { workhorse: { disconnect_model: 'test-model' } }, // connected_model absent
    },
  };
  const errs = validate(cfg);
  assert(errs.length > 0, 'missing connected_model → error');
  assert(errs.some(e => e.includes('connected_model')), `error mentions connected_model (got: ${errs[0]})`);
}

// ── 7. model_routes @sigil references undeclared backend ──────────────────
console.log('\n7. model_routes @backend sigil → undeclared backend');
{
  const cfg = {
    backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
    model_routes: { 'mymodel@ghost': 'local' }, // @ghost not in backends
  };
  const errs = validate(cfg);
  assert(errs.length > 0, '@undeclared backend → error');
  assert(errs.some(e => e.includes('ghost')), `error mentions the missing backend id (got: ${errs[0]})`);
}

// ── 8. llm_connectivity_mode legacy key → deprecation warning on stderr ───
console.log('\n8. llm_connectivity_mode deprecated key → stderr warning');
{
  // When llm_mode is absent + llm_connectivity_mode present → warning, no error
  const cfg = Object.assign({}, VALID_BASE, { llm_connectivity_mode: 'connected' });
  delete cfg.llm_mode;
  let stderrLine = '';
  const origWarn = console.warn;
  console.warn = msg => { stderrLine = msg; };
  const errs = validate(cfg);
  console.warn = origWarn;
  assert(errs.length === 0, 'deprecated key alone → no error');
  assert(stderrLine.includes('deprecated'), `warning text includes "deprecated" (got: "${stderrLine}")`);
}

// ── 9. fallback_strategies cycle → error ──────────────────────────────────
console.log('\n9. fallback_strategies cycle');
{
  const cfg = {
    backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
    model_routes: { 'model-a': 'local', 'model-b': 'local' },
    fallback_strategies: {
      'model-a': { event: { network_failure: ['model-b'] } },
      'model-b': { event: { network_failure: ['model-a'] } },
    },
  };
  const errs = validate(cfg);
  assert(errs.length > 0, 'fallback cycle → error');
  assert(errs.some(e => e.includes('cycle')), `error mentions cycle (got: ${errs[0]})`);
}

// ── 10. model_overrides value must be non-empty string ────────────────────
console.log('\n10. model_overrides empty string value');
{
  const cfg = Object.assign({}, VALID_BASE, { model_overrides: { 'test-model': '' } });
  const errs = validate(cfg);
  assert(errs.length > 0, 'empty override target → error');
}

// ── 11. agent_to_capability valid known alias ──────────────────────────────
console.log('\n11. agent_to_capability valid alias passes');
{
  const cfg = Object.assign({}, VALID_BASE, {
    agent_to_capability: { 'my-agent': 'workhorse', 'other-agent': 'judge' },
  });
  const errs = validate(cfg);
  assert(errs.length === 0, 'valid agent_to_capability → no errors');
}

// ── 12. llm_profiles modes[] bad mode key ─────────────────────────────────
console.log('\n12. llm_profiles modes[] invalid mode key');
{
  const cfg = {
    backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
    model_routes: { 'test-model': 'local' },
    llm_profiles: {
      '16gb': {
        judge: {
          connected_model: 'test-model',
          disconnect_model: 'test-model',
          modes: { 'disconnected': 'test-model' }, // invalid mode key
        },
      },
    },
  };
  const errs = validate(cfg);
  assert(errs.length > 0, 'bad modes[] key → error');
  assert(errs.some(e => e.includes('modes')), `error mentions modes (got: ${errs[0]})`);
}

// ── 13. CLI process spawn: invalid file exits 1 ───────────────────────────
console.log('\n13. CLI exit code on invalid config');
{
  const VALIDATOR = path.resolve(__dirname, '..', 'tools', 'model-map-validate.js');
  const bad = JSON.stringify({ llm_mode: 'disconnect' });
  const tmp = require('os').tmpdir() + '/validate-test-bad.json';
  require('fs').writeFileSync(tmp, bad);
  const result = spawnSync(process.execPath, [VALIDATOR, tmp], { encoding: 'utf8' });
  require('fs').unlinkSync(tmp);
  assert(result.status === 1, `CLI exits 1 for invalid config (got ${result.status})`);
  assert(result.stderr.includes('llm_mode'), `stderr mentions llm_mode (got: ${result.stderr.slice(0, 120)})`);
}

// ── 14. validateRecommendedMappings — valid passes ─────────────────────────
console.log('\n14. validateRecommendedMappings valid');
{
  const rec = {
    schema_version: 1,
    updated_at: '2026-01-01',
    recommendations: { workhorse: { '64gb': 'some-model' } },
  };
  const errs = [];
  validateRecommendedMappings(rec, errs);
  assert(errs.length === 0, 'valid recommended-mappings → no errors');
}

// ── 15. validateRecommendedMappings — unknown capability ──────────────────
console.log('\n15. validateRecommendedMappings unknown capability');
{
  const rec = {
    schema_version: 1,
    updated_at: '2026-01-01',
    recommendations: { 'not-a-real-cap': { '64gb': 'some-model' } },
  };
  const errs = [];
  validateRecommendedMappings(rec, errs);
  assert(errs.length > 0, 'unknown capability → error');
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
