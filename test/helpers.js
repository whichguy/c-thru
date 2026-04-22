#!/usr/bin/env node
'use strict';
// Shared test harness for proxy integration tests.
// Stdlib-only — no external deps.
//
// TODO: Evaluate porting test/*.test.sh to Node — if consolidating bash tests here
// is simpler than maintaining a mixed Node+bash suite, port them to use this harness.

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
    // Second bounded wait: SIGKILL should be near-instant, but cap at 1s to
    // prevent an indefinite hang if the kernel delays signal delivery.
    await Promise.race([
      exitPromise,
      new Promise(resolve => setTimeout(resolve, 1000)),
    ]);
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

// ── Stub backend ───────────────────────────────────────────────────────────

// Starts a lightweight HTTP server that captures forwarded proxy requests.
// Each entry in .requests records: { method, path, headers, body, model_used, serving_url }
// where model_used is the concrete model name the proxy forwarded (sans @sigil),
// and serving_url is the full URL the proxy targeted.
//
// Returns a minimal valid Anthropic non-streaming response for every request.
// Use kind:"anthropic" in the proxy config backend — no Ollama probe is triggered.
function stubBackend() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({
        method:      req.method,
        path:        req.url,
        headers:     req.headers,
        body,
        model_used:  body ? body.model : null,
        serving_url: `http://127.0.0.1:${server.address().port}${req.url}`,
      });
      const response = {
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'stub' }],
        model: body ? body.model : 'stub',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        requests,
        lastRequest: () => requests[requests.length - 1] || null,
        close: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

// ── STATUS block parser ────────────────────────────────────────────────────
// Unified parser shared by live and behavioral test suites.
// Strips <think> blocks and normalizes Qwen3 pipe-separated STATUS lines.

function parseStatusBlock(text) {
  if (typeof text !== 'string') return {};
  const stripped = text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/\|([A-Z_]+:)/g, '\n$1');
  const out = {};
  for (const line of stripped.split('\n')) {
    const m = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// ── Tier timeouts ──────────────────────────────────────────────────────────

const TIER_TIMEOUTS_MS = {
  'judge':              90_000,
  'judge-strict':       90_000,
  'deep-coder-cloud':   90_000,
  'code-analyst-cloud': 90_000,
  'code-analyst':      180_000,
  'deep-coder':        180_000,
  'pattern-coder':     300_000,
  'orchestrator':      300_000,
  'local-planner':     300_000,
};

function tierTimeout(tier, fallback = 180_000) {
  return TIER_TIMEOUTS_MS[tier] || fallback;
}

// ── tmpDir registry (SIGINT safety) ───────────────────────────────────────

const _tmpDirRegistry = new Set();

function registerTmpDir(dir) {
  _tmpDirRegistry.add(dir);
  return dir;
}

function cleanupTmpDirs() {
  for (const d of _tmpDirRegistry) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  _tmpDirRegistry.clear();
}

let _exitHandlersInstalled = false;

function installExitHandlers() {
  if (_exitHandlersInstalled) return;
  _exitHandlersInstalled = true;
  process.on('SIGINT',  () => { cleanupTmpDirs(); process.exit(130); });
  process.on('SIGTERM', () => { cleanupTmpDirs(); process.exit(143); });
  process.on('exit',    ()  => cleanupTmpDirs());
}

// ── Contract strip ─────────────────────────────────────────────────────────

function stripBehavioralContract(contractText) {
  const stripped = contractText
    .replace(/---\n\n## Post-work linting[\s\S]*$/, '').trim();
  if (stripped === contractText.trim()) {
    throw new Error(
      'stripBehavioralContract: no-op — shared/_worker-contract.md layout may have changed. ' +
      'Expected a "---" HR followed by "## Post-work linting" section at the end of the file.'
    );
  }
  return stripped;
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
  stubBackend,
  parseStatusBlock,
  tierTimeout,
  registerTmpDir,
  cleanupTmpDirs,
  installExitHandlers,
  stripBehavioralContract,
};
