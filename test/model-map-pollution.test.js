#!/usr/bin/env node
'use strict';
// Unit tests for tools/model-map-config.js --detect-pollution / --clean-pollution
// CLI modes (added in commit 57bc02a). Stdlib-only, no test framework.
//
// Run with: node test/model-map-pollution.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'tools', 'model-map-config.js');
const REPO_DEFAULTS = path.join(REPO_ROOT, 'config', 'model-map.json');

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

function assertEq(actual, expected, label) {
  assert(actual === expected,
    `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

function summary() {
  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed`);
  return failed;
}

// Create a fresh tmpHome with .claude/ populated. If `seedSystem` is true,
// copies repo defaults into model-map.system.json + model-map.json. If false,
// only writes overrides (so the CLI must fall back to repoDefaultsPath()).
function makeTmpHome(seedSystem = true) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-pollution-'));
  const claudeDir = path.join(tmpHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  fs.writeFileSync(path.join(claudeDir, 'model-map.overrides.json'), '{}');

  if (seedSystem) {
    const defaults = fs.readFileSync(REPO_DEFAULTS, 'utf8');
    fs.writeFileSync(path.join(claudeDir, 'model-map.system.json'), defaults);
    fs.writeFileSync(path.join(claudeDir, 'model-map.json'), defaults);
  } else {
    // Fresh-home case: no system file, but profile model-map.json is needed
    // because the CLI reads it directly. Seed it from repo defaults so the
    // pollution scan has something to compare against.
    const defaults = fs.readFileSync(REPO_DEFAULTS, 'utf8');
    fs.writeFileSync(path.join(claudeDir, 'model-map.json'), defaults);
  }

  return { tmpHome, claudeDir };
}

function runCLI(tmpHome, ...flags) {
  return spawnSync(process.execPath, [CLI, ...flags], {
    env: {
      ...process.env,
      HOME: tmpHome,
      CLAUDE_PROFILE_DIR: path.join(tmpHome, '.claude'),
      // Avoid env leakage to override path
      CLAUDE_MODEL_MAP_PATH: '',
    },
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function readProfile(claudeDir) {
  return JSON.parse(fs.readFileSync(path.join(claudeDir, 'model-map.json'), 'utf8'));
}

function injectLeaks(claudeDir, leakedKeys) {
  const profile = readProfile(claudeDir);
  profile.model_routes = profile.model_routes || {};
  for (const key of leakedKeys) {
    profile.model_routes[key] = { backend: 'leaked-backend', model: key };
  }
  fs.writeFileSync(path.join(claudeDir, 'model-map.json'), JSON.stringify(profile, null, 2));
}

console.log('model-map-pollution tests\n');

// ── Test 1: detect on clean profile ────────────────────────────────────────
(function testDetectClean() {
  const { tmpHome, claudeDir } = makeTmpHome(true);
  try {
    const result = runCLI(tmpHome, '--detect-pollution');
    assertEq(result.status, 0, 'test1: detect on clean profile exits 0');
    const out = (result.stdout || '') + (result.stderr || '');
    assert(/profile is clean|no leaked/i.test(out),
      `test1: output mentions clean/no-leaked (got: ${out.trim().slice(0, 200)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
})();

// ── Test 2: seed a leak in model_routes; detect names it & doesn't modify ──
(function testDetectWithLeak() {
  const { tmpHome, claudeDir } = makeTmpHome(true);
  try {
    injectLeaks(claudeDir, ['leaked-test-model-xyz']);
    const before = fs.readFileSync(path.join(claudeDir, 'model-map.json'), 'utf8');

    const result = runCLI(tmpHome, '--detect-pollution');
    assertEq(result.status, 0, 'test2: detect with leak exits 0');
    const out = (result.stdout || '') + (result.stderr || '');
    assert(out.includes('leaked-test-model-xyz'),
      `test2: output names the leaked key (got: ${out.trim().slice(0, 300)})`);
    assert(/detected\s+1\s+leaked/i.test(out),
      `test2: output reports count=1 (got: ${out.trim().slice(0, 300)})`);

    const after = fs.readFileSync(path.join(claudeDir, 'model-map.json'), 'utf8');
    assert(after === before, 'test2: detect does not modify the file');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
})();

// ── Test 3: clean-pollution removes the leaked key ─────────────────────────
(function testCleanRemovesLeak() {
  const { tmpHome, claudeDir } = makeTmpHome(true);
  try {
    injectLeaks(claudeDir, ['leaked-test-model-xyz']);

    const profileBefore = readProfile(claudeDir);
    assert(Object.prototype.hasOwnProperty.call(profileBefore.model_routes, 'leaked-test-model-xyz'),
      'test3: pre-condition: leak is present in profile');

    const result = runCLI(tmpHome, '--clean-pollution');
    assertEq(result.status, 0, 'test3: clean-pollution exits 0');

    const profileAfter = readProfile(claudeDir);
    assert(!Object.prototype.hasOwnProperty.call(profileAfter.model_routes || {}, 'leaked-test-model-xyz'),
      'test3: leaked key removed from profile after clean');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
})();

// ── Test 4: idempotent — second clean-pollution leaves file identical ──────
(function testCleanIdempotent() {
  const { tmpHome, claudeDir } = makeTmpHome(true);
  try {
    injectLeaks(claudeDir, ['leaked-test-model-xyz']);

    const r1 = runCLI(tmpHome, '--clean-pollution');
    assertEq(r1.status, 0, 'test4: first clean-pollution exits 0');

    const after1 = fs.readFileSync(path.join(claudeDir, 'model-map.json'), 'utf8');

    const r2 = runCLI(tmpHome, '--clean-pollution');
    assertEq(r2.status, 0, 'test4: second clean-pollution exits 0');

    const after2 = fs.readFileSync(path.join(claudeDir, 'model-map.json'), 'utf8');
    assert(after2 === after1, 'test4: file identical after second clean (idempotent)');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
})();

// ── Test 5: detect with multiple leaks reports correct count ───────────────
(function testDetectMultipleLeaks() {
  const { tmpHome, claudeDir } = makeTmpHome(true);
  try {
    injectLeaks(claudeDir, ['leak-a', 'leak-b', 'leak-c']);

    const result = runCLI(tmpHome, '--detect-pollution');
    assertEq(result.status, 0, 'test5: detect with multiple leaks exits 0');
    const out = (result.stdout || '') + (result.stderr || '');
    assert(/detected\s+3\s+leaked/i.test(out),
      `test5: output reports count=3 (got: ${out.trim().slice(0, 400)})`);
    assert(out.includes('leak-a'), 'test5: output names leak-a');
    assert(out.includes('leak-b'), 'test5: output names leak-b');
    assert(out.includes('leak-c'), 'test5: output names leak-c');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
})();

// ── Test 6: detect with no system file falls back to repo defaults ─────────
(function testDetectFreshHome() {
  // No model-map.system.json — CLI should fall back to repoDefaultsPath().
  const { tmpHome, claudeDir } = makeTmpHome(false);
  try {
    assert(!fs.existsSync(path.join(claudeDir, 'model-map.system.json')),
      'test6: pre-condition: no system file exists');

    const result = runCLI(tmpHome, '--detect-pollution');
    assertEq(result.status, 0, 'test6: detect on fresh home (no system file) exits 0');
    const out = (result.stdout || '') + (result.stderr || '');
    assert(/profile is clean|no leaked/i.test(out),
      `test6: output mentions clean/no-leaked via repo-defaults fallback (got: ${out.trim().slice(0, 300)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
})();

// ── Test 7: --detect-pollution --strict exits 0 on clean profile ───────────
(function testStrictClean() {
  const { tmpHome, claudeDir } = makeTmpHome(true);
  try {
    const result = runCLI(tmpHome, '--detect-pollution', '--strict');
    assertEq(result.status, 0, 'test7: --detect-pollution --strict exits 0 on clean profile');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
})();

// ── Test 8: --detect-pollution --strict exits 1 when drift is present ───────
(function testStrictWithLeak() {
  const { tmpHome, claudeDir } = makeTmpHome(true);
  try {
    injectLeaks(claudeDir, ['strict-test-leak-xyz']);
    const result = runCLI(tmpHome, '--detect-pollution', '--strict');
    assertEq(result.status, 1, 'test8: --detect-pollution --strict exits 1 when drift present');
    const out = (result.stdout || '') + (result.stderr || '');
    assert(out.includes('strict-test-leak-xyz'),
      `test8: output names the leaked key under --strict (got: ${out.trim().slice(0, 300)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
})();

const exitCode = summary();
process.exit(exitCode ? 1 : 0);
