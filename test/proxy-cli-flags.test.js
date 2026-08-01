#!/usr/bin/env node
'use strict';
// Tests for parseCliFlags edge cases in claude-proxy.
//
// parseCliFlags converts --flag value pairs into
// env vars.  Edge cases:
//   A. Known flag at end of argv with no value → buffered to UNRECOGNIZED_CLI_FLAGS
//      as "<flag> (missing value)"; inherited env remains unchanged; proxy starts.
//   B. Two flags where only the second has no value → first sets env var
//      correctly; second is gracefully ignored.
//
// Both cases are verified by inspecting:
//   1. The /ping response (proxy started and active mode/tier reflect CLI parsing).
//   2. The "cli.unrecognized_flags" proxyLog entry on stderr/log
//      (written before server.listen after UNRECOGNIZED_CLI_FLAGS is populated).
//
// Run: node test/proxy-cli-flags.test.js

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const {
  assert, assertEq, summary,
  makeIsolatedTmpDir, getFreePort, httpJson, writeConfig, collectStderr,
  DEFAULT_HERMETIC_READY_TIMEOUT_MS,
  terminateAndReap, boundedDiagnosticSnippet,
} = require('./helpers');

const PROXY_BIN = path.resolve(__dirname, '..', 'tools', 'claude-proxy');

console.log('proxy-cli-flags edge case tests\n');

// ── helpers ────────────────────────────────────────────────────────────────

// Spawns the proxy with a given extra argv, waits for READY, returns
// { child, port, tmpHome, stderr }.  Caller must kill child when done.
async function spawnWithArgs(extraArgs, extraEnv = {}) {
  const tmpHome = makeIsolatedTmpDir('c-thru-clitest-');
  const profileDir = path.join(tmpHome, '.claude');
  fs.mkdirSync(profileDir, { recursive: true });
  const configPath = writeConfig(tmpHome, {});   // minimal valid config
  const hooksPort  = await getFreePort();

  // Route log output to a file inside tmpHome so we can inspect it.
  const logFile = path.join(tmpHome, 'proxy.log');

  const proxyEnv = Object.assign({}, process.env, {
    HOME: tmpHome,
    CLAUDE_PROFILE_DIR:             profileDir,
    CLAUDE_CONFIG_DIR:              profileDir,
    CLAUDE_DIR:                     profileDir,
    CLAUDE_MODEL_MAP_LAUNCH_CWD:    tmpHome,
    CLAUDE_PROXY_BIND:              '127.0.0.1',
    CLAUDE_PROXY_PORT:              '',
    CLAUDE_PROXY_PID_FILE:          path.join(profileDir, 'proxy.pid'),
    CLAUDE_PROXY_USAGE_STATS_FILE:  path.join(profileDir, 'usage-stats.json'),
    CLAUDE_PROXY_CONTROL_TOKEN_FILE: path.join(profileDir, 'proxy.control-token'),
    CLAUDE_PROXY_STARTUP_PROBE:    '0',
    CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
    CLAUDE_PROXY_HOOKS_PORT:       String(hooksPort),
    CLAUDE_PROXY_LOG_FILE:         logFile,
    // Clear inherited routing state so each CLI case controls its own inputs.
    CLAUDE_LLM_MODE: '',
    CLAUDE_LLM_PROFILE: '',
    CLAUDE_CONNECTIVITY_MODE: '',
    CLAUDE_LLM_CONNECTIVITY_MODE: '',
  }, extraEnv);

  const args = ['--config', configPath, ...extraArgs];
  const readyDeadline = Date.now() + DEFAULT_HERMETIC_READY_TIMEOUT_MS;

  const child = spawn(process.execPath, [PROXY_BIN, ...args], {
    env: proxyEnv,
    cwd: tmpHome,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrBuf = collectStderr(child);

  try {
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      let settled = false;
      let timeout;

      const cleanup = () => {
        clearTimeout(timeout);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        child.stdout.removeListener('data', onData);
      };
      const rejectReady = error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      function onError(err) {
        rejectReady(new Error(`spawnWithArgs: spawn failed: ${err.message}`));
      }
      function onExit(code, signal) {
        rejectReady(new Error(
          `spawnWithArgs: proxy exited with code ${code} signal ${signal || 'none'} before READY; ` +
          `stderr=${JSON.stringify(boundedDiagnosticSnippet(stderrBuf.get(), 500))}`
        ));
      }
      function onData(chunk) {
        buf += chunk.toString();
        const m = buf.match(/READY (\d+)/);
        if (!m || settled) return;
        settled = true;
        cleanup();
        resolve(Number(m[1]));
      }

      timeout = setTimeout(() => {
        rejectReady(new Error(
          `spawnWithArgs: timed out waiting for READY; ` +
          `stderr=${JSON.stringify(boundedDiagnosticSnippet(stderrBuf.get(), 500))}`
        ));
      }, Math.max(1, readyDeadline - Date.now()));
      child.once('error', onError);
      child.once('exit', onExit);
      child.stdout.on('data', onData);
    });

    return {
      child,
      port,
      tmpHome,
      logFile,
      stderr: stderrBuf,
      readyDeadline,
      exitPromise: observeChildExit(child),
    };
  } catch (error) {
    try {
      await terminateAndReap(child);
    } finally {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
    throw error;
  }
}

function observeChildExit(child) {
  const exitInfo = () => ({ code: child.exitCode, signal: child.signalCode });
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(exitInfo());
  }
  return new Promise(resolve => {
    const onExit = (code, signal) => resolve({ code, signal });
    child.once('exit', onExit);
    // Close the exit-between-check-and-listener race.
    if (child.exitCode !== null || child.signalCode !== null) {
      child.removeListener('exit', onExit);
      resolve(exitInfo());
    }
  });
}

async function readStartupPing(proxy) {
  const remainingMs = proxy.readyDeadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error('spawnWithArgs: shared readiness deadline expired before /ping');
  }
  const exitedBeforePing = proxy.exitPromise.then(({ code, signal }) => {
    throw new Error(`proxy exited with code ${code} signal ${signal || 'none'} after READY`);
  });
  try {
    // READY is emitted by server.listen's callback, so retry polling is both
    // redundant and harmful here: short per-attempt timeouts can create a
    // connection-reset retry storm on a loaded host. Use one request with the
    // whole remaining readiness budget instead.
    return await Promise.race([
      httpJson(proxy.port, 'GET', '/ping', null, {}, remainingMs),
      exitedBeforePing,
    ]);
  } catch (error) {
    const childState = proxy.child.exitCode !== null || proxy.child.signalCode !== null
      ? `exited(code=${proxy.child.exitCode}, signal=${proxy.child.signalCode || 'none'})`
      : 'running';
    throw new Error(
      `startup /ping failed: ${error.message}; child=${childState}; ` +
      `stderr=${JSON.stringify(boundedDiagnosticSnippet(proxy.stderr.get(), 500))}; ` +
      `proxy_log=${JSON.stringify(boundedDiagnosticSnippet(readLogFile(proxy.logFile), 500))}`,
      { cause: error },
    );
  }
}

// Read the proxy.log file written to tmpHome.  Retries briefly since proxyLog
// writes are synchronous but the OS may buffer them.
function readLogFile(logFile) {
  try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; }
}

// ── tests ──────────────────────────────────────────────────────────────────

async function main() {
  // ── Edge case A: --mode alone at end of argv (missing value) ────────────
  console.log('Edge case A: --mode at end of argv (missing value)');
  {
    let proxy;
    try {
      proxy = await spawnWithArgs(
        ['--mode'],
        { CLAUDE_LLM_MODE: 'best-local-oss' },
      );

      // Proxy must have started — /ping should return 200.
      const { status, json } = await readStartupPing(proxy);
      assertEq(status, 200, 'proxy started despite --mode missing value');
      assert(json !== null, '/ping returned valid JSON');

      // Missing --mode must preserve the inherited baseline. /ping exposes
      // this as active_mode (there is no legacy "mode" response property).
      assertEq(
        json && json.active_mode,
        'best-local-oss',
        'missing --mode did not overwrite CLAUDE_LLM_MODE',
      );

      // Log file must contain the cli.unrecognized_flags event with
      // "--mode (missing value)" captured
      // proxyLog fires synchronously just before server.listen; by the time
      // /ping 200 is received, the write is already done.
      const log = readLogFile(proxy.logFile);
      assert(
        log.includes('cli.unrecognized_flags'),
        'proxy logged cli.unrecognized_flags event'
      );
      assert(
        log.includes('missing value'),
        'log entry mentions "missing value" for --mode'
      );
    } finally {
      if (proxy && proxy.child) await terminateAndReap(proxy.child);
      if (proxy && proxy.tmpHome) {
        try { fs.rmSync(proxy.tmpHome, { recursive: true, force: true }); } catch {}
      }
    }
  }

  // ── Edge case B: --profile <tier> --mode (second flag has no value) ─────
  console.log('\nEdge case B: --profile <tier> --mode (second flag missing value)');
  {
    let proxy;
    try {
      // For this test we want to verify that a flag *before* --mode was parsed
      // correctly while --mode itself is gracefully ignored.
      proxy = await spawnWithArgs(['--profile', '32gb', '--mode']);

      const { status, json } = await readStartupPing(proxy);
      assertEq(status, 200, 'proxy started with partial flag pair');
      assert(json !== null, '/ping returned JSON');
      assertEq(
        json && json.active_tier,
        '32gb',
        '--profile value reached CLAUDE_LLM_PROFILE',
      );

      // The log must record --mode (missing value) but NOT --profile
      const log = readLogFile(proxy.logFile);
      assert(
        log.includes('missing value'),
        'log records --mode missing value'
      );
      // "--profile 32gb" was successfully consumed — not in unrecognized.
      assert(
        !log.includes('--profile (missing value)'),
        '--profile was not flagged as unrecognized (it had a valid value)'
      );
    } finally {
      if (proxy && proxy.child) await terminateAndReap(proxy.child);
      if (proxy && proxy.tmpHome) {
        try { fs.rmSync(proxy.tmpHome, { recursive: true, force: true }); } catch {}
      }
    }
  }

  // ── Edge case C: --mode=value (= form) is parsed correctly ─────────────
  console.log('\nEdge case C: --mode=connected (= form accepted)');
  {
    let proxy;
    try {
      proxy = await spawnWithArgs(['--mode=connected']);
      const { status, json } = await readStartupPing(proxy);
      assertEq(status, 200, 'proxy started with --mode=connected');
      assert(json !== null, '/ping returned JSON after --mode=connected');
      assertEq(
        json && json.active_mode,
        'best-cloud-oss',
        '--mode=connected reached CLAUDE_LLM_MODE and was normalized',
      );
      // No unrecognized flags should be logged
      const log = readLogFile(proxy.logFile);
      assert(
        !log.includes('cli.unrecognized_flags'),
        'no unrecognized_flags logged when --mode=value is well-formed'
      );
    } finally {
      if (proxy && proxy.child) await terminateAndReap(proxy.child);
      if (proxy && proxy.tmpHome) {
        try { fs.rmSync(proxy.tmpHome, { recursive: true, force: true }); } catch {}
      }
    }
  }

  // ── Edge case D: unknown flag is buffered, proxy still starts ───────────
  console.log('\nEdge case D: unknown --future-flag is buffered, proxy still starts');
  {
    let proxy;
    try {
      proxy = await spawnWithArgs(['--future-flag', 'some-value']);
      const { status } = await readStartupPing(proxy);
      assertEq(status, 200, 'proxy started despite unknown flag');

      const log = readLogFile(proxy.logFile);
      assert(
        log.includes('cli.unrecognized_flags'),
        'unknown --future-flag buffered and logged'
      );
      assert(
        log.includes('--future-flag'),
        'log entry names the unknown flag'
      );
    } finally {
      if (proxy && proxy.child) await terminateAndReap(proxy.child);
      if (proxy && proxy.tmpHome) {
        try { fs.rmSync(proxy.tmpHome, { recursive: true, force: true }); } catch {}
      }
    }
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

process.on('unhandledRejection', err => {
  console.error('unhandledRejection:', err);
  process.exit(1);
});

main().catch(err => {
  console.error(err);
  process.exit(1);
});
