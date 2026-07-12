#!/usr/bin/env node
'use strict';
// Round-5 Phase B1 regression: proxy.pid must land in $CLAUDE_PROFILE_DIR,
// matching every reader (c-thru cmd_reload/cmd_restart, c-thru-lib.sh all
// read $CLAUDE_PROFILE_DIR/proxy.pid). Pre-fix the proxy hardcoded
// ~/.claude/proxy.pid — the only path constant with no profile-dir/env
// override — so reload/restart couldn't find the proxy under ephemeral or
// named profiles, and concurrent proxies clobbered (and on exit deleted)
// one another's pid file.
//
// Run: node test/proxy-pid-file-profile.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const {
  assert, assertEq, summary,
  writeConfig, spawnProxy, waitForPing,
} = require('./helpers');

console.log('proxy pid-file profile-dir tests\n');

const MINIMAL_CFG = {
  endpoints: { anthropic: { kind: 'anthropic', format: 'anthropic', url: 'http://127.0.0.1:1', auth: 'none' } },
};

function waitForExit(child) {
  return new Promise(r => child.on('exit', r));
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-pidfile-'));
  try {
    const configPath = writeConfig(tmpDir, MINIMAL_CFG);

    // ── 1. CLAUDE_PROFILE_DIR set -> pid file lands there, not in $HOME ─────
    console.log('1. CLAUDE_PROFILE_DIR set: pid file in profile dir, removed on SIGTERM');
    {
      const profDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-pidfile-prof-'));
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-pidfile-home-'));
      fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
      try {
        const { child, port } = await spawnProxy({
          configPath, tmpHome,
          env: { CLAUDE_PROFILE_DIR: profDir },
        });
        try {
          await waitForPing(port);
          const profPid = path.join(profDir, 'proxy.pid');
          const homePid = path.join(tmpHome, '.claude', 'proxy.pid');
          assert(fs.existsSync(profPid), 'proxy.pid written to $CLAUDE_PROFILE_DIR');
          assert(!fs.existsSync(homePid), 'proxy.pid NOT written to $HOME/.claude when profile dir is set');
          assertEq(fs.readFileSync(profPid, 'utf8').trim(), String(child.pid), 'pid file contains the proxy pid');

          // cleanupPidFile path: SIGTERM removes the pid file from the SAME dir.
          child.kill('SIGTERM');
          await waitForExit(child);
          assert(!fs.existsSync(profPid), 'pid file removed from profile dir on SIGTERM');
        } finally {
          try { child.kill('SIGKILL'); } catch {}
        }
      } finally {
        fs.rmSync(profDir, { recursive: true, force: true });
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    }

    // ── 2. No CLAUDE_PROFILE_DIR -> unchanged default $HOME/.claude ─────────
    console.log('\n2. No CLAUDE_PROFILE_DIR: default $HOME/.claude/proxy.pid unchanged');
    {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-pidfile-home2-'));
      fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
      try {
        const { child, port } = await spawnProxy({ configPath, tmpHome });
        try {
          await waitForPing(port);
          const homePid = path.join(tmpHome, '.claude', 'proxy.pid');
          assert(fs.existsSync(homePid), 'proxy.pid defaults to $HOME/.claude without a profile dir');
          child.kill('SIGTERM');
          await waitForExit(child);
          assert(!fs.existsSync(homePid), 'default-path pid file removed on SIGTERM');
        } finally {
          try { child.kill('SIGKILL'); } catch {}
        }
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    }

    // ── 3. Explicit CLAUDE_PROXY_PID_FILE wins over both ────────────────────
    console.log('\n3. CLAUDE_PROXY_PID_FILE override wins');
    {
      const profDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-pidfile-prof3-'));
      const pidOverride = path.join(profDir, 'custom.pid');
      try {
        const { child, port } = await spawnProxy({
          configPath,
          env: { CLAUDE_PROFILE_DIR: profDir, CLAUDE_PROXY_PID_FILE: pidOverride },
        });
        try {
          await waitForPing(port);
          assert(fs.existsSync(pidOverride), 'explicit CLAUDE_PROXY_PID_FILE path used');
          assert(!fs.existsSync(path.join(profDir, 'proxy.pid')), 'profile-dir default skipped when override set');
          child.kill('SIGTERM');
          await waitForExit(child);
          assert(!fs.existsSync(pidOverride), 'override pid file removed on SIGTERM');
        } finally {
          try { child.kill('SIGKILL'); } catch {}
        }
      } finally {
        fs.rmSync(profDir, { recursive: true, force: true });
      }
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
