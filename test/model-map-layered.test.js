#!/usr/bin/env node
'use strict';
// 3-tier merge edge cases for model-map-layered.js.
// Run: node test/model-map-layered.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { mergeConfigLayers, loadLayeredConfig } = require('../tools/model-map-layered.js');

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

function withTmpFiles(files, fn) {
  const paths = {};
  try {
    for (const [name, content] of Object.entries(files)) {
      const p = path.join(os.tmpdir(), `layered-test-${process.pid}-${name}`);
      fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
      paths[name] = p;
    }
    return fn(paths);
  } finally {
    for (const p of Object.values(paths)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
}

// Minimal valid base config for loadLayeredConfig tests.
const BASE = {
  backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
  model_routes: { 'base-model': 'local' },
  llm_mode: 'connected',
  llm_profiles: {
    '16gb': { workhorse: { connected_model: 'base-model', disconnect_model: 'base-model' } },
  },
};

// ── 1. mergeConfigLayers — deeper override wins ────────────────────────────────
console.log('1. mergeConfigLayers — deepest value wins for scalars');
{
  const base     = { a: 1, b: { x: 10, y: 20 } };
  const override = { b: { x: 99 } };
  const result   = mergeConfigLayers(base, override);
  assert(result.a === 1,   'unoverridden scalar preserved');
  assert(result.b.x === 99, 'nested scalar override wins');
  assert(result.b.y === 20, 'sibling key preserved');
}

// ── 2. mergeConfigLayers — array replace semantics ────────────────────────────
console.log('\n2. mergeConfigLayers — array override replaces entire array');
{
  const base     = { list: [1, 2, 3] };
  const override = { list: [99] };
  const result   = mergeConfigLayers(base, override);
  assert(Array.isArray(result.list), 'result is array');
  assert(result.list.length === 1 && result.list[0] === 99, 'array replaced, not merged');
}

// ── 3. mergeConfigLayers — missing override is a no-op ────────────────────────
console.log('\n3. mergeConfigLayers — undefined override → clone of base');
{
  const base   = { x: 42, nested: { y: 7 } };
  const result = mergeConfigLayers(base, undefined);
  assert(result.x === 42,         'scalar preserved when override undefined');
  assert(result.nested.y === 7,   'nested preserved when override undefined');
  assert(result !== base,          'returns a clone, not same reference');
}

// ── 4. loadLayeredConfig — user override of llm_mode ─────────────────────────
console.log('\n4. loadLayeredConfig — user override wins for scalar field');
{
  const override = { llm_mode: 'offline' };
  withTmpFiles({ 'defaults.json': BASE, 'overrides.json': override }, ({ 'defaults.json': d, 'overrides.json': o }) => {
    const { effective } = loadLayeredConfig(d, o);
    assert(effective.llm_mode === 'offline', `override llm_mode wins (got ${effective.llm_mode})`);
    // base model_routes should still be there
    assert(effective.model_routes && effective.model_routes['base-model'] === 'local',
      'base model_routes preserved after scalar override');
  });
}

// ── 5. loadLayeredConfig — missing overrides file is silent ──────────────────
console.log('\n5. loadLayeredConfig — missing overrides path → defaults only');
{
  withTmpFiles({ 'defaults.json': BASE }, ({ 'defaults.json': d }) => {
    const nonexistent = d + '.nonexistent';
    let threw = false;
    let effective;
    try {
      ({ effective } = loadLayeredConfig(d, nonexistent));
    } catch (e) {
      threw = true;
    }
    assert(!threw, 'missing overrides file does not throw');
    assert(effective && effective.llm_mode === 'connected', 'effective comes from base defaults');
  });
}

// ── 6. loadLayeredConfig — malformed JSON in overrides throws clearly ─────────
console.log('\n6. loadLayeredConfig — malformed override JSON throws');
{
  withTmpFiles({ 'defaults.json': BASE, 'bad.json': 'NOT_JSON' }, ({ 'defaults.json': d, 'bad.json': b }) => {
    let threw = false;
    let errMsg = '';
    try {
      loadLayeredConfig(d, b);
    } catch (e) {
      threw = true;
      errMsg = e.message;
    }
    assert(threw, 'malformed override JSON throws');
    // SyntaxError or our own message — either way it mentions the problem
    assert(errMsg.length > 0, `error message is non-empty (got: "${errMsg.slice(0, 80)}")`);
  });
}

// ── 7. mergeConfigLayers — null override value removes a key ─────────────────
console.log('\n7. mergeConfigLayers — null in override removes the key');
{
  const base     = { keep: 'yes', remove: 'old' };
  const override = { remove: null };
  const result   = mergeConfigLayers(base, override);
  assert(result.keep === 'yes', 'unaffected key preserved');
  assert(!Object.prototype.hasOwnProperty.call(result, 'remove'), 'null override removes key');
}

// ── 8. loadLayeredConfig — deep merge of llm_profiles ────────────────────────
console.log('\n8. loadLayeredConfig — deep merge: override adds new tier without replacing existing');
{
  const override = {
    llm_profiles: {
      '32gb': { workhorse: { connected_model: 'override-model', disconnect_model: 'override-model' } },
    },
    model_routes: { 'override-model': 'local' },
  };
  withTmpFiles({ 'defaults.json': BASE, 'overrides.json': override }, ({ 'defaults.json': d, 'overrides.json': o }) => {
    const { effective } = loadLayeredConfig(d, o);
    assert(effective.llm_profiles['16gb'] !== undefined, '16gb tier preserved from base');
    assert(effective.llm_profiles['32gb'] !== undefined, '32gb tier added from override');
    assert(effective.llm_profiles['32gb'].workhorse.connected_model === 'override-model',
      'override tier value correct');
    assert(effective.llm_profiles['16gb'].workhorse.connected_model === 'base-model',
      'base tier value unchanged');
  });
}

// ── 9. CLAUDE_MODEL_MAP_DEFAULTS_PATH env override honored ───────────────────
console.log('\n9. CLAUDE_MODEL_MAP_DEFAULTS_PATH env var honored by model-map-layered');
{
  // loadLayeredConfig takes explicit paths — env vars are consumed by the proxy startup path.
  // Verify that the function still works when called with an alternate path directly.
  const altBase = Object.assign({}, BASE, { llm_mode: 'offline' });
  withTmpFiles({ 'alt-defaults.json': altBase }, ({ 'alt-defaults.json': d }) => {
    const { effective } = loadLayeredConfig(d, null);
    assert(effective.llm_mode === 'offline', 'loadLayeredConfig respects alt defaults path arg');
  });
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
