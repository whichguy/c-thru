#!/usr/bin/env node
'use strict';
// Integration tests for proxy startup, /ping, /v1/models, shutdown, and 404 paths.
// Run with: node test/proxy-lifecycle.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { assert, summary, writeConfig, spawnProxy, waitForPing, httpJson, withProxy, getFreePort } = require('./helpers');

console.log('proxy-lifecycle integration tests\n');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-lifecycle-'));
  const configPath = writeConfig(tmpDir, {});

  // ── Test 1: Spawns + /ping returns 200 ──────────────────────────────────
  console.log('1. Spawns and /ping returns ok');
  await withProxy({ configPath }, async ({ port, child }) => {
    const r = await httpJson(port, 'GET', '/ping');
    assert(r.status === 200, '/ping status 200');
    assert(r.json && r.json.ok === true, '/ping json.ok === true');
    assert(r.json.pid === child.pid, '/ping json.pid matches child.pid');
    assert(typeof r.json.config_path === 'string', '/ping json.config_path is string');
    assert(r.json.config_path === fs.realpathSync(configPath), '/ping json.config_path matches --config arg');
  });

  // ── Test 2: config_source === 'override' when using --config flag ────────
  console.log('\n2. config_source is override when using --config flag');
  await withProxy({ configPath }, async ({ port }) => {
    const r = await httpJson(port, 'GET', '/ping');
    assert(r.json && r.json.config_source === 'override', '/ping config_source === override');
  });

  // ── Test 3: /v1/models returns valid JSON ────────────────────────────────
  console.log('\n3. /v1/models returns valid JSON array');
  await withProxy({ configPath }, async ({ port }) => {
    const r = await httpJson(port, 'GET', '/v1/models');
    assert(r.status === 200, '/v1/models status 200');
    assert(r.json && Array.isArray(r.json.data), '/v1/models json.data is array');
  });

  // ── Test 4: SIGTERM causes clean exit ────────────────────────────────────
  console.log('\n4. SIGTERM causes clean exit within 2s');
  {
    const hooksPort = await getFreePort();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-home-'));
    try {
      const { child, port } = await spawnProxy({ configPath, hooksPort, tmpHome });
      await waitForPing(port);
      const exitPromise = new Promise(r => child.on('exit', r));
      child.kill('SIGTERM');
      const code = await Promise.race([
        exitPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('SIGTERM timeout')), 2000)),
      ]);
      assert(code === 0, 'proxy exits with code 0 on SIGTERM');
    } finally {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  }

  // ── Test 5: Unknown path → 404 ────────────────────────────────────────────
  console.log('\n5. Unknown path returns 404');
  await withProxy({ configPath }, async ({ port }) => {
    const r = await httpJson(port, 'GET', '/does-not-exist');
    assert(r.status === 404, 'GET /does-not-exist returns 404');
  });

  // ── Test 6: Hooks /ping returns {ok:true, role:'hooks'} ─────────────────
  console.log('\n6. Hooks listener /ping returns role=hooks');
  await withProxy({ configPath }, async ({ hooksPort }) => {
    const r = await httpJson(hooksPort, 'GET', '/ping');
    assert(r.status === 200, 'hooks /ping status 200');
    assert(r.json && r.json.ok === true, 'hooks /ping ok === true');
    assert(r.json && r.json.role === 'hooks', 'hooks /ping role === hooks');
  });

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
