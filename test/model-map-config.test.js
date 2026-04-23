#!/usr/bin/env node
'use strict';
// Unit tests for tools/model-map-config.js selection behavior.
// Run with: node test/model-map-config.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveSelectedConfigPath } = require('../tools/model-map-config.js');

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

function withSavedEnv(fn) {
  const saved = { ...process.env };
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

console.log('model-map-config tests\n');

withSavedEnv(() => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-map-config-'));
  const homeRoot = path.join(tmpRoot, 'home-root');
  const customProfileDir = path.join(tmpRoot, 'custom-profile');
  const cwd = path.join(homeRoot, 'repo');

  try {
    fs.mkdirSync(path.join(homeRoot, '.claude'), { recursive: true });
    fs.mkdirSync(customProfileDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    const homeProfilePath = path.join(homeRoot, '.claude', 'model-map.json');
    const customProfilePath = path.join(customProfileDir, 'model-map.json');
    fs.writeFileSync(homeProfilePath, JSON.stringify({ marker: 'home-profile' }));
    fs.writeFileSync(customProfilePath, JSON.stringify({ marker: 'custom-profile' }));

    process.env.HOME = homeRoot;
    process.env.CLAUDE_PROFILE_DIR = customProfileDir;
    delete process.env.CLAUDE_MODEL_MAP_PATH;
    delete process.env.CLAUDE_PROJECT_DIR;

    const resolved = resolveSelectedConfigPath({ cwd, syncProfile: false, baseDir: path.join(process.cwd(), 'tools') });

    assert(resolved && resolved.source === 'profile',
      `selector uses profile source when walked home-profile exists (got ${JSON.stringify(resolved)})`);
    assert(resolved && resolved.path === fs.realpathSync(customProfilePath),
      `selector prefers CLAUDE_PROFILE_DIR model-map over walked HOME/.claude path (got ${JSON.stringify(resolved && resolved.path)})`);
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
