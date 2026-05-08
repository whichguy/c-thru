#!/usr/bin/env node
'use strict';
// Tests for S4: READY_FAILED sentinel on proxy bind failure.
// Verifies that when the proxy cannot bind (EADDRINUSE), it emits
// "READY_FAILED <code> <msg>" to stdout so the parent (c-thru or spawnProxy)
// can detect failure immediately rather than waiting for a timeout.
//
// Run: node test/proxy-init-race.test.js

const fs   = require('fs');
const http = require('http');
const net  = require('net');
const os   = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { assert, assertEq, summary, writeConfig } = require('./helpers');

const PROXY_BIN = path.resolve(__dirname, '..', 'tools', 'claude-proxy');

console.log('proxy-init-race tests\n');

// Hold a port open so the proxy cannot bind to it.
function holdPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, close: () => new Promise(r => server.close(r)) });
    });
    server.on('error', reject);
  });
}

// Spawn the proxy with a fixed port (--port N) and collect its stdout.
// Returns { stdout, exitCode } after the process terminates or times out.
function spawnProxyOnPort(configPath, port) {
  return new Promise((resolve) => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-home-'));
    const env = Object.assign({}, process.env, {
      HOME: tmpHome,
      CLAUDE_PROXY_STARTUP_PROBE: '0',
      CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
    });
    // Scrub credentials that shouldn't reach a test proxy
    for (const k of ['GOOGLE_API_KEY', 'GOOGLE_CLOUD_TOKEN', 'ANTHROPIC_API_KEY']) delete env[k];

    const child = spawn(process.execPath, [PROXY_BIN, '--config', configPath, '--port', String(port)], {
      env,
      cwd: path.dirname(PROXY_BIN),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 5000);

    child.on('exit', (code) => {
      clearTimeout(timer);
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-ir-'));

  const configPath = writeConfig(tmpDir, {
    backends: { stub: { kind: 'anthropic', url: 'http://127.0.0.1:1' } },
    model_routes: { 'test-model': 'stub' },
    llm_profiles: { workhorse: { 'best-cloud': { '128gb': 'test-model' } } },
  });

  // ── Test 1: READY_FAILED emitted when port is already in use ─────────────
  console.log('1. READY_FAILED emitted on EADDRINUSE');
  {
    const holder = await holdPort();
    try {
      const { stdout, exitCode } = await spawnProxyOnPort(configPath, holder.port);
      assert(stdout.includes('READY_FAILED'), `stdout contains READY_FAILED (got: ${JSON.stringify(stdout.slice(0, 200))})`);
      assert(stdout.includes('EADDRINUSE') || stdout.includes('EACCES') || stdout.includes('address already in use'),
        `stdout includes bind error code (got: ${JSON.stringify(stdout.slice(0, 200))})`);
      assert(exitCode !== 0, `proxy exits with non-zero code after bind failure (got ${exitCode})`);
    } finally { await holder.close().catch(() => {}); }
  }

  // ── Test 2: READY_FAILED does not precede a successful READY on a free port ─
  console.log('\n2. no READY_FAILED on successful bind — READY_FAILED is not emitted spuriously');
  {
    // Use a free port but pass via --port so the proxy doesn't print "READY <port>".
    // We just want to verify the proxy does NOT emit READY_FAILED when binding succeeds.
    const freeHolder = await holdPort();
    const freePort = freeHolder.port;
    await freeHolder.close();   // release it — then race to bind

    // Give the proxy a moment to start
    const result = await new Promise((resolve) => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-home-'));
      const env = Object.assign({}, process.env, {
        HOME: tmpHome,
        CLAUDE_PROXY_STARTUP_PROBE: '0',
        CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
      });
      for (const k of ['GOOGLE_API_KEY', 'GOOGLE_CLOUD_TOKEN', 'ANTHROPIC_API_KEY']) delete env[k];

      const child = spawn(process.execPath, [PROXY_BIN, '--config', configPath, '--port', String(freePort)], {
        env,
        cwd: path.dirname(PROXY_BIN),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      child.stdout.on('data', c => { stdout += c.toString(); });

      // Give it 2s to start; if it binds successfully, kill it and check stdout.
      setTimeout(() => {
        child.kill('SIGTERM');
      }, 2000);

      child.on('exit', () => {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
        resolve({ stdout });
      });
    });

    assert(!result.stdout.includes('READY_FAILED'),
      `no READY_FAILED on successful bind (stdout: ${JSON.stringify(result.stdout.slice(0, 200))})`);
  }

  // ── Test 3: READY line reports the exact port passed via --port ─────────────
  console.log('\n3. READY line reports the correct port when --port is used');
  {
    // Hold then release a port — race window is tiny but the test is only checking
    // that the reported port matches what was requested, not timing behavior.
    const holder = await holdPort();
    const targetPort = holder.port;
    await holder.close();

    const result = await new Promise((resolve) => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-home-'));
      const env = Object.assign({}, process.env, {
        HOME: tmpHome,
        CLAUDE_PROXY_STARTUP_PROBE: '0',
        CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
      });
      for (const k of ['GOOGLE_API_KEY', 'GOOGLE_CLOUD_TOKEN', 'ANTHROPIC_API_KEY']) delete env[k];

      const child = spawn(process.execPath, [PROXY_BIN, '--config', configPath, '--port', String(targetPort)], {
        env,
        cwd: path.dirname(PROXY_BIN),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      child.stdout.on('data', c => { stdout += c.toString(); });
      setTimeout(() => child.kill('SIGTERM'), 2500);
      child.on('exit', () => {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
        resolve({ stdout });
      });
    });

    if (result.stdout.includes('READY_FAILED')) {
      // Port was reclaimed between hold.close() and the proxy bind — skip this test.
      console.log('  SKIP  port reclaimed before proxy bind (flaky race — skip)');
    } else {
      const m = result.stdout.match(/^READY (\d+)$/m);
      assert(m !== null, `READY line present in stdout (got: ${JSON.stringify(result.stdout.slice(0, 200))})`);
      if (m) {
        assertEq(Number(m[1]), targetPort, `READY reports the requested port`);
      }
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
