#!/usr/bin/env node
'use strict';
// Hermetic tests for advisor_panels resolution + gov seat policy.
// Run: node test/advisor-panels-resolve.test.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, assertEq, summary } = require('./helpers');
const {
  resolveAdvisorPanel,
  isChineseOrigin,
} = require('../tools/model-map-resolve.js');

const REPO = path.join(__dirname, '..');
const MAP = path.join(REPO, 'config', 'model-map.json');
const EXPLAIN = path.join(REPO, 'tools', 'c-thru-explain.js');
const MODES = [
  'best-cloud',
  'best-cloud-oss',
  'best-local-oss',
  'best-cloud-gov',
  'best-local-gov',
];
const CHINESE_BRAND_SEATS = new Set(['deepseek', 'qwen', 'kimi', 'glm']);

const config = JSON.parse(fs.readFileSync(MAP, 'utf8'));

console.log('advisor-panels-resolve tests\n');

console.log('1. advisor_panels.default covers all five modes');
{
  const def = config.advisor_panels && config.advisor_panels.default;
  assert(def && typeof def === 'object', 'advisor_panels.default present');
  for (const m of MODES) {
    assert(def[m] && Array.isArray(def[m].seats), `default.${m}.seats present`);
    assert(def[m].seats.length >= 2 && def[m].seats.length <= 5,
      `default.${m}.seats length 2–5 (got ${def[m].seats.length})`);
  }
}

console.log('\n2. resolveAdvisorPanel returns concrete models for each mode @ 64gb');
{
  for (const mode of MODES) {
    const r = resolveAdvisorPanel(config, { role: 'default', mode, tier: '64gb' });
    assert(r, `resolve ${mode}`);
    assertEq(r.errors.length, 0, `${mode}: no resolve errors (${r.errors.join('; ')})`);
    assert(r.seats.length >= 2, `${mode}: ≥2 seats`);
    for (const s of r.seats) {
      assert(s.model && String(s.model).trim(),
        `${mode}: seat ${s.name} has model (got ${s.model})`);
    }
  }
}

console.log('\n3. unknown role falls back to default (same mode)');
{
  const r = resolveAdvisorPanel(config, {
    role: 'plan',
    mode: 'best-cloud-oss',
    tier: '64gb',
  });
  assert(r, 'fallback resolve');
  assertEq(r.role, 'default', 'resolved role is default');
  assertEq(r.requestedRole, 'plan', 'requestedRole preserved');
  assert(r.seats.length >= 2, 'fallback has seats');
  assert(r.seats.every((s) => s.model), 'fallback seats have models');
}

console.log('\n3b. role with only OSS seats never serves them under gov mode');
{
  const cfg = JSON.parse(JSON.stringify(config));
  cfg.advisor_panels.review = {
    'best-cloud-oss': {
      seats: ['deepseek', 'kimi', 'qwen'],
      description: 'OSS-only review panel (fixture)',
    },
  };
  const r = resolveAdvisorPanel(cfg, {
    role: 'review',
    mode: 'best-cloud-gov',
    tier: '64gb',
  });
  assert(r, 'resolve review@gov');
  // Must fall back to default[best-cloud-gov], not review's OSS seats
  assertEq(r.role, 'default', 'falls back to default role for gov mode');
  assertEq(r.mode, 'best-cloud-gov', 'mode stays gov');
  assert(r.errors.length === 0, `no errors (${r.errors.join('; ')})`);
  for (const s of r.seats) {
    assert(!CHINESE_BRAND_SEATS.has(s.name),
      `gov path must not seat Chinese brand (got ${s.name})`);
  }
}

console.log('\n4. gov modes never seat Chinese-origin brand agents');
{
  for (const mode of ['best-cloud-gov', 'best-local-gov']) {
    const r = resolveAdvisorPanel(config, { role: 'default', mode, tier: '64gb' });
    assert(r, `gov resolve ${mode}`);
    for (const s of r.seats) {
      assert(!CHINESE_BRAND_SEATS.has(s.name),
        `${mode}: seat name must not be Chinese brand agent (got ${s.name})`);
      if (s.model) {
        assert(!isChineseOrigin(s.model),
          `${mode}: seat ${s.name} model must not be Chinese-origin (got ${s.model})`);
      }
    }
  }
}

console.log('\n5. explain --panel json smoke (shipped map)');
{
  const r = spawnSync(process.execPath, [
    EXPLAIN,
    '--panel', 'default',
    '--mode', 'best-cloud-oss',
    '--tier', '64gb',
    '--format', 'json',
  ], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_MODEL_MAP_PATH: MAP, NO_COLOR: '1' },
  });
  assert(r.status === 0, `explain exit 0 (got ${r.status}, stderr: ${(r.stderr || '').slice(0, 200)})`);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch (e) {
    assert(false, `explain json parse: ${e.message}`);
  }
  assert(parsed && Array.isArray(parsed.seats) && parsed.seats.length >= 2,
    'explain json has seats');
  assert(parsed.seats.every((s) => s.model), 'every seat has model');
}

console.log('\n6. explain --panel unknown-without-default-config exits non-zero only if no panels');
{
  // With shipped config, unknown role falls back — exit 0
  const r = spawnSync(process.execPath, [
    EXPLAIN, '--panel', 'nonexistent-role', '--mode', 'best-cloud', '--tier', '64gb',
  ], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_MODEL_MAP_PATH: MAP, NO_COLOR: '1' },
  });
  assert(r.status === 0, `fallback role still exits 0 (got ${r.status})`);
}

const failed = summary();
process.exit(failed ? 1 : 0);
