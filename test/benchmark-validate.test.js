#!/usr/bin/env node
'use strict';
// tools/benchmark-validate.js (139 LOC, schema validator for docs/benchmark.json)
// only got indirect exercise via tools/c-thru-contract-check.sh before this
// file — no test targeted its own edge cases directly.
//
// The script resolves its cross-check config (config/model-map.json) relative
// to its own __dirname (repoRoot/config/model-map.json), not via argv — so
// each case runs against a scratch copy of the script at <tmp>/tools/ with a
// sibling <tmp>/config/model-map.json, exercising the real code unmodified.
//
// Run: node test/benchmark-validate.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { assert, assertEq, summary } = require('./helpers');

const REPO_DIR = path.join(__dirname, '..');
const SCRIPT_SOURCE = path.join(REPO_DIR, 'tools', 'benchmark-validate.js');

console.log('benchmark-validate tests\n');

function baseBenchmark() {
  return {
    schema_version: 1,
    models: {
      'coder-model': { provider: 'ollama_local', ram_gb: 16, tokens_per_sec: 40, quality_per_role: { generalist: 4.2 } },
    },
    role_minimums: { generalist: 3.0 },
    capability_to_role: { coder: 'generalist' },
  };
}

function baseConfig() {
  return { model_routes: { 'coder-model': 'ollama_local' } };
}

// run(benchmarkOverrides, configOverrides) -> { status, stdout, stderr }
function run(benchmarkOverrides, configOverrides) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-benchval-'));
  try {
    fs.mkdirSync(path.join(scratch, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'config'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'docs'), { recursive: true });
    fs.copyFileSync(SCRIPT_SOURCE, path.join(scratch, 'tools', 'benchmark-validate.js'));

    const bench = Object.assign(baseBenchmark(), benchmarkOverrides);
    const config = Object.assign(baseConfig(), configOverrides);
    fs.writeFileSync(path.join(scratch, 'docs', 'benchmark.json'), JSON.stringify(bench));
    fs.writeFileSync(path.join(scratch, 'config', 'model-map.json'), JSON.stringify(config));

    const r = spawnSync(process.execPath, [path.join(scratch, 'tools', 'benchmark-validate.js')], { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ── 1. Happy path ────────────────────────────────────────────────────────────
console.log('1. happy path — well-formed benchmark + matching model_routes');
{
  const r = run({}, {});
  assertEq(r.status, 0, `exits 0 on a valid benchmark (stderr: ${r.stderr})`);
  assert(r.stdout.includes('OK'), 'stdout reports OK');
}

// ── 2. schema_version ────────────────────────────────────────────────────────
console.log('\n2. schema_version checks');
{
  const missing = run({ schema_version: undefined }, {});
  assertEq(missing.status, 1, 'missing schema_version fails');
  assert(missing.stderr.includes('missing schema_version'), 'error names the missing field');

  const wrongType = run({ schema_version: '1' }, {});
  assertEq(wrongType.status, 1, 'non-number schema_version fails');
  assert(wrongType.stderr.includes('must be a number'), 'error explains the type requirement');

  const older = run({ schema_version: 0 }, {});
  assertEq(older.status, 1, 'older-than-supported schema_version fails');
  assert(older.stderr.includes('older than supported'), 'error explains the version mismatch');

  const newer = run({ schema_version: 2 }, {});
  assertEq(newer.status, 0, 'newer-than-supported schema_version is a forward-compat WARN, not a failure');
  assert(newer.stderr.includes('WARN') && newer.stderr.includes('newer than'), 'newer version emits a WARN, not an error');
}

// ── 3. Missing top-level keys ─────────────────────────────────────────────────
console.log('\n3. missing required top-level keys');
{
  const r = run({ role_minimums: undefined }, {});
  assertEq(r.status, 1, 'missing role_minimums fails');
  assert(r.stderr.includes('missing or non-object top-level field: role_minimums'), 'error names the missing key');
}

// ── 4. Bad provider ───────────────────────────────────────────────────────────
console.log('\n4. bad model.provider');
{
  const r = run({ models: { 'coder-model': { provider: 'not-a-real-provider' } } }, {});
  assertEq(r.status, 1, 'unknown provider fails');
  assert(r.stderr.includes('must be one of'), 'error lists the valid provider set');
}

// ── 5. Bad ram_gb / tokens_per_sec ────────────────────────────────────────────
console.log('\n5. bad ram_gb / tokens_per_sec');
{
  const badRam = run({ models: { 'coder-model': { provider: 'ollama_local', ram_gb: -4 } } }, {});
  assertEq(badRam.status, 1, 'negative ram_gb fails');
  assert(badRam.stderr.includes('ram_gb'), 'error names ram_gb');

  const badTok = run({ models: { 'coder-model': { provider: 'ollama_local', tokens_per_sec: 0 } } }, {});
  assertEq(badTok.status, 1, 'zero tokens_per_sec fails (must be positive)');
  assert(badTok.stderr.includes('tokens_per_sec'), 'error names tokens_per_sec');

  const nullOk = run({ models: { 'coder-model': { provider: 'ollama_local', ram_gb: null, tokens_per_sec: null } } }, {});
  assertEq(nullOk.status, 0, 'null ram_gb/tokens_per_sec is explicitly allowed');
}

// ── 6. quality_per_role out of [0, 5] ──────────────────────────────────────────
console.log('\n6. quality_per_role range');
{
  const tooHigh = run({ models: { 'coder-model': { provider: 'ollama_local', quality_per_role: { generalist: 5.5 } } } }, {});
  assertEq(tooHigh.status, 1, 'quality_per_role above 5 fails');

  const tooLow = run({ models: { 'coder-model': { provider: 'ollama_local', quality_per_role: { generalist: -0.1 } } } }, {});
  assertEq(tooLow.status, 1, 'quality_per_role below 0 fails');

  const boundary = run({ models: { 'coder-model': { provider: 'ollama_local', quality_per_role: { generalist: 5 } } } }, {});
  assertEq(boundary.status, 0, 'quality_per_role exactly 5 is valid (inclusive boundary)');
}

// ── 7. capability_to_role references an unknown role ──────────────────────────
console.log('\n7. capability_to_role unknown role reference');
{
  const r = run({ capability_to_role: { coder: 'nonexistent-role' } }, {});
  assertEq(r.status, 1, 'reference to a role absent from role_minimums fails');
  assert(r.stderr.includes("references role 'nonexistent-role'"), 'error names the dangling role reference');
}

// ── 8. Model missing from model_routes (with re: pattern exemption) ──────────
console.log('\n8. model_routes cross-check, including the re: pattern exemption');
{
  const missing = run({}, { model_routes: {} });
  assertEq(missing.status, 1, 'benchmark model absent from model_routes fails');
  assert(missing.stderr.includes('not present in config/model-map.json model_routes'), 'error names the missing model_routes entry');

  const patternExempt = run({}, { model_routes: { 're:^coder-.*$': 'ollama_local' } });
  assertEq(patternExempt.status, 0, 'a matching re: pattern route exempts the model from the literal-entry requirement');
}

// ── 9. Reverse coverage: model_routes entry with no benchmark — WARN not FAIL ─
console.log('\n9. model_routes entry with no benchmark counterpart is a WARN, not a failure');
{
  const r = run({}, { model_routes: { 'coder-model': 'ollama_local', 'unbenchmarked-model': 'ollama_local' } });
  assertEq(r.status, 0, 'unbenchmarked model_routes entry does not fail validation');
  assert(r.stderr.includes("model_routes['unbenchmarked-model'] has no benchmark entry"), 'a coverage WARN is still emitted');
}

const failed = summary();
process.exit(failed ? 1 : 0);
