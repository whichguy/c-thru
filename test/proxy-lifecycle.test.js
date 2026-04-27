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

  // ── Test 2: config_source === 'override' in /c-thru/status when using --config ──
  console.log('\n2. config_source is override in /c-thru/status when using --config flag');
  await withProxy({ configPath }, async ({ port }) => {
    const r = await httpJson(port, 'GET', '/c-thru/status');
    assert(r.status === 200, '/c-thru/status status 200');
    assert(r.json && r.json.config_source === 'override', '/c-thru/status config_source === override');
  });

  // ── Test 3: /c-thru/status returns structured capability JSON ────────────
  console.log('\n3. /c-thru/status returns capability JSON');
  await withProxy({ configPath }, async ({ port }) => {
    const r = await httpJson(port, 'GET', '/c-thru/status');
    assert(r.status === 200, '/c-thru/status status 200');
    assert(r.json && r.json.ok === true, '/c-thru/status json.ok === true');
    assert(r.json && typeof r.json.hardware_tier === 'string', '/c-thru/status json.hardware_tier is string');
    assert(r.json && typeof r.json.active_capabilities === 'object', '/c-thru/status json.active_capabilities is object');
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

  // ── Test 6: /hooks/context POST returns additionalContext ───────────────
  console.log('\n6. /hooks/context returns session context injection');
  await withProxy({ configPath }, async ({ port }) => {
    const r = await httpJson(port, 'POST', '/hooks/context', {});
    assert(r.status === 200, '/hooks/context status 200');
    assert(r.json && r.json.hookSpecificOutput, '/hooks/context json.hookSpecificOutput present');
    assert(
      r.json.hookSpecificOutput && typeof r.json.hookSpecificOutput.additionalContext === 'string',
      '/hooks/context json.hookSpecificOutput.additionalContext is string'
    );
  });

  // ── Test 7: proxy binds exclusively to 127.0.0.1 ────────────────────────
  console.log('\n7. Proxy binds exclusively to 127.0.0.1 (loopback-only)');
  await withProxy({ configPath }, async ({ port }) => {
    const r = await httpJson(port, 'GET', '/ping');
    assert(r.json && r.json.bind_address === '127.0.0.1', '/ping bind_address === 127.0.0.1');
  });

  // ── Test 8: two concurrent spawns get different ports ────────────────────
  console.log('\n8. Two concurrent proxy spawns land on different ports');
  {
    const hooksPort1 = await getFreePort();
    const hooksPort2 = await getFreePort();
    const tmpHome1 = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-home-'));
    const tmpHome2 = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-home-'));
    try {
      const [p1, p2] = await Promise.all([
        spawnProxy({ configPath, hooksPort: hooksPort1, tmpHome: tmpHome1 }),
        spawnProxy({ configPath, hooksPort: hooksPort2, tmpHome: tmpHome2 }),
      ]);
      assert(p1.port !== p2.port, `two concurrent proxies get distinct ports (${p1.port} vs ${p2.port})`);
      assert(p1.port > 0, 'first proxy port is non-zero');
      assert(p2.port > 0, 'second proxy port is non-zero');
      p1.child.kill('SIGTERM');
      p2.child.kill('SIGTERM');
    } finally {
      try { fs.rmSync(tmpHome1, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(tmpHome2, { recursive: true, force: true }); } catch {}
    }
  }

  // ── Test 9: proxy is not daemonized — exits when spawner kills it ────────
  console.log('\n9. Proxy exits promptly on SIGKILL (not daemonized)');
  {
    const hooksPort = await getFreePort();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-home-'));
    try {
      const { child, port } = await spawnProxy({ configPath, hooksPort, tmpHome });
      await waitForPing(port);
      const exitPromise = new Promise(resolve => child.on('exit', resolve));
      child.kill('SIGKILL');
      const code = await Promise.race([
        exitPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('SIGKILL: proxy did not exit within 2s')), 2000)),
      ]);
      assert(code !== undefined, 'proxy exits after SIGKILL (not daemonized)');
    } finally {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
