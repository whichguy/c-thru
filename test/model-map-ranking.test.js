#!/usr/bin/env node
'use strict';
// Unit tests for benchmark-driven ranking — Phase 3 of the modes work.
// Pure functions only, no proxy spawn. Uses synthetic benchmark fixtures so
// tests don't break when docs/benchmark.json updates.
//
// Run: node test/model-map-ranking.test.js

const {
  rankableScore, pickBenchmarkBest, isOpenSource,
} = require('../tools/model-map-resolve');

const { assert, assertEq, summary } = require('./helpers');

console.log('benchmark-driven ranking — unit tests\n');

// ── Synthetic benchmark fixture ─────────────────────────────────────────────
const BENCH = {
  schema_version: 1,
  models: {
    'fast-good':     { provider: 'ollama_local', ram_gb: 10, tokens_per_sec: 100, quality_per_role: { coder: 4.5, generalist: 4.0 } },
    'fast-meh':      { provider: 'ollama_local', ram_gb: 10, tokens_per_sec: 120, quality_per_role: { coder: 3.0 } },
    'slow-great':    { provider: 'ollama_local', ram_gb: 30, tokens_per_sec: 25,  quality_per_role: { coder: 5.0, generalist: 5.0 } },
    'tiny-good':     { provider: 'ollama_local', ram_gb: 5,  tokens_per_sec: 80,  quality_per_role: { coder: 4.5 } },
    'huge-best':     { provider: 'ollama_local', ram_gb: 70, tokens_per_sec: 40,  quality_per_role: { coder: 5.0 } },
    'claude-cloud':  { provider: 'claude',       ram_gb: null, tokens_per_sec: null, quality_per_role: { coder: 5.0, generalist: 5.0 } },
    'no-data':       { provider: 'ollama_local', ram_gb: 8,  tokens_per_sec: 60,  quality_per_role: {} },
  },
  role_minimums: { coder: 4.0, generalist: 3.5 },
};

const MODEL_ROUTES = {
  'fast-good':    'ollama_local',
  'fast-meh':     'ollama_local',
  'slow-great':   'ollama_local',
  'tiny-good':    'ollama_local',
  'huge-best':    'ollama_local',
  'claude-cloud': 'anthropic',
  'no-data':      'ollama_local',
};
const BACKENDS = {
  ollama_local: { id: 'ollama_local', kind: 'ollama',    url: 'http://localhost:11434' },
  anthropic:    { id: 'anthropic',    kind: 'anthropic', url: 'https://api.anthropic.com' },
};

const ALL = Object.keys(BENCH.models);

// ── rankableScore ───────────────────────────────────────────────────────────
console.log('1. rankableScore');

// fastest: returns t/s for qualified models, null otherwise
assertEq(rankableScore('fastest', 'fast-good', BENCH, 'coder', 4.0), 100, 'fastest: returns t/s');
assertEq(rankableScore('fastest', 'fast-meh',  BENCH, 'coder', 4.0), null, 'fastest: below threshold disqualified');
assertEq(rankableScore('fastest', 'no-data',   BENCH, 'coder', 4.0), null, 'fastest: missing role data disqualified');
assertEq(rankableScore('fastest', 'unknown',   BENCH, 'coder', 4.0), null, 'fastest: unknown model disqualified');

// smallest: returns negated RAM (so higher score = smaller model)
assertEq(rankableScore('smallest', 'fast-good',  BENCH, 'coder', 4.0), -10, 'smallest: returns -ram_gb');
assertEq(rankableScore('smallest', 'tiny-good',  BENCH, 'coder', 4.0), -5,  'smallest: tiny-good is -5');
assertEq(rankableScore('smallest', 'fast-meh',   BENCH, 'coder', 4.0), null, 'smallest: below threshold disqualified');

// best-opensource: returns quality directly
assertEq(rankableScore('best-opensource', 'slow-great', BENCH, 'coder', 4.0), 5.0, 'best-opensource: returns q');
assertEq(rankableScore('best-opensource', 'fast-good',  BENCH, 'coder', 4.0), 4.5, 'best-opensource: lower q lower score');

// ── pickBenchmarkBest: fastest ──────────────────────────────────────────────
console.log('\n2. pickBenchmarkBest: fastest-possible');

assertEq(
  pickBenchmarkBest('fastest', ALL, BENCH, 'coder', MODEL_ROUTES, BACKENDS),
  'fast-good',
  'fastest among coder-qualifiers: fast-good (100 t/s) > tiny-good (80) > slow-great (25) > huge-best (40)'
);

// generalist role — different qualifier set
assertEq(
  pickBenchmarkBest('fastest', ALL, BENCH, 'generalist', MODEL_ROUTES, BACKENDS),
  'fast-good',
  'fastest generalist: fast-good (100) qualifies; fast-meh has no generalist quality'
);

// All disqualified → null
assertEq(
  pickBenchmarkBest('fastest', ALL, BENCH, 'unknown-role', MODEL_ROUTES, BACKENDS),
  null,
  'no role data → null'
);

// Empty candidates
assertEq(
  pickBenchmarkBest('fastest', [], BENCH, 'coder', MODEL_ROUTES, BACKENDS),
  null,
  'empty candidates → null'
);

// ── pickBenchmarkBest: smallest ─────────────────────────────────────────────
console.log('\n3. pickBenchmarkBest: smallest-possible');

assertEq(
  pickBenchmarkBest('smallest', ALL, BENCH, 'coder', MODEL_ROUTES, BACKENDS),
  'tiny-good',
  'smallest qualifying coder: tiny-good (5GB)'
);

// Subset without tiny-good
assertEq(
  pickBenchmarkBest('smallest', ['fast-good', 'slow-great', 'huge-best'], BENCH, 'coder', MODEL_ROUTES, BACKENDS),
  'fast-good',
  'smallest of subset: fast-good (10GB) < slow-great (30) < huge-best (70)'
);

// ── pickBenchmarkBest: best-opensource ──────────────────────────────────────
console.log('\n4. pickBenchmarkBest: best-opensource');

// Should skip claude-cloud entirely
const bestOS = pickBenchmarkBest('best-opensource', ALL, BENCH, 'coder', MODEL_ROUTES, BACKENDS);
assert(bestOS !== 'claude-cloud', `Claude excluded from OS ranking (got ${bestOS})`);

// slow-great and huge-best both q=5.0 for coder. Tiebreak: t/s. slow-great=25 vs huge-best=40
// So huge-best wins on t/s tiebreak.
assertEq(bestOS, 'huge-best', 'best-opensource coder: huge-best (q=5.0, 40 t/s) beats slow-great (q=5.0, 25 t/s) on tiebreak');

// generalist: slow-great q=5.0, fast-good q=4.0. slow-great wins on quality.
assertEq(
  pickBenchmarkBest('best-opensource', ALL, BENCH, 'generalist', MODEL_ROUTES, BACKENDS),
  'slow-great',
  'best-opensource generalist: slow-great (q=5.0) > fast-good (q=4.0)'
);

// ── Tiebreak: q same, t/s same → smaller RAM wins ──────────────────────────
console.log('\n5. tiebreaks');

const TIE_BENCH = {
  schema_version: 1,
  models: {
    'a-large':  { provider: 'ollama_local', ram_gb: 30, tokens_per_sec: 50, quality_per_role: { coder: 5.0 } },
    'b-small':  { provider: 'ollama_local', ram_gb: 10, tokens_per_sec: 50, quality_per_role: { coder: 5.0 } },
  },
  role_minimums: { coder: 4.0 },
};
assertEq(
  pickBenchmarkBest('best-opensource', ['a-large', 'b-small'], TIE_BENCH, 'coder', MODEL_ROUTES, BACKENDS),
  'b-small',
  'tiebreak q=5/tps=50: smaller RAM wins (b-small 10GB > a-large 30GB)'
);

// All identical except name → alphabetical (smaller string)
const ALPHA_BENCH = {
  schema_version: 1,
  models: {
    'zebra': { provider: 'ollama_local', ram_gb: 10, tokens_per_sec: 50, quality_per_role: { coder: 5.0 } },
    'apple': { provider: 'ollama_local', ram_gb: 10, tokens_per_sec: 50, quality_per_role: { coder: 5.0 } },
    'mango': { provider: 'ollama_local', ram_gb: 10, tokens_per_sec: 50, quality_per_role: { coder: 5.0 } },
  },
  role_minimums: { coder: 4.0 },
};
assertEq(
  pickBenchmarkBest('best-opensource', ['zebra', 'apple', 'mango'], ALPHA_BENCH, 'coder', MODEL_ROUTES, BACKENDS),
  'apple',
  'all-tied → alphabetical: apple wins (deterministic)'
);

const failed = summary();
process.exit(failed ? 1 : 0);
