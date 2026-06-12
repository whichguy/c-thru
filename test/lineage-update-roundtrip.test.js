#!/usr/bin/env node
'use strict';
// Round-trip regression test for `model-map-lineage.test.js --update`.
//
// The --update path silently no-op'd for months (anchor regex never matched,
// but it still printed "Snapshot updated.") because nothing ever *executed*
// --update under test. This encodes its three fixed behaviors against a tmp
// fixture so the silent-no-op class can never return:
//
//   1. Pristine config        → "no changes", file untouched, exit 0
//   2. Real resolution change → "Snapshot updated.", snapshot + date rewritten, exit 0
//   3. Corrupted anchor       → exit 1, loud "snapshot block not found" on stderr
//
// All runs operate on copies under a tmp dir mirroring the repo layout
// (test/ + tools/ + config/) — the real test file is never touched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-roundtrip-'));
  for (const dir of ['test', 'tools', 'config']) fs.mkdirSync(path.join(tmp, dir));
  // hw-profile.js is lazily required by model-map-resolve.js — copy it so the
  // fixture survives any code path that reaches tier detection.
  const copies = [
    ['test/model-map-lineage.test.js', 'test/model-map-lineage.test.js'],
    ['tools/model-map-resolve.js', 'tools/model-map-resolve.js'],
    ['tools/hw-profile.js', 'tools/hw-profile.js'],
    ['config/model-map.json', 'config/model-map.json'],
  ];
  for (const [src, dst] of copies) {
    fs.copyFileSync(path.join(REPO_ROOT, src), path.join(tmp, dst));
  }
  return tmp;
}

function runUpdate(tmp) {
  const res = { stdout: '', stderr: '', status: 0 };
  try {
    res.stdout = execFileSync(
      process.execPath, [path.join(tmp, 'test', 'model-map-lineage.test.js'), '--update'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (e) {
    res.status = e.status ?? 1;
    res.stdout = e.stdout || '';
    res.stderr = e.stderr || '';
  }
  return res;
}

// ── 1. Pristine config: honest no-change ────────────────────────────────────
console.log('\n1. Pristine config → honest "no changes"');
{
  const tmp = makeFixture();
  const testPath = path.join(tmp, 'test', 'model-map-lineage.test.js');
  const before = fs.readFileSync(testPath, 'utf8');
  const res = runUpdate(tmp);
  assert('exit 0', res.status === 0, `status=${res.status} stderr=${res.stderr.slice(0, 200)}`);
  assert('stdout reports "no changes"', /no changes/.test(res.stdout), `stdout=${res.stdout.slice(0, 200)}`);
  assert('file content unchanged', fs.readFileSync(testPath, 'utf8') === before);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 2. Real resolution change: snapshot actually rewritten ──────────────────
console.log('\n2. Changed config → snapshot rewritten with new value + fresh date');
{
  const tmp = makeFixture();
  const testPath = path.join(tmp, 'test', 'model-map-lineage.test.js');
  const cfgPath = path.join(tmp, 'config', 'model-map.json');
  // Global model-name substitution: changes resolved cells (a routes-key-only
  // rename would be vacuous — the snapshot stores resolved model names).
  const cfg = fs.readFileSync(cfgPath, 'utf8');
  if (!cfg.includes('gemma4:e4b')) {
    console.error('  ✗ fixture precondition: config no longer contains gemma4:e4b — pick a new substitution target');
    failed++;
  } else {
    fs.writeFileSync(cfgPath, cfg.split('gemma4:e4b').join('gemma4:e5b'));
    const res = runUpdate(tmp);
    const after = fs.readFileSync(testPath, 'utf8');
    const today = new Date().toISOString().slice(0, 10);
    assert('exit 0', res.status === 0, `status=${res.status} stderr=${res.stderr.slice(0, 200)}`);
    assert('stdout reports "Snapshot updated."', /Snapshot updated\./.test(res.stdout), `stdout=${res.stdout.slice(0, 200)}`);
    assert('snapshot now contains gemma4:e5b', after.includes('gemma4:e5b'));
    assert(`"Last updated:" moved to today (${today})`, after.includes(`// Last updated: ${today}`));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 3. Corrupted anchor: loud exit 1, never a silent no-op ──────────────────
console.log('\n3. Corrupted snapshot terminator → loud exit 1');
{
  const tmp = makeFixture();
  const testPath = path.join(tmp, 'test', 'model-map-lineage.test.js');
  const before = fs.readFileSync(testPath, 'utf8');
  // Indent the snapshot's column-0 terminating `};` — the anchor regex
  // requires it at column 0, so --update must refuse, not pretend success.
  const corrupted = before.replace(/\n\};/, '\n  };');
  if (corrupted === before) {
    console.error('  ✗ fixture precondition: could not corrupt snapshot terminator');
    failed++;
  } else {
    fs.writeFileSync(testPath, corrupted);
    const res = runUpdate(tmp);
    assert('exit 1', res.status === 1, `status=${res.status}`);
    assert('stderr contains "snapshot block not found"', /snapshot block not found/.test(res.stderr), `stderr=${res.stderr.slice(0, 200)}`);
    assert('stdout does NOT claim "Snapshot updated."', !/Snapshot updated\./.test(res.stdout));
    assert('corrupted file left as-is (no partial write)', fs.readFileSync(testPath, 'utf8') === corrupted);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
