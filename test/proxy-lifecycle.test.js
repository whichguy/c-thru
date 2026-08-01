#!/usr/bin/env node
'use strict';
// Integration tests for proxy startup, /ping, /v1/models, shutdown, and 404 paths.
// Run with: node test/proxy-lifecycle.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { assert, summary, writeConfig, spawnProxy, waitForPing, httpJson, withProxy, getFreePort } = require('./helpers');

// Manual lifecycle phases intentionally own their proxy process instead of
// using withProxy(). READY means the listener was created, but a loaded machine
// can still need several seconds before /ping is stable. Keep this local to the
// hermetic lifecycle suite; it is not a model-generation timeout.
const MANUAL_READY_TIMEOUT_MS = 15_000;
const CHILD_EXIT_TIMEOUT_MS = 3_000;
const SIGNAL_ASSERT_TIMEOUT_MS = 2_000;

function waitForChildExit(child, label, timeoutMs = CHILD_EXIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    let timer;
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
    timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error(`${label}: child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

async function ensureChildStopped(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    const exit = waitForChildExit(child, `${label} SIGTERM cleanup`);
    child.kill('SIGTERM');
    await exit;
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = waitForChildExit(child, `${label} SIGKILL cleanup`).catch(() => null);
    child.kill('SIGKILL');
    await exit;
  }
}

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
    let child = null;
    try {
      let port;
      ({ child, port } = await spawnProxy({ configPath, hooksPort, tmpHome }));
      await waitForPing(port, MANUAL_READY_TIMEOUT_MS);
      const exitPromise = waitForChildExit(child, 'SIGTERM', SIGNAL_ASSERT_TIMEOUT_MS);
      child.kill('SIGTERM');
      const exited = await exitPromise;
      assert(exited.code === 0 && exited.signal === null,
        'proxy exits with code 0 and no signal on SIGTERM');
    } finally {
      await ensureChildStopped(child, 'SIGTERM phase proxy');
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
    let p1 = null;
    let p2 = null;
    try {
      const spawnResults = await Promise.allSettled([
        spawnProxy({ configPath, hooksPort: hooksPort1, tmpHome: tmpHome1 }),
        spawnProxy({ configPath, hooksPort: hooksPort2, tmpHome: tmpHome2 }),
      ]);
      if (spawnResults[0].status === 'fulfilled') p1 = spawnResults[0].value;
      if (spawnResults[1].status === 'fulfilled') p2 = spawnResults[1].value;
      const rejectedSpawn = spawnResults.find(result => result.status === 'rejected');
      if (rejectedSpawn) throw rejectedSpawn.reason;
      assert(p1.port !== p2.port, `two concurrent proxies get distinct ports (${p1.port} vs ${p2.port})`);
      assert(p1.port > 0, 'first proxy port is non-zero');
      assert(p2.port > 0, 'second proxy port is non-zero');
      const exits = [
        waitForChildExit(p1.child, 'concurrent proxy 1 SIGTERM'),
        waitForChildExit(p2.child, 'concurrent proxy 2 SIGTERM'),
      ];
      p1.child.kill('SIGTERM');
      p2.child.kill('SIGTERM');
      const [exit1, exit2] = await Promise.all(exits);
      assert(
        exit1.code === 0 && exit1.signal === null &&
          exit2.code === 0 && exit2.signal === null,
        'both concurrent proxies finish cleanly before the next lifecycle phase',
      );
    } finally {
      await Promise.all([
        ensureChildStopped(p1 && p1.child, 'concurrent proxy 1'),
        ensureChildStopped(p2 && p2.child, 'concurrent proxy 2'),
      ]);
      try { fs.rmSync(tmpHome1, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(tmpHome2, { recursive: true, force: true }); } catch {}
    }
  }

  // ── Test 9: proxy is not daemonized — exits when spawner kills it ────────
  console.log('\n9. Proxy exits promptly on SIGKILL (not daemonized)');
  {
    const hooksPort = await getFreePort();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-home-'));
    let child = null;
    try {
      let port;
      ({ child, port } = await spawnProxy({ configPath, hooksPort, tmpHome }));
      await waitForPing(port, MANUAL_READY_TIMEOUT_MS);
      const exitPromise = waitForChildExit(child, 'SIGKILL', SIGNAL_ASSERT_TIMEOUT_MS);
      child.kill('SIGKILL');
      const exited = await exitPromise;
      assert(exited.code === null && exited.signal === 'SIGKILL',
        'proxy exits by SIGKILL with no exit code (not daemonized)');
    } finally {
      await ensureChildStopped(child, 'SIGKILL phase proxy');
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
