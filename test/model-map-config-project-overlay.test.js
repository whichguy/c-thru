#!/usr/bin/env node
'use strict';
// Regression test for the project-overlay pollution fix (commit 956d469).
// resolveSelectedConfigPath must:
//   (a) find a project config when cwd is inside a project that has .claude/model-map.json
//   (b) NOT treat the profile's own ~/.claude/model-map.json as a project overlay
//   (c) return source:'profile' when cwd IS (or is under) the profile dir
//
// These tests work purely in-process by creating temp directories with the
// appropriate file layout and calling resolveSelectedConfigPath directly.
// No proxy is spawned.
//
// Run: node test/model-map-config-project-overlay.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Import the module under test WITHOUT running its main() (it checks require.main).
const {
  resolveSelectedConfigPath,
  findParentModelMap,
  canonicalizeDir,
  canonicalizeFile,
} = require('../tools/model-map-config.js');
// syncLayeredConfig exercises the (nested, non-exported) writeIfChanged temp-file
// guard directly — used by the temp-file-safety case below.
const { syncLayeredConfig } = require('../tools/model-map-layered.js');

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
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// Create a minimal valid model-map.json in the given directory (including
// any .claude/ sub-dir required by the path).
function writeModelMap(dir, subPath = 'model-map.json') {
  const full = path.join(dir, subPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify({ _test: true }));
  return full;
}

console.log('model-map-config project-overlay tests\n');

// ── Fixtures ──────────────────────────────────────────────────────────────────
// All temp dirs cleaned up at the end.
const roots = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-overlay-test-'));
  roots.push(d);
  return d;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

try {
  // ── Test 1: findParentModelMap finds project config in a parent dir ───────
  console.log('1. findParentModelMap finds .claude/model-map.json in a parent directory');
  {
    const root = tmpDir();
    const projectDir = path.join(root, 'my-project');
    const deepDir = path.join(projectDir, 'src', 'components');
    fs.mkdirSync(deepDir, { recursive: true });
    // Place .claude/model-map.json at the project root.
    writeModelMap(projectDir, '.claude/model-map.json');

    // Searching from a deeply nested subdirectory should surface the project config.
    const found = findParentModelMap(deepDir);
    assert(found !== null, 'findParentModelMap returns non-null');
    assert(typeof found === 'string' && found.endsWith('model-map.json'),
      `found path ends with model-map.json (got: ${found})`);
    assert(found.includes(projectDir) || found.startsWith(path.dirname(projectDir)),
      `found path is inside project dir (got: ${found})`);
  }

  // ── Test 2: findParentModelMap returns null when no project config exists ──
  console.log('\n2. findParentModelMap returns null when no .claude/model-map.json in ancestors');
  {
    const root = tmpDir();
    const subDir = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(subDir, { recursive: true });
    // No .claude/model-map.json anywhere in root tree.
    const found = findParentModelMap(subDir);
    assert(found === null, `findParentModelMap returns null (got: ${found})`);
  }

  // ── Test 3: profile dir's own model-map.json is NOT treated as project overlay ──
  // This is the core regression: when the user's cwd is inside ~/.claude/ (or
  // IS ~/.claude/), findParentModelMap would previously return
  // ~/.claude/model-map.json. resolveSelectedConfigPath must filter that out
  // so the profile file is never used as a project overlay.
  console.log('\n3. Profile dir\'s model-map.json is NOT returned as a project overlay');
  {
    const profileDir = tmpDir();
    // Write both a profile model-map.json (the normal profile file) and a
    // system map so maybeSyncLayeredProfileModelMap has something to work with.
    const profileMap = writeModelMap(profileDir, 'model-map.json');
    const systemMap  = writeModelMap(profileDir, 'model-map.system.json');
    const overrides  = path.join(profileDir, 'model-map.overrides.json');
    fs.writeFileSync(overrides, '{}');

    // Simulate the proxy launched from a cwd that IS the profile dir itself.
    // resolveSelectedConfigPath should return source:'profile', not source:'project-overlay'.
    withEnv({
      CLAUDE_PROFILE_DIR: profileDir,
      CLAUDE_MODEL_MAP_PATH: undefined,
      CLAUDE_MODEL_MAP_LAUNCH_CWD: profileDir,
    }, () => {
      // syncProfile:false avoids spawning child processes in the test.
      const result = resolveSelectedConfigPath({ syncProfile: false });
      assert(result !== null, 'resolveSelectedConfigPath returns a result');
      if (result) {
        // Must not be source:'project-overlay' — the profile's own map
        // must never be mistaken for a project config.
        assert(result.source !== 'project-overlay',
          `source is not 'project-overlay' (got: ${result.source})`);
        assertEq(result.source, 'profile', 'source is "profile"');
      }
    });
  }

  // ── Test 4: project dir above profile dir is recognised correctly ──────────
  // When cwd is /home/user/projects/foo and ~/.claude/model-map.json exists,
  // but there's also a /home/user/projects/foo/.claude/model-map.json, the
  // project overlay must win. Conversely, if the project map IS the profile
  // map (same path), it should be filtered.
  console.log('\n4. Genuine project config (different from profile dir) IS recognised');
  {
    const profileDir = tmpDir();
    const projectDir = tmpDir();  // completely separate temp directory

    // Profile setup.
    writeModelMap(profileDir, 'model-map.json');
    writeModelMap(profileDir, 'model-map.system.json');
    fs.writeFileSync(path.join(profileDir, 'model-map.overrides.json'), '{}');

    // Project config.
    writeModelMap(projectDir, '.claude/model-map.json');

    // Launch cwd is inside the project (NOT the profile dir).
    const cwdInsideProject = path.join(projectDir, 'subdir');
    fs.mkdirSync(cwdInsideProject, { recursive: true });

    // findParentModelMap should find the project config (not the profile).
    const projectMap = findParentModelMap(cwdInsideProject);
    assert(projectMap !== null, 'project map found');
    assert(typeof projectMap === 'string' && projectMap.includes(projectDir),
      `found map is in project dir, not profile dir (got: ${projectMap})`);

    // The profile map path and the project map path must differ.
    const profileMap = path.join(profileDir, 'model-map.json');
    assert(projectMap !== profileMap,
      `project map path differs from profile map path`);
  }

  // ── Test 5: canonicalizeFile returns null for non-existent file ───────────
  console.log('\n5. canonicalizeFile returns null for missing file and non-absolute path');
  {
    assert(canonicalizeFile('/does/not/exist/model-map.json') === null,
      'canonicalizeFile(missing) → null');
    assert(canonicalizeFile('relative/path.json') === null,
      'canonicalizeFile(relative) → null');
    assert(canonicalizeFile('') === null,
      'canonicalizeFile("") → null');
    assert(canonicalizeFile(null) === null,
      'canonicalizeFile(null) → null');
  }

  // ── Test 6: canonicalizeDir returns null for file, non-absolute, missing ──
  console.log('\n6. canonicalizeDir returns null for files and invalid inputs');
  {
    const tmpFile = path.join(os.tmpdir(), `canotest-${process.pid}.txt`);
    fs.writeFileSync(tmpFile, 'test');
    try {
      assert(canonicalizeDir(tmpFile) === null,
        'canonicalizeDir(file path) → null');
      assert(canonicalizeDir('relative') === null,
        'canonicalizeDir(relative) → null');
      assert(canonicalizeDir('') === null,
        'canonicalizeDir("") → null');
      // A real directory should work.
      const realTmp = os.tmpdir();
      const result = canonicalizeDir(realTmp);
      assert(result !== null && typeof result === 'string',
        `canonicalizeDir(real dir) returns non-null string (got: ${result})`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  // ── Test 7: Pass-2 POSITIVE — project overlay carries the project key, the ──
  //   shared profile does NOT (the C1 anti-pollution guarantee), and the overlay
  //   lands in the deterministic per-uid 0700 dir from sessionEffectivePath.
  // Tests 1–4 only assert the NEGATIVE half (source != 'project-overlay', no
  // pollution) under syncProfile:false — Pass 2 was dead-to-tests. This drives
  // the real selection path (syncProfile:true) end-to-end.
  console.log('\n7. Pass-2: project overlay holds the project key; shared profile stays clean (C1)');
  {
    const profileDir = tmpDir();
    const projectDir = tmpDir();  // completely separate temp directory
    // Marker that exists ONLY in the project tier. If the shared profile ever
    // contains it, project config has leaked into the global config (the C1 bug).
    const PROJECT_KEY = '_c_thru_overlay_project_marker';

    // Project config: .claude/model-map.json with the project-only marker key.
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.claude', 'model-map.json'),
      JSON.stringify({ [PROJECT_KEY]: true }),
    );

    // Launch cwd is inside the project (NOT the profile dir).
    const cwdInsideProject = path.join(projectDir, 'subdir');
    fs.mkdirSync(cwdInsideProject, { recursive: true });

    withEnv({
      CLAUDE_PROFILE_DIR: profileDir,
      CLAUDE_MODEL_MAP_PATH: undefined,        // no env override → exercise the overlay branch
      CLAUDE_MODEL_MAP_LAUNCH_CWD: cwdInsideProject,
    }, () => {
      // syncProfile:true runs maybeSyncLayeredProfileModelMap: Pass 1 writes the
      // shared profile (system+global only), Pass 2 writes the per-uid overlay
      // (system+global+project).
      const result = resolveSelectedConfigPath({ syncProfile: true });
      assert(result !== null, 'resolveSelectedConfigPath returns a result');
      if (result) {
        assertEq(result.source, 'project-overlay', 'source is "project-overlay" (Pass 2 selected)');

        // The overlay file MUST contain the project-only key.
        const overlay = JSON.parse(fs.readFileSync(result.path, 'utf8'));
        assertEq(overlay[PROJECT_KEY], true, 'overlay file contains the PROJECT key');

        // The shared profile (~/.claude/model-map.json) must NOT — C1 guarantee.
        const profileMapPath = path.join(profileDir, 'model-map.json');
        const profileMap = JSON.parse(fs.readFileSync(profileMapPath, 'utf8'));
        assert(!Object.prototype.hasOwnProperty.call(profileMap, PROJECT_KEY),
          'shared profile does NOT contain the project key (no pollution)');

        // The overlay path is the deterministic per-uid 0700 dir keyed by uid,
        // matching sessionEffectivePath's layout: $TMPDIR/c-thru-<uid>/...
        // (compare via realpath since resolveSelectedConfigPath canonicalizes).
        const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
        const expectedUserDir = path.join(os.tmpdir(), `c-thru-${uid}`);
        const stat = fs.statSync(expectedUserDir);
        assertEq(stat.mode & 0o777, 0o700, 'per-uid overlay dir is mode 0700');
        assertEq(
          fs.realpathSync(path.dirname(result.path)),
          fs.realpathSync(expectedUserDir),
          'overlay lives in the deterministic per-uid dir (sessionEffectivePath layout)',
        );
      }
    });
  }

  // ── Test 8: temp-file safety — writeIfChanged refuses to follow a symlink ──
  //   planted at the effective-output path (the C8/C21 guard), so the victim
  //   the symlink points at is never overwritten. writeIfChanged is nested in
  //   syncLayeredConfig (not exported), so we exercise it via syncLayeredConfig.
  console.log('\n8. temp-file safety: writeIfChanged refuses a pre-planted symlink at the write target');
  {
    const root = tmpDir();
    const defaultsPath = path.resolve(__dirname, '..', 'config', 'model-map.json');
    const globalPath = path.join(root, 'overrides.json');
    fs.writeFileSync(globalPath, '{}');
    const projectPath = path.join(root, 'project.json');
    fs.writeFileSync(projectPath, JSON.stringify({ _c_thru_overlay_symlink_marker: true }));

    // The victim the planted symlink points at — must survive untouched.
    const victimPath = path.join(root, 'victim.txt');
    const VICTIM_CONTENT = 'DO_NOT_OVERWRITE_VIA_SYMLINK';
    fs.writeFileSync(victimPath, VICTIM_CONTENT);

    // Plant a symlink at the effective-output target before the write.
    const effectivePath = path.join(root, 'effective.json');
    fs.symlinkSync(victimPath, effectivePath);

    // syncLayeredConfig → writeIfChanged(effectivePath, ...). The guard lstat's
    // the target, sees a symlink, unlinks it, then atomically writes a fresh
    // regular file — never following the link to the victim.
    syncLayeredConfig(defaultsPath, globalPath, projectPath, effectivePath);

    const lst = fs.lstatSync(effectivePath);
    assert(!lst.isSymbolicLink(), 'planted symlink was dropped, not followed');
    assert(lst.isFile(), 'effective target is now a regular file');
    assertEq(fs.readFileSync(victimPath, 'utf8'), VICTIM_CONTENT,
      'victim file the symlink pointed at is NOT overwritten');
    // And the real write landed: effective got the merged project marker.
    const effObj = JSON.parse(fs.readFileSync(effectivePath, 'utf8'));
    assertEq(effObj._c_thru_overlay_symlink_marker, true,
      'fresh effective file contains the merged project marker');
  }

} finally {
  // Clean up all temp directories.
  for (const d of roots) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
