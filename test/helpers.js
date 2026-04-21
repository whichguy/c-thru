#!/usr/bin/env node
'use strict';
// Shared test harness for proxy integration tests.
// Stdlib-only — no external deps.

const { spawn } = require('child_process');
const fs   = require('fs');
const http = require('http');
const os   = require('os');
const path = require('path');

const PROXY_BIN = path.resolve(__dirname, '..', 'tools', 'claude-proxy');

// ── Assertion helpers (matches model-map-v12-adapter.test.js style) ────────

let _passed = 0;
let _failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
    _passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    _failed++;
  }
}

function summary() {
  const total = _passed + _failed;
  console.log(`\n${_passed}/${total} passed${_failed ? ` — ${_failed} FAILED` : ''}`);
  return _failed;
}

// ── Temp directory ─────────────────────────────────────────────────────────

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-test-'));
  try {
    return fn(dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ── Config writer ──────────────────────────────────────────────────────────

// Writes a minimal valid model-map.json to dir and returns the path.
// Intentionally omits backends so /v1/models never proxies to Anthropic upstream.
function writeConfig(dir, overrides) {
  const base = {};
  const config = Object.assign({}, base, overrides);
  const configPath = path.join(dir, 'model-map.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

// ── Random free port helper ────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── Proxy spawn ────────────────────────────────────────────────────────────

// Spawns the proxy with test isolation env and returns { child, port, hooksPort }.
// opts: { configPath, profile, hooksPort, env, cwd }
// Does NOT pass --port so the proxy prints "READY <port>" on stdout.
async function spawnProxy(opts = {}) {
  const { configPath, profile, hooksPort, env: extraEnv = {}, cwd } = opts;

  const args = [];
  if (configPath) args.push('--config', configPath);
  if (profile)    args.push('--profile', profile);

  const tmpHome = opts.tmpHome || fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-home-'));

  const proxyEnv = Object.assign({}, process.env, {
    HOME: tmpHome,
    CLAUDE_PROXY_STARTUP_PROBE: '0',
    CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
    CLAUDE_PROXY_HOOKS_PORT: String(hooksPort || await getFreePort()),
  }, extraEnv);

  const child = spawn(process.execPath, [PROXY_BIN, ...args], {
    env: proxyEnv,
    cwd: cwd || path.dirname(PROXY_BIN),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const resolvedHooksPort = Number(proxyEnv.CLAUDE_PROXY_HOOKS_PORT);

  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('spawnProxy: timed out waiting for READY line'));
    }, 8000);

    child.on('error', err => {
      clearTimeout(timeout);
      reject(new Error(`spawnProxy: spawn error: ${err.message}`));
    });

    child.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`spawnProxy: proxy exited with code ${code} before emitting READY`));
    });

    child.stdout.on('data', chunk => {
      buf += chunk.toString();
      const m = buf.match(/READY (\d+)/);
      if (m) {
        clearTimeout(timeout);
        // Remove the 'exit' listener that would reject — proxy is alive
        child.removeAllListeners('exit');
        resolve(Number(m[1]));
      }
    });
  });

  return { child, port, hooksPort: resolvedHooksPort, tmpHome };
}

// ── /ping poller ───────────────────────────────────────────────────────────

function waitForPing(port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/ping', method: 'GET' }, res => {
        if (res.statusCode === 200) return resolve();
        schedule();
      });
      req.on('error', () => schedule());
      req.setTimeout(500, () => { req.destroy(); schedule(); });
      req.end();
    }
    function schedule() {
      if (Date.now() >= deadline) return reject(new Error(`waitForPing: timed out after ${timeoutMs}ms`));
      setTimeout(attempt, 100);
    }
    attempt();
  });
}

// ── HTTP helper ────────────────────────────────────────────────────────────

// Returns { status, headers, json, bodyText }.
function httpJson(port, method, urlPath, body, extraHeaders = {}, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {},
      extraHeaders,
    );
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(bodyText); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, bodyText });
        });
      }
    );
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`httpJson: request to ${urlPath} timed out after ${timeout}ms`));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── withProxy wrapper ──────────────────────────────────────────────────────

// Spawns proxy, waits for /ping, runs fn({ port, hooksPort, child }), then cleans up.
// Guarantees SIGTERM even if fn throws.
async function withProxy(opts, fn) {
  const hooksPort = opts.hooksPort || await getFreePort();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-home-'));
  let child, port, resolvedHooksPort;
  try {
    ({ child, port, hooksPort: resolvedHooksPort } = await spawnProxy(
      Object.assign({}, opts, { hooksPort, tmpHome })
    ));

    await waitForPing(port);
  } catch (e) {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    throw e;
  }

  const exitPromise = new Promise(resolve => child.on('exit', resolve));

  let fnError = null;
  try {
    await fn({ port, hooksPort: resolvedHooksPort, child, tmpHome });
  } catch (e) {
    fnError = e;
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('withProxy: child did not exit within 3s')), 3000)),
    ]).catch(() => {
      try { child.kill('SIGKILL'); } catch {}
    });
    await exitPromise;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }
  if (fnError) throw fnError;
}

// ── Log assertion helper ───────────────────────────────────────────────────

function assertLogContains(buf, pattern, msg) {
  assert(pattern.test(buf), msg);
}

// ── Collect stderr ─────────────────────────────────────────────────────────

// Attach to a child's stderr and collect into a capped buffer (~64KB).
function collectStderr(child) {
  const MAX = 64 * 1024;
  let buf = '';
  child.stderr.on('data', chunk => {
    buf += chunk.toString();
    if (buf.length > MAX) buf = buf.slice(buf.length - MAX);
  });
  return { get: () => buf };
}

// ── Global rejection guard ─────────────────────────────────────────────────

process.on('unhandledRejection', err => {
  console.error('unhandledRejection:', err);
  process.exit(1);
});

module.exports = {
  assert,
  summary,
  withTmpDir,
  writeConfig,
  getFreePort,
  spawnProxy,
  waitForPing,
  httpJson,
  withProxy,
  assertLogContains,
  collectStderr,
};
