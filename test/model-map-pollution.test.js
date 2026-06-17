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
const SYNC_TOOL = path.join(REPO_ROOT, 'tools', 'model-map-sync.js');
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

// ── Test 9 + 10: sync_tool with '' project arg keeps profile project-agnostic (C1) ──
// tools/c-thru's sync_layered_profile_model_map passes '' for the project tier
// when invoking model-map-sync.js, so the shared ~/.claude/model-map.json profile
// never receives project-tier entries. model-map-sync.js coerces a falsy project
// arg to projectPath:null, so syncLayeredConfig merges only defaults+global into
// the profile. These tests invoke the same sync_tool directly with the same
// positional args (defaults, global, '', output) and assert the resulting profile
// carries the global key but NOT the project-only key.
{
  // Minimal valid config tree, mirroring model-map-layered.test.js's BASE shape.
  const DEFAULTS = {
    backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
    model_routes: { 'base-model': 'local' },
    llm_mode: 'best-cloud',
    llm_profiles: { workhorse: { 'best-cloud': { '16gb': 'base-model' } } },
  };
  const GLOBAL  = { model_routes: { 'global-only-model': 'local' } };
  const PROJECT = { model_routes: { 'project-only-model': 'local' } };

  function runSync(tmpDir, projectArg, outName) {
    const defaultsPath = path.join(tmpDir, 'defaults.json');
    const globalPath   = path.join(tmpDir, 'global.json');
    const projectPath  = path.join(tmpDir, 'project.json');
    const outPath      = path.join(tmpDir, outName);
    fs.writeFileSync(defaultsPath, JSON.stringify(DEFAULTS));
    fs.writeFileSync(globalPath,   JSON.stringify(GLOBAL));
    fs.writeFileSync(projectPath,  JSON.stringify(PROJECT));
    // projectArg of '' (the C1 fix) → model-map-sync.js coerces to projectPath:null.
    const arg = projectArg === '' ? '' : projectPath;
    const r = spawnSync(process.execPath, [SYNC_TOOL, defaultsPath, globalPath, arg, outPath], {
      cwd: REPO_ROOT, encoding: 'utf8',
    });
    const profile = fs.existsSync(outPath)
      ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null;
    return { result: r, profile };
  }

  // ── Test 9: '' project arg → profile has NO project-only key ──────────────
  (function testSyncEmptyProjectArg() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-sync-c1-'));
    try {
      const { result, profile } = runSync(tmpDir, '', 'profile.json');
      assertEq(result.status, 0, "test9: sync_tool with '' project arg exits 0");
      assert(profile !== null, 'test9: profile output written');
      const routes = (profile && profile.model_routes) || {};
      assert('global-only-model' in routes,
        "test9: profile carries the global-tier key (system+global merged)");
      assert(!('project-only-model' in routes),
        `test9: profile has NO project-only key (got keys: ${Object.keys(routes).join(', ')})`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();

  // ── Test 10: contrast — passing the project path DOES merge the project key ──
  // Proves test9's assertion is load-bearing: the project key is project-agnostic
  // only because the '' project arg drops it, not because the data is absent.
  (function testSyncWithProjectArg() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-sync-c1b-'));
    try {
      const { result, profile } = runSync(tmpDir, 'with-project', 'profile.json');
      assertEq(result.status, 0, 'test10: sync_tool with project path exits 0');
      const routes = (profile && profile.model_routes) || {};
      assert('project-only-model' in routes,
        `test10: passing the project path DOES merge the project key (got keys: ${Object.keys(routes).join(', ')})`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();
}

const exitCode = summary();
process.exit(exitCode ? 1 : 0);
