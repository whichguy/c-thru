#!/usr/bin/env node
'use strict';
// Tests for armConfigWatcher and related config-reload resilience.
//
// Key behavior under test:
//
//   1. When CONFIG_PATH changes during a watcher-triggered reload (e.g., a
//      project-local config appears), armConfigWatcher is called a second time
//      to re-arm on the new path. The previous bug stored a StatWatcher in
//      configWatchHandle and passed it to fs.unwatchFile() — but fs.unwatchFile
//      requires a filename string, not a StatWatcher, so it threw TypeError, which
//      propagated as an uncaughtException and killed the proxy. Fixed: configWatchHandle
//      now stores the filename; the proxy survives re-arming.
//
//   2. When SIGHUP is received and the config file is unreadable (e.g., EACCES),
//      reloadConfigFromDisk logs "config reload failed" and keeps the old graph.
//
// Run: node test/proxy-config-watcher.test.js

'use strict';

const fs   = require('fs');
const http = require('http');
const os   = require('os');
const path = require('path');

const {
  assert,
  assertEq,
  assertLogContains,
  summary,
  httpJson,
  withProxy,
  spawnProxy,
  waitForPing,
  collectStderr,
} = require('./helpers');

console.log('proxy-config-watcher tests\n');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function minimalConfig(label) {
  return {
    backends: { stub: { kind: 'anthropic', url: 'http://127.0.0.1:1' } },
    model_routes: { [label]: 'stub' },
    llm_profiles: { workhorse: { 'best-cloud': { '16gb': label } } },
  };
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-cw-'));

  // ── Test 1: proxy survives CONFIG_PATH change (watcher re-arm) ──────────────
  //
  // Sequence:
  //   a) Proxy starts, loads profile config from tmpHome/.claude/model-map.json.
  //      armConfigWatcher armed on profile path, configWatchHandle = profile path.
  //   b) We create a project-local config at tmpLaunchCwd/.claude/model-map.json.
  //   c) We touch the profile config (rewrite) to bump its mtime.
  //   d) Watcher polls (≤1007ms), detects mtime change → reloadConfigFromDisk().
  //   e) resolveConfigSelectionForReload: Tier 1 absent (no CLAUDE_MODEL_MAP_PATH),
  //      Tier 2 finds project-local → CONFIG_PATH changes.
  //   f) CONFIG_PATH !== original watchPath → armConfigWatcher(newPath) called.
  //   g) fs.unwatchFile(profilePath) succeeds; fs.watchFile(projectPath) armed.
  //   h) /ping still 200 — no crash (previously this killed the proxy due to
  //      fs.unwatchFile receiving a StatWatcher instead of a filename string).
  console.log('1. proxy survives CONFIG_PATH change; watcher re-arms without crash');
  {
    // Set up home dir with profile config.
    // NOTE: withProxy always creates its own tmpHome so we use spawnProxy directly
    // to supply our own tmpHome that contains the profile config.
    const tmpHome = path.join(tmpRoot, 'home');
    const claudeDir = path.join(tmpHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const profileConfigPath = path.join(claudeDir, 'model-map.json');
    fs.writeFileSync(profileConfigPath, JSON.stringify(minimalConfig('profile-model')));

    // Set up launch-cwd dir (initially no project-local config).
    const tmpLaunchCwd = path.join(tmpRoot, 'launchcwd');
    fs.mkdirSync(tmpLaunchCwd, { recursive: true });

    // Start proxy without --config so it loads from the profile dir.
    // Use spawnProxy directly (not withProxy) to keep HOME = our custom tmpHome.
    const { child, port } = await spawnProxy({
      tmpHome,
      env: {
        CLAUDE_MODEL_MAP_LAUNCH_CWD: tmpLaunchCwd,
        // No CLAUDE_MODEL_MAP_PATH → resolveConfigSelectionForReload uses Tier 2/3.
      },
    });
    const stderr = collectStderr(child);

    try {
      await waitForPing(port);

      // Baseline: proxy up and loaded.
      const ping0 = await httpJson(port, 'GET', '/ping', null);
      assertEq(ping0.status, 200, 'proxy is up after initial load');
      assert(ping0.json?.ok === true, '/ping ok:true on startup');

      // (b) Create project-local config so the next reload resolves a new path.
      const projectClaudeDir = path.join(tmpLaunchCwd, '.claude');
      fs.mkdirSync(projectClaudeDir, { recursive: true });
      const projectConfigPath = path.join(projectClaudeDir, 'model-map.json');
      fs.writeFileSync(projectConfigPath, JSON.stringify(minimalConfig('project-model')));

      // (c) Touch profile config to update mtime → watcher fires on next poll.
      fs.writeFileSync(profileConfigPath, JSON.stringify({ ...minimalConfig('profile-model'), _touch: 1 }));

      // (d) Wait for watchFile interval (1007ms) + margin.
      await sleep(1500);

      // (h) Proxy must still be alive — the previous bug killed it here.
      const ping1 = await httpJson(port, 'GET', '/ping', null);
      assertEq(ping1.status, 200, '/ping 200 after CONFIG_PATH change + watcher re-arm');
      assert(ping1.json?.ok === true, '/ping ok:true after watcher re-arm');

      // Reload must be logged (confirms the watcher actually fired).
      assertLogContains(
        stderr.get(),
        /reloaded config/,
        'stderr contains "reloaded config" confirming watcher-triggered reload',
      );
    } finally {
      try { child.kill('SIGTERM'); } catch {}
      await new Promise(r => { child.once('exit', r); setTimeout(r, 2000); });
    }
  }

  // ── Test 2: proxy survives unreadable config on SIGHUP reload ───────────────
  //
  // When the config file becomes unreadable between reloads, reloadConfigFromDisk
  // catches the EACCES, logs "config reload failed", and keeps the old graph live.
  console.log('\n2. proxy keeps old config graph when SIGHUP config file is unreadable');
  {
    const configPath = path.join(tmpRoot, 'unreadable.json');
    fs.writeFileSync(configPath, JSON.stringify(minimalConfig('readable-model')));

    await withProxy({ configPath, profile: '16gb' }, async ({ port, child }) => {
      const stderr = collectStderr(child);

      const ping0 = await httpJson(port, 'GET', '/ping', null);
      assertEq(ping0.status, 200, 'proxy up with readable config');

      // Revoke read permissions.
      fs.chmodSync(configPath, 0o000);
      try {
        // SIGHUP → reloadConfigFromDisk → readFileSync throws EACCES → logs warning.
        process.kill(child.pid, 'SIGHUP');
        await sleep(200);

        // Proxy must still be alive.
        const ping1 = await httpJson(port, 'GET', '/ping', null);
        assertEq(ping1.status, 200, '/ping 200 after SIGHUP with unreadable config');
        assert(ping1.json?.ok === true, '/ping ok:true after reload failure');

        // Reload failure must be logged (not silently swallowed).
        assertLogContains(
          stderr.get(),
          /config reload failed/,
          'stderr contains "config reload failed" after EACCES on SIGHUP',
        );
      } finally {
        // Restore permissions so withProxy can clean up cleanly.
        try { fs.chmodSync(configPath, 0o644); } catch {}
      }
    });
  }

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
