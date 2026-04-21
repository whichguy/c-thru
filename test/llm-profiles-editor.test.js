#!/usr/bin/env node
'use strict';
// Unit tests for the llm_profiles handler in model-map-edit.js applyUpdates().
// Run with: node test/llm-profiles-editor.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyUpdates } = require('../tools/model-map-edit.js');

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

function assertThrows(fn, pattern, message) {
  try {
    fn();
    console.error(`  FAIL  ${message} — expected throw, got none`);
    failed++;
  } catch (e) {
    if (pattern && !e.message.includes(pattern)) {
      console.error(`  FAIL  ${message} — threw but message '${e.message}' does not match '${pattern}'`);
      failed++;
    } else {
      console.log(`  PASS  ${message}`);
      passed++;
    }
  }
}

// Base config with required shape that passes validateConfig
const BASE_CONFIG = {
  llm_profiles: {
    '64gb': {
      default:     { connected_model: 'model-a', disconnect_model: 'model-a' },
      classifier:  { connected_model: 'model-a', disconnect_model: 'model-a' },
      explorer:    { connected_model: 'model-a', disconnect_model: 'model-a' },
      reviewer:    { connected_model: 'model-a', disconnect_model: 'model-a' },
      workhorse:   { connected_model: 'model-a', disconnect_model: 'model-a' },
      coder:       { connected_model: 'model-a', disconnect_model: 'model-a' },
    },
  },
};

console.log('llm-profiles-editor tests\n');

// ── Test 1: valid capability-entry write produces expected override diff ──
console.log('1. Valid capability-entry write');
{
  const spec = {
    llm_profiles: {
      '64gb': {
        'deep-coder': { connected_model: 'qwen3.5:27b', disconnect_model: 'qwen3.5:27b', on_failure: 'cascade' },
      },
    },
  };
  const result = applyUpdates(BASE_CONFIG, spec);
  assert(result.llm_profiles['64gb']['deep-coder'].connected_model === 'qwen3.5:27b', 'connected_model written');
  assert(result.llm_profiles['64gb']['deep-coder'].disconnect_model === 'qwen3.5:27b', 'disconnect_model written');
  assert(result.llm_profiles['64gb']['deep-coder'].on_failure === 'cascade', 'on_failure written');
  // Existing entries untouched
  assert(result.llm_profiles['64gb'].default.connected_model === 'model-a', 'existing entry untouched');
}

// ── Test 2: {tier: {cap: null}} deletes the entry ─────────────────────
console.log('\n2. Null capability entry deletes it');
{
  const withExtra = JSON.parse(JSON.stringify(BASE_CONFIG));
  withExtra.llm_profiles['64gb']['deep-coder'] = { connected_model: 'x', disconnect_model: 'x' };
  const spec = { llm_profiles: { '64gb': { 'deep-coder': null } } };
  const result = applyUpdates(withExtra, spec);
  assert(!Object.prototype.hasOwnProperty.call(result.llm_profiles['64gb'], 'deep-coder'), 'capability entry deleted');
  assert(result.llm_profiles['64gb'].default.connected_model === 'model-a', 'other entries preserved');
}

// ── Test 3: {tier: null} rejects with clear error ─────────────────────
console.log('\n3. Null tier is rejected');
{
  // applyUpdates calls fail() which does process.exit(1) — we need to intercept
  // by catching the exit via a spawned process. Instead, test the helper directly.
  const { } = require('../tools/model-map-edit.js'); // already imported above
  // We can't easily catch process.exit, so test via child_process
  const { execFileSync } = require('child_process');
  const specJson = JSON.stringify({ llm_profiles: { '64gb': null } });
  const tmpDefaults = path.join(os.tmpdir(), `test-defaults-${process.pid}.json`);
  const tmpOverrides = path.join(os.tmpdir(), `test-overrides-${process.pid}.json`);
  const tmpEffective = path.join(os.tmpdir(), `test-effective-${process.pid}.json`);
  try {
    fs.writeFileSync(tmpDefaults, JSON.stringify(BASE_CONFIG));
    fs.writeFileSync(tmpOverrides, '{}');
    let threw = false;
    try {
      execFileSync(process.execPath, [
        path.join(__dirname, '..', 'tools', 'model-map-edit.js'),
        tmpDefaults, tmpOverrides, tmpEffective, specJson,
      ], { stdio: 'pipe' });
    } catch (e) {
      threw = e.status !== 0;
    }
    assert(threw, '{tier: null} exits non-zero');
  } finally {
    for (const f of [tmpDefaults, tmpOverrides, tmpEffective]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

// ── Test 4: sub-field null is rejected before validateConfig ──────────
console.log('\n4. Sub-field null is rejected');
{
  const { execFileSync } = require('child_process');
  const specJson = JSON.stringify({
    llm_profiles: { '64gb': { 'deep-coder': { connected_model: null, disconnect_model: 'x' } } },
  });
  const tmpDefaults = path.join(os.tmpdir(), `test-defaults2-${process.pid}.json`);
  const tmpOverrides = path.join(os.tmpdir(), `test-overrides2-${process.pid}.json`);
  const tmpEffective = path.join(os.tmpdir(), `test-effective2-${process.pid}.json`);
  try {
    fs.writeFileSync(tmpDefaults, JSON.stringify(BASE_CONFIG));
    fs.writeFileSync(tmpOverrides, '{}');
    let stderrMsg = '';
    let threw = false;
    try {
      execFileSync(process.execPath, [
        path.join(__dirname, '..', 'tools', 'model-map-edit.js'),
        tmpDefaults, tmpOverrides, tmpEffective, specJson,
      ], { stdio: 'pipe' });
    } catch (e) {
      threw = e.status !== 0;
      stderrMsg = (e.stderr || Buffer.alloc(0)).toString();
    }
    assert(threw, 'sub-field null exits non-zero');
    assert(stderrMsg.includes('null is not supported'), 'error mentions null not supported');
  } finally {
    for (const f of [tmpDefaults, tmpOverrides, tmpEffective]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

// ── Test 5: post-write validateConfig passes for valid write ──────────
console.log('\n5. Post-write validateConfig passes');
{
  const { validateConfig } = require('../tools/model-map-validate.js');
  const spec = {
    llm_profiles: {
      '64gb': {
        judge: {
          connected_model: 'claude-opus-4-6',
          disconnect_model: 'qwen3.5:27b',
          on_failure: 'cascade',
          modes: { 'semi-offload': 'claude-opus-4-6', 'cloud-judge-only': 'claude-opus-4-6' },
        },
      },
    },
  };
  const result = applyUpdates(BASE_CONFIG, spec);
  const errors = [];
  validateConfig(result, errors);
  assert(errors.length === 0, 'validateConfig passes after valid llm_profiles write');
}

// ── Test 6: missing connected_model rejected ──────────────────────────
console.log('\n6. Missing connected_model rejected');
{
  const { execFileSync } = require('child_process');
  const specJson = JSON.stringify({
    llm_profiles: { '64gb': { 'deep-coder': { disconnect_model: 'x' } } },
  });
  const tmpDefaults = path.join(os.tmpdir(), `test-defaults3-${process.pid}.json`);
  const tmpOverrides = path.join(os.tmpdir(), `test-overrides3-${process.pid}.json`);
  const tmpEffective = path.join(os.tmpdir(), `test-effective3-${process.pid}.json`);
  try {
    fs.writeFileSync(tmpDefaults, JSON.stringify(BASE_CONFIG));
    fs.writeFileSync(tmpOverrides, '{}');
    let threw = false;
    try {
      execFileSync(process.execPath, [
        path.join(__dirname, '..', 'tools', 'model-map-edit.js'),
        tmpDefaults, tmpOverrides, tmpEffective, specJson,
      ], { stdio: 'pipe' });
    } catch (e) {
      threw = e.status !== 0;
    }
    assert(threw, 'missing connected_model exits non-zero');
  } finally {
    for (const f of [tmpDefaults, tmpOverrides, tmpEffective]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

// ── Test 7: write to new tier creates it ─────────────────────────────
console.log('\n7. Write to new tier creates it');
{
  const spec = {
    llm_profiles: {
      '128gb': {
        default:    { connected_model: 'big-model', disconnect_model: 'small-model' },
        classifier: { connected_model: 'cls', disconnect_model: 'cls' },
        explorer:   { connected_model: 'exp', disconnect_model: 'exp' },
        reviewer:   { connected_model: 'rev', disconnect_model: 'rev' },
        workhorse:  { connected_model: 'wrk', disconnect_model: 'wrk' },
        coder:      { connected_model: 'cod', disconnect_model: 'cod' },
      },
    },
  };
  const result = applyUpdates(BASE_CONFIG, spec);
  assert(isObject(result.llm_profiles['128gb']), 'new tier created');
  assert(result.llm_profiles['128gb'].default.connected_model === 'big-model', 'new tier entry correct');
  assert(result.llm_profiles['64gb'].default.connected_model === 'model-a', 'existing tier untouched');
}

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
