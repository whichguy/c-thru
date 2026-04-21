#!/usr/bin/env node
'use strict';
// 5-tier boundary + edge input tests for hw-profile.js tierForGb() and resolveActiveTier().
// Run: node test/hw-profile.test.js

const { tierForGb } = require('../tools/hw-profile.js');
const { resolveActiveTier } = require('../tools/model-map-resolve.js');

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

// ── 1. tierForGb — each tier boundary exactly ────────────────────────────────
// Boundaries (from hw-profile.js): <24→16gb, <40→32gb, <56→48gb, <96→64gb, ≥96→128gb
console.log('1. tierForGb — boundary conditions');
{
  assert(tierForGb(1)   === '16gb', '1 GB → 16gb');
  assert(tierForGb(8)   === '16gb', '8 GB → 16gb');
  assert(tierForGb(23)  === '16gb', '23 GB → 16gb (below 24 boundary)');
  assert(tierForGb(24)  === '32gb', '24 GB → 32gb (at boundary)');
  assert(tierForGb(25)  === '32gb', '25 GB → 32gb');
  assert(tierForGb(39)  === '32gb', '39 GB → 32gb (below 40 boundary)');
  assert(tierForGb(40)  === '48gb', '40 GB → 48gb (at boundary)');
  assert(tierForGb(55)  === '48gb', '55 GB → 48gb (below 56 boundary)');
  assert(tierForGb(56)  === '64gb', '56 GB → 64gb (at boundary)');
  assert(tierForGb(95)  === '64gb', '95 GB → 64gb (below 96 boundary)');
  assert(tierForGb(96)  === '128gb', '96 GB → 128gb (at boundary)');
  assert(tierForGb(128) === '128gb', '128 GB → 128gb');
}

// ── 2. tierForGb — extreme / edge inputs ─────────────────────────────────────
console.log('\n2. tierForGb — extreme values');
{
  assert(tierForGb(0)   === '16gb',  '0 GB → 16gb (below minimum tier)');
  assert(tierForGb(512) === '128gb', '512 GB → 128gb (well above ceiling)');
  assert(typeof tierForGb(1024) === 'string', 'very large → returns a string, no crash');
}

// ── 3. resolveActiveTier — CLAUDE_LLM_MEMORY_GB env override ─────────────────
console.log('\n3. resolveActiveTier — CLAUDE_LLM_MEMORY_GB env override');
{
  const saved = { ...process.env };
  delete process.env.CLAUDE_LLM_PROFILE;

  process.env.CLAUDE_LLM_MEMORY_GB = '8';
  assert(resolveActiveTier({ llm_active_profile: 'auto' }) === '16gb', 'CLAUDE_LLM_MEMORY_GB=8 → 16gb');

  process.env.CLAUDE_LLM_MEMORY_GB = '64';
  assert(resolveActiveTier({}) === '64gb', 'CLAUDE_LLM_MEMORY_GB=64 → 64gb');

  process.env.CLAUDE_LLM_MEMORY_GB = '96';
  assert(resolveActiveTier({}) === '128gb', 'CLAUDE_LLM_MEMORY_GB=96 → 128gb');

  Object.assign(process.env, saved);
}

// ── 4. resolveActiveTier — malformed CLAUDE_LLM_MEMORY_GB falls through ────────
console.log('\n4. resolveActiveTier — malformed CLAUDE_LLM_MEMORY_GB falls through to os.totalmem()');
{
  const saved = { ...process.env };
  delete process.env.CLAUDE_LLM_PROFILE;

  process.env.CLAUDE_LLM_MEMORY_GB = 'not-a-number';
  const result = resolveActiveTier({ llm_active_profile: 'auto' });
  assert(typeof result === 'string' && result.length > 0,
    `malformed env → still returns a tier string (got '${result}')`);
  assert(['16gb', '32gb', '48gb', '64gb', '128gb'].includes(result),
    `tier '${result}' is a known tier value`);

  delete process.env.CLAUDE_LLM_MEMORY_GB;
  Object.assign(process.env, saved);
}

// ── 5. resolveActiveTier — CLAUDE_LLM_PROFILE wins over config ────────────────
console.log('\n5. resolveActiveTier — CLAUDE_LLM_PROFILE wins over config.llm_active_profile');
{
  const saved = { ...process.env };
  process.env.CLAUDE_LLM_PROFILE = '32gb';
  assert(resolveActiveTier({ llm_active_profile: '128gb' }) === '32gb',
    'CLAUDE_LLM_PROFILE=32gb wins over config 128gb');
  Object.assign(process.env, saved);
}

// ── 6. resolveActiveTier — config.llm_active_profile used when env absent ────
console.log('\n6. resolveActiveTier — config.llm_active_profile respected');
{
  const saved = { ...process.env };
  delete process.env.CLAUDE_LLM_PROFILE;
  delete process.env.CLAUDE_LLM_MEMORY_GB;
  assert(resolveActiveTier({ llm_active_profile: '48gb' }) === '48gb',
    'config.llm_active_profile=48gb used when env absent');
  Object.assign(process.env, saved);
}

// ── 7. tierForGb — boundary ±1 precision ─────────────────────────────────────
console.log('\n7. tierForGb — each boundary ±1 to confirm no off-by-one');
{
  const boundaries = [
    [23, '16gb'], [24, '32gb'],
    [39, '32gb'], [40, '48gb'],
    [55, '48gb'], [56, '64gb'],
    [95, '64gb'], [96, '128gb'],
  ];
  for (const [gb, expected] of boundaries) {
    assert(tierForGb(gb) === expected, `tierForGb(${gb}) === '${expected}'`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
