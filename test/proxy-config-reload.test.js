#!/usr/bin/env node
'use strict';
// Integration tests for proxy config hot-reload (fs.watch + SIGHUP).
// Run with: node test/proxy-config-reload.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { assert, summary, writeConfig, httpJson, withProxy, assertLogContains, collectStderr } = require('./helpers');

console.log('proxy-config-reload integration tests\n');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-reload-'));

  // ── Test 1: Write new config → proxy hot-reloads ────────────────────────
  console.log('1. Writing new config triggers hot-reload via fs.watch');
  {
    const configPath = writeConfig(tmpDir, {});
    await withProxy({ configPath }, async ({ port, child }) => {
      const stderr = collectStderr(child);

      // Write updated config (adding a route)
      const updated = { routes: { 'test-route': 'test-target' } };
      fs.writeFileSync(configPath, JSON.stringify(updated));

      // 50ms debounce + margin
      await sleep(300);

      // Proxy still alive and /ping works
      const r = await httpJson(port, 'GET', '/ping');
      assert(r.status === 200, '/ping still 200 after config write');
      assert(r.json && r.json.ok === true, '/ping ok still true after config write');

      // Confirm reload log line appeared
      assertLogContains(stderr.get(), /reloaded config/, 'stderr contains "reloaded config" after write');
    });
  }

  // ── Test 2: Writing invalid JSON → proxy keeps old config ───────────────
  console.log('\n2. Writing invalid JSON leaves proxy running on old config');
  {
    const configPath = writeConfig(tmpDir, {});
    await withProxy({ configPath }, async ({ port, child }) => {
      const stderr = collectStderr(child);

      fs.writeFileSync(configPath, '{ not valid json }}}');
      await sleep(300);

      // Proxy still alive
      const r = await httpJson(port, 'GET', '/ping');
      assert(r.status === 200, '/ping still 200 after bad config write');

      // Confirm reload-failure log line appeared
      assertLogContains(stderr.get(), /reload failed|invalid|parse/i, 'stderr contains reload-failure message');
    });
  }

  // ── Test 3: SIGHUP triggers config reload ────────────────────────────────
  console.log('\n3. SIGHUP triggers config reload');
  {
    const configPath = writeConfig(tmpDir, {});
    await withProxy({ configPath }, async ({ port, child }) => {
      const stderr = collectStderr(child);

      const updated = { routes: { 'sighup-route': 'sighup-target' } };
      fs.writeFileSync(configPath, JSON.stringify(updated));

      child.kill('SIGHUP');
      await sleep(200);

      const r = await httpJson(port, 'GET', '/ping');
      assert(r.status === 200, '/ping still 200 after SIGHUP');
      assertLogContains(stderr.get(), /reloaded|SIGHUP/i, 'stderr contains reload message after SIGHUP');
    });
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
