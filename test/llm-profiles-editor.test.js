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

// Base config with required shape that passes validateConfig (new schema: capability-outer)
const BASE_CONFIG = {
  llm_profiles: {
    workhorse: { 'best-cloud': { '64gb': 'model-a' } },
    coder:     { 'best-cloud': { '64gb': 'model-a' } },
  },
};

console.log('llm-profiles-editor tests\n');

// ── Test 1: valid capability-entry write produces expected override diff ──
console.log('1. Valid capability-entry write');
{
  const spec = {
    llm_profiles: {
      'deep-coder': { 'best-cloud': { '64gb': 'qwen3.5:27b' }, on_failure: 'cascade' },
    },
  };
  const result = applyUpdates(BASE_CONFIG, spec);
  assert(result.llm_profiles['deep-coder']['best-cloud']['64gb'] === 'qwen3.5:27b', 'best-cloud/64gb written');
  assert(result.llm_profiles['deep-coder'].on_failure === 'cascade', 'on_failure written');
  // Existing entries untouched
  assert(result.llm_profiles.workhorse['best-cloud']['64gb'] === 'model-a', 'existing entry untouched');
}

// ── Test 2: {cap: null} deletes the capability entry ─────────────────────
console.log('\n2. Null capability entry deletes it');
{
  const withExtra = JSON.parse(JSON.stringify(BASE_CONFIG));
  withExtra.llm_profiles['deep-coder'] = { 'best-cloud': { '64gb': 'x' } };
  const spec = { llm_profiles: { 'deep-coder': null } };
  const result = applyUpdates(withExtra, spec);
  assert(!Object.prototype.hasOwnProperty.call(result.llm_profiles, 'deep-coder'), 'capability entry deleted');
  assert(result.llm_profiles.workhorse['best-cloud']['64gb'] === 'model-a', 'other entries preserved');
}

// ── Test 3: old schema (connected_model) is rejected ─────────────────────
console.log('\n3. Old schema (connected_model) is rejected');
{
  const { execFileSync } = require('child_process');
  const specJson = JSON.stringify({
    llm_profiles: { workhorse: { connected_model: 'x', disconnect_model: 'x' } },
  });
  const tmpDefaults  = path.join(os.tmpdir(), `test-defaults-${process.pid}.json`);
  const tmpOverrides = path.join(os.tmpdir(), `test-overrides-${process.pid}.json`);
  const tmpEffective = path.join(os.tmpdir(), `test-effective-${process.pid}.json`);
  try {
    fs.writeFileSync(tmpDefaults, JSON.stringify(BASE_CONFIG));
    fs.writeFileSync(tmpOverrides, '{}');
    let threw = false;
    let stderrMsg = '';
    try {
      execFileSync(process.execPath, [
        path.join(__dirname, '..', 'tools', 'model-map-edit.js'),
        tmpDefaults, tmpOverrides, tmpEffective, specJson,
      ], { stdio: 'pipe' });
    } catch (e) {
      threw = e.status !== 0;
      stderrMsg = (e.stderr || Buffer.alloc(0)).toString();
    }
    assert(threw, 'old schema (connected_model) exits non-zero');
    assert(stderrMsg.includes('old schema') || stderrMsg.includes('migrate'), 'error mentions migration');
  } finally {
    for (const f of [tmpDefaults, tmpOverrides, tmpEffective]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

// ── Test 4: invalid mode key is rejected ──────────────────────────────────
console.log('\n4. Invalid mode key is rejected');
{
  const { execFileSync } = require('child_process');
  const specJson = JSON.stringify({
    llm_profiles: { workhorse: { 'invalid-mode': { '64gb': 'x' } } },
  });
  const tmpDefaults  = path.join(os.tmpdir(), `test-defaults2-${process.pid}.json`);
  const tmpOverrides = path.join(os.tmpdir(), `test-overrides2-${process.pid}.json`);
  const tmpEffective = path.join(os.tmpdir(), `test-effective2-${process.pid}.json`);
  try {
    fs.writeFileSync(tmpDefaults, JSON.stringify(BASE_CONFIG));
    fs.writeFileSync(tmpOverrides, '{}');
    let threw = false;
    let stderrMsg = '';
    try {
      execFileSync(process.execPath, [
        path.join(__dirname, '..', 'tools', 'model-map-edit.js'),
        tmpDefaults, tmpOverrides, tmpEffective, specJson,
      ], { stdio: 'pipe' });
    } catch (e) {
      threw = e.status !== 0;
      stderrMsg = (e.stderr || Buffer.alloc(0)).toString();
    }
    assert(threw, 'invalid mode key exits non-zero');
    assert(stderrMsg.includes('not a valid mode key'), 'error mentions invalid mode key');
  } finally {
    for (const f of [tmpDefaults, tmpOverrides, tmpEffective]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

// ── Test 5: post-write validateConfig passes for valid write ──────────────
console.log('\n5. Post-write validateConfig passes');
{
  const { validateConfig } = require('../tools/model-map-validate.js');
  const spec = {
    llm_profiles: {
      judge: {
        'best-cloud': 'claude-opus-4-6',
        'best-local-oss': { '64gb': 'qwen3.5:27b' },
        on_failure: 'cascade',
      },
    },
  };
  const result = applyUpdates(BASE_CONFIG, spec);
  const errors = [];
  validateConfig(result, errors);
  assert(errors.length === 0, `validateConfig passes after valid llm_profiles write (got: ${errors.join(', ')})`);
}

// ── Test 6: invalid hardware tier in tier-keyed object rejected ───────────
console.log('\n6. Invalid hardware tier is rejected');
{
  const { execFileSync } = require('child_process');
  const specJson = JSON.stringify({
    llm_profiles: { 'deep-coder': { 'best-cloud': { 'invalid-tier': 'x' } } },
  });
  const tmpDefaults  = path.join(os.tmpdir(), `test-defaults3-${process.pid}.json`);
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
    assert(threw, 'invalid hardware tier exits non-zero');
  } finally {
    for (const f of [tmpDefaults, tmpOverrides, tmpEffective]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

// ── Test 7: write to additional capability creates it ──────────────────────
console.log('\n7. Write to additional capability creates it');
{
  const spec = {
    llm_profiles: {
      'fast-scout': {
        'best-cloud': { '16gb': 'gemini-flash', '64gb': 'gemini-pro' },
        'best-local-oss': { '16gb': 'phi4-mini', '64gb': 'qwen3:7b' },
      },
    },
  };
  const result = applyUpdates(BASE_CONFIG, spec);
  assert(isObject(result.llm_profiles['fast-scout']), 'new capability created');
  assert(result.llm_profiles['fast-scout']['best-cloud']['64gb'] === 'gemini-pro', 'new capability entry correct');
  assert(result.llm_profiles.workhorse['best-cloud']['64gb'] === 'model-a', 'existing capability untouched');
}

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
