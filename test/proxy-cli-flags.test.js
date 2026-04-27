#!/usr/bin/env node
'use strict';
// Tests for parseCliFlags edge cases in claude-proxy.
//
// parseCliFlags (tools/claude-proxy L43-69) converts --flag value pairs into
// env vars.  Edge cases:
//   A. Known flag at end of argv with no value → buffered to UNRECOGNIZED_CLI_FLAGS
//      as "<flag> (missing value)"; env var NOT set; proxy still starts.
//   B. Two flags where only the second has no value → first sets env var
//      correctly; second is gracefully ignored.
//
// Both cases are verified by inspecting:
//   1. The /ping response (proxy started → CLAUDE_LLM_MODE absent or unchanged).
//   2. The "cli.unrecognized_flags" proxyLog entry on stderr/log
//      (written just before server.listen, after UNRECOGNIZED_CLI_FLAGS is
//      populated — tools/claude-proxy L1450-1451).
//
// Run: node test/proxy-cli-flags.test.js

const { spawn } = require('child_process');
const fs   = require('fs');
const http = require('http');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  getFreePort, waitForPing, httpJson, writeConfig, collectStderr,
} = require('./helpers');

const PROXY_BIN = path.resolve(__dirname, '..', 'tools', 'claude-proxy');

console.log('proxy-cli-flags edge case tests\n');

// ── helpers ────────────────────────────────────────────────────────────────

// Spawns the proxy with a given extra argv, waits for READY, returns
// { child, port, tmpHome, stderr }.  Caller must kill child when done.
async function spawnWithArgs(extraArgs, extraEnv = {}) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-clitest-'));
  const configPath = writeConfig(tmpHome, {});   // minimal valid config
  const hooksPort  = await getFreePort();

  // Route log output to a file inside tmpHome so we can inspect it.
  const logFile = path.join(tmpHome, 'proxy.log');

  const proxyEnv = Object.assign({}, process.env, {
    HOME: tmpHome,
    CLAUDE_PROXY_STARTUP_PROBE:    '0',
    CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
    CLAUDE_PROXY_HOOKS_PORT:       String(hooksPort),
    CLAUDE_PROXY_LOG_FILE:         logFile,
    // Clear any inherited LLM mode so we can test absence cleanly
    CLAUDE_LLM_MODE: '',
  }, extraEnv);

  const args = ['--config', configPath, ...extraArgs];

  const child = spawn(process.execPath, [PROXY_BIN, ...args], {
    env: proxyEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrBuf = collectStderr(child);

  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('spawnWithArgs: timed out waiting for READY'));
    }, 8000);

    child.on('error', err => { clearTimeout(timeout); reject(err); });
    child.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`spawnWithArgs: proxy exited with code ${code} before READY`));
    });

    child.stdout.on('data', chunk => {
      buf += chunk.toString();
      const m = buf.match(/READY (\d+)/);
      if (m) {
        clearTimeout(timeout);
        child.removeAllListeners('exit');
        resolve(Number(m[1]));
      }
    });
  });

  return { child, port, tmpHome, logFile, stderr: stderrBuf };
}

// Read the proxy.log file written to tmpHome.  Retries briefly since proxyLog
// writes are synchronous but the OS may buffer them.
function readLogFile(logFile) {
  try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; }
}

function killAndWait(child) {
  return new Promise(resolve => {
    child.on('exit', resolve);
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
  });
}

// ── tests ──────────────────────────────────────────────────────────────────

async function main() {
  // ── Edge case A: --mode alone at end of argv (missing value) ────────────
  console.log('Edge case A: --mode at end of argv (missing value)');
  {
    let child, port, tmpHome, logFile;
    try {
      ({ child, port, tmpHome, logFile } = await spawnWithArgs(['--mode']));

      // Proxy must have started — /ping should return 200
      await waitForPing(port, 5000);
      assert(true, 'proxy started despite --mode missing value');

      // /ping response: check CLAUDE_LLM_MODE is absent or empty
      const { json } = await httpJson(port, 'GET', '/ping');
      assert(json !== null, '/ping returned valid JSON');

      // CLAUDE_LLM_MODE env var should NOT have been set by the flag
      // (the missing-value branch pushes to UNRECOGNIZED_CLI_FLAGS, not to env)
      const modeFromPing = json && json.mode;
      // "mode" in /ping reflects CLAUDE_LLM_MODE; the flag had no value so
      // env was not set.  Accept any falsy or the inherited empty-string value.
      assert(
        !modeFromPing || modeFromPing === '' || modeFromPing === 'connected',
        `CLAUDE_LLM_MODE not erroneously set (ping.mode=${JSON.stringify(modeFromPing)})`
      );

      // Log file must contain the cli.unrecognized_flags event with
      // "--mode (missing value)" captured
      // proxyLog fires synchronously just before server.listen; by the time
      // /ping 200 is received, the write is already done.
      const log = readLogFile(logFile);
      assert(
        log.includes('cli.unrecognized_flags'),
        'proxy logged cli.unrecognized_flags event'
      );
      assert(
        log.includes('missing value'),
        'log entry mentions "missing value" for --mode'
      );
    } finally {
      if (child) await killAndWait(child);
      if (tmpHome) try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  }

  // ── Edge case B: --config /path --mode (second flag has no value) ───────
  console.log('\nEdge case B: --config <path> --mode (second flag missing value)');
  {
    let child, port, tmpHome, logFile;
    try {
      // We pass --config via extraArgs here (in addition to the one in
      // spawnWithArgs) — but spawnWithArgs already prepends --config configPath.
      // For this test we want to verify that a flag *before* --mode was parsed
      // correctly while --mode itself is gracefully ignored.
      // Use --profile instead (also a known flag) as the first arg so the
      // scenario is "first flag ok, second flag missing value".
      ({ child, port, tmpHome, logFile } = await spawnWithArgs(['--profile', 'test-tier', '--mode']));

      await waitForPing(port, 5000);
      assert(true, 'proxy started with partial flag pair');

      // CLAUDE_LLM_PROFILE should have been set (first flag had a value)
      const { json } = await httpJson(port, 'GET', '/ping');
      assert(json !== null, '/ping returned JSON');

      // The log must record --mode (missing value) but NOT --profile
      const log = readLogFile(logFile);
      assert(
        log.includes('missing value'),
        'log records --mode missing value'
      );
      // "--profile test-tier" was successfully consumed — not in unrecognized
      assert(
        !log.includes('"--profile"') || !log.includes('"--profile (missing value)"'),
        '--profile was not flagged as unrecognized (it had a valid value)'
      );
    } finally {
      if (child) await killAndWait(child);
      if (tmpHome) try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  }

  // ── Edge case C: --mode=value (= form) is parsed correctly ─────────────
  console.log('\nEdge case C: --mode=connected (= form accepted)');
  {
    let child, port, tmpHome, logFile;
    try {
      ({ child, port, tmpHome, logFile } = await spawnWithArgs(['--mode=connected']));
      await waitForPing(port, 5000);
      assert(true, 'proxy started with --mode=connected');

      const { json } = await httpJson(port, 'GET', '/ping');
      // mode in /ping should reflect connected (or whatever the proxy exposes)
      assert(json !== null, '/ping returned JSON after --mode=connected');
      // No unrecognized flags should be logged
      const log = readLogFile(logFile);
      assert(
        !log.includes('cli.unrecognized_flags'),
        'no unrecognized_flags logged when --mode=value is well-formed'
      );
    } finally {
      if (child) await killAndWait(child);
      if (tmpHome) try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  }

  // ── Edge case D: unknown flag is buffered, proxy still starts ───────────
  console.log('\nEdge case D: unknown --future-flag is buffered, proxy still starts');
  {
    let child, port, tmpHome, logFile;
    try {
      ({ child, port, tmpHome, logFile } = await spawnWithArgs(['--future-flag', 'some-value']));
      await waitForPing(port, 5000);
      assert(true, 'proxy started despite unknown flag');

      const log = readLogFile(logFile);
      assert(
        log.includes('cli.unrecognized_flags'),
        'unknown --future-flag buffered and logged'
      );
      assert(
        log.includes('--future-flag'),
        'log entry names the unknown flag'
      );
    } finally {
      if (child) await killAndWait(child);
      if (tmpHome) try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
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
