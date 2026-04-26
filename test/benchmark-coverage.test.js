#!/usr/bin/env node
'use strict';
// benchmark-coverage: drives shipped config/model-map.json × docs/benchmark.json
// and asserts each (tier × capability × slot) picks a documented model. Quality
// below role minimum is WARN; missing model entry is FAIL.
//
// Catches: typos in config, accidentally-removed models, capabilities picking
// models with quality below their role minimum.
//
// Run: node test/benchmark-coverage.test.js

const fs   = require('fs');
const path = require('path');

const { assert, summary } = require('./helpers');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'model-map.json'), 'utf8'));
const bench  = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs',   'benchmark.json'),   'utf8'));

console.log('benchmark-coverage: shipped config × benchmark.json\n');

const profiles = config.llm_profiles || {};
const models   = bench.models           || {};
const roleMin  = bench.role_minimums    || {};
const c2r      = bench.capability_to_role || {};

let warnings = 0;
let failures = 0;
let cellsChecked = 0;

// Skip non-model fields in profile entries (modes, on_failure, etc.)
const MODEL_SLOTS = ['connected_model', 'disconnect_model', 'cloud_best_model', 'local_best_model'];

// Track caps already warned about missing-mapping (avoid duplicate warns per cell)
const _missingC2R = new Set();

for (const [tier, tierProfile] of Object.entries(profiles)) {
  for (const [cap, entry] of Object.entries(tierProfile)) {
    if (!entry || typeof entry !== 'object') continue;
    const role = c2r[cap];
    if (!role && !_missingC2R.has(cap)) {
      console.warn(`  WARN  capability '${cap}' has no entry in benchmark.json capability_to_role — quality checks skipped`);
      _missingC2R.add(cap);
      warnings++;
    }
    const minQ = role ? roleMin[role] : null;

    // Direct slots
    for (const slot of MODEL_SLOTS) {
      const m = entry[slot];
      if (typeof m !== 'string' || !m) continue;
      cellsChecked++;
      const meta = models[m];
      if (!meta) {
        console.error(`  FAIL  ${tier}/${cap}.${slot}: '${m}' — not in benchmark.json`);
        failures++;
        continue;
      }
      // Quality check
      if (role && minQ != null) {
        const q = meta.quality_per_role?.[role];
        if (q == null) {
          // No data — informational only
          if (process.env.BENCH_VERBOSE === '1') {
            console.log(`  info  ${tier}/${cap}.${slot}: ${m} — no quality data for role '${role}'`);
          }
        } else if (q < minQ) {
          console.warn(`  WARN  ${tier}/${cap}.${slot}: ${m} q=${q} < minimum ${minQ} for role '${role}'`);
          warnings++;
        }
      }
    }

    // modes[] overrides
    if (entry.modes && typeof entry.modes === 'object') {
      for (const [modeName, modeModel] of Object.entries(entry.modes)) {
        if (typeof modeModel !== 'string' || !modeModel) continue;
        cellsChecked++;
        if (!models[modeModel]) {
          console.error(`  FAIL  ${tier}/${cap}.modes['${modeName}']: '${modeModel}' — not in benchmark.json`);
          failures++;
        }
      }
    }
  }
}

// Final assertions for the test framework
assert(failures === 0,
  `all chosen models have benchmark entries (got ${failures} unknown across ${cellsChecked} cells)`);

// Don't fail the test on warnings — they're advisory
console.log(`\nCells checked: ${cellsChecked}`);
console.log(`Warnings: ${warnings} (quality below role minimum — advisory)`);
console.log(`Failures: ${failures} (model not in benchmark — structural)`);

const failed = summary();
process.exit(failed ? 1 : 0);
