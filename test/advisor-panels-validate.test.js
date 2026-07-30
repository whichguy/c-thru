#!/usr/bin/env node
'use strict';
// Hermetic schema tests for advisor_panels (isolated from model-map-validate.test.js WIP).
// Run: node test/advisor-panels-validate.test.js

const { validateConfig } = require('../tools/model-map-validate.js');

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
  validateConfig(config, errors, {});
  return errors;
}

const BASE = {
  backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
  endpoints: { local: { format: 'ollama-legacy', url: 'http://localhost:11434', auth: 'none' } },
  model_routes: { 'test-model': 'local' },
  llm_profiles: {
    planner: { 'best-cloud': { '64gb': 'test-model' }, 'best-cloud-gov': { '64gb': 'test-model' } },
    'code-reviewer': { 'best-cloud': { '64gb': 'test-model' }, 'best-cloud-gov': { '64gb': 'test-model' } },
    generalist: { 'best-cloud': { '64gb': 'test-model' }, 'best-cloud-gov': { '64gb': 'test-model' } },
  },
  agent_to_capability: {
    planner: 'planner',
    'code-reviewer': 'code-reviewer',
    generalist: 'generalist',
    deepseek: 'model:deepseek-v4-pro:cloud',
  },
  llm_mode: 'best-cloud',
};

console.log('advisor-panels-validate tests\n');

console.log('1. valid advisor_panels.default passes');
{
  const cfg = {
    ...BASE,
    advisor_panels: {
      default: {
        'best-cloud': { seats: ['planner', 'code-reviewer', 'generalist'] },
        'best-cloud-gov': { seats: ['planner', 'code-reviewer', 'generalist'] },
      },
    },
  };
  const errs = validate(cfg);
  assert(errs.length === 0, `valid panels → no errors (got ${errs.join('; ')})`);
}

console.log('\n2. missing default fails');
{
  const cfg = {
    ...BASE,
    advisor_panels: {
      review: {
        'best-cloud': { seats: ['planner', 'code-reviewer', 'generalist'] },
      },
    },
  };
  const errs = validate(cfg);
  assert(errs.some((e) => e.includes('advisor_panels.default')),
    `missing default → error (got ${errs.join('; ')})`);
}

console.log('\n3. seats length 1 fails');
{
  const cfg = {
    ...BASE,
    advisor_panels: {
      default: {
        'best-cloud': { seats: ['planner'] },
      },
    },
  };
  const errs = validate(cfg);
  assert(errs.some((e) => e.includes('seats') && e.includes('2')),
    `seats length 1 → error (got ${errs.join('; ')})`);
}

console.log('\n4. gov mode seating deepseek fails');
{
  const cfg = {
    ...BASE,
    advisor_panels: {
      default: {
        'best-cloud-gov': { seats: ['deepseek', 'planner', 'generalist'] },
      },
    },
  };
  const errs = validate(cfg);
  assert(errs.some((e) => e.includes('Chinese-origin') || e.includes('deepseek')),
    `gov deepseek seat → error (got ${errs.join('; ')})`);
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
