#!/usr/bin/env node
'use strict';
// Shared test harness for proxy integration tests.
// Stdlib-only — no external deps.
//
// TODO: Evaluate porting test/*.test.sh to Node — if consolidating bash tests here
// is simpler than maintaining a mixed Node+bash suite, port them to use this harness.

const { spawn, spawnSync } = require('child_process');
const fs   = require('fs');
const http = require('http');
const os   = require('os');
const path = require('path');

const PROXY_BIN = path.resolve(__dirname, '..', 'tools', 'claude-proxy');

// ── Assertion helpers (matches model-map-v12-adapter.test.js style) ────────

let _passed = 0;
let _failed = 0;
let _skipped = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
    _passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    _failed++;
  }
}

// assertEq(actual, expected, label) — generates "(got actual)" automatically.
// Use instead of assert(actual === expected, `label (got ${actual})`).
function assertEq(actual, expected, label) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// skip(message) — record a self-skipped test case (e.g., upstream did not
// exercise the path under inspection). Counted separately from passes.
function skip(message) {
  console.log(`  SKIP  ${message}`);
  _skipped++;
}

// Set once summary() has run: the suite's pass/fail verdict is now COMMITTED.
// The unhandledRejection guard reads this so a late stray rejection (e.g. a
// post-teardown timer firing during the exit window) can't FLIP an
// already-computed exit code — a green suite must not silently turn red, and a
// red suite must not be masked. See the handler at the bottom of this file.
let _resultComputed = false;

function summary() {
  _resultComputed = true;
  const total = _passed + _failed;
  const skipNote = _skipped ? ` (${_skipped} skipped)` : '';
  console.log(`\n${_passed}/${total} passed${skipNote}${_failed ? ` — ${_failed} FAILED` : ''}`);
  return _failed;
}

// ── Temp directory ─────────────────────────────────────────────────────────

// Config-selection tests walk every ancestor of their launch cwd looking for
// .claude/model-map.json. os.tmpdir() is not always isolated: a caller can set
// TMPDIR to a directory under $HOME, causing that walk to reach the real
// ~/.claude config. Use an absolute temp base outside the real home for any
// fixture whose path participates in config/profile discovery.
function makeIsolatedTmpDir(prefix = 'c-thru-isolated-') {
  let realHome = null;
  try { realHome = fs.realpathSync(os.homedir()); } catch {}
  const candidates = ['/tmp', '/private/tmp', os.tmpdir()];
  for (const candidate of candidates) {
    let realBase;
    try {
      realBase = fs.realpathSync(candidate);
      fs.accessSync(realBase, fs.constants.W_OK);
    } catch {
      continue;
    }
    if (realHome &&
        (realBase === realHome || realBase.startsWith(realHome + path.sep))) {
      continue;
    }
    return fs.mkdtempSync(path.join(realBase, prefix));
  }
  throw new Error(
    `No writable temp directory outside home (${realHome || os.homedir()}); ` +
    'cannot safely exercise ancestor-based config discovery',
  );
}

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

// Like writeConfig, but creates a fresh subdirectory under parentDir so multiple
// configs in the same test don't silently overwrite each other (the bug that bit
// us with phase1Path/phase2Path both pointing to the same model-map.json).
function writeConfigFresh(parentDir, label, overrides) {
  const dir = fs.mkdtempSync(path.join(parentDir, `${label}-`));
  return writeConfig(dir, overrides);
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

// ── Generic stub HTTP server ────────────────────────────────────────────────
// Lightweight 127.0.0.1:0 server for tests that stand a stub in for the proxy or
// Ollama. `routes` maps a key to a response:
//   key:   "METHOD /path" (e.g. "POST /hooks/context"), a bare "/path", or "*"
//          (fallback). Lookup tries the method+path key, then the bare path,
//          then "*". Unmatched → 404 "{}".
//   value: a string (sent verbatim as the 200 body — pass already-serialized
//          JSON), a plain object (JSON.stringify'd → 200 application/json), or an
//          (req, res) function that owns the response (for slow/dynamic cases).
// Every request is appended to `.requests` as { method, url, path, headers, body }
// (body parsed as JSON when possible, else the raw string) — this log powers
// asserts like "the stub never saw GET /ping". Query strings are stripped from
// `path` for matching; `url` keeps the raw request target.
// Returns { server, port, url, requests, close }.
function startStubServer(routes = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const pathOnly = (req.url || '').split('?')[0];
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      requests.push({ method: req.method, url: req.url, path: pathOnly, headers: req.headers, body });

      const route =
        routes[`${req.method} ${pathOnly}`] ??
        routes[pathOnly] ??
        routes['*'];

      if (typeof route === 'function') { route(req, res); return; }
      if (route === undefined || route === null) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(typeof route === 'string' ? route : JSON.stringify(route));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

// ── Async spawn (capture) ────────────────────────────────────────────────────
// spawn() wrapper that captures stdout/stderr and resolves on exit. REQUIRED
// (over child_process.spawnSync) whenever the spawned process talks to an
// in-process startStubServer: spawnSync blocks THIS process's event loop, so the
// stub could never accept the connection or answer. opts mirrors spawn options
// (env, cwd). `opts.timeout` SIGKILLs the child after that many ms. Resolves
// { status, signal, stdout, stderr } — never rejects on a non-zero exit (only on
// a spawn error, e.g. ENOENT). status is null when the child was signal-killed.
function spawnCapture(cmd, args, opts = {}) {
  const { timeout, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, spawnOpts));
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (timeout) timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeout);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (status, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

// ── Proxy spawn ────────────────────────────────────────────────────────────

// Spawns the proxy with test isolation env and returns { child, port, hooksPort }.
// opts: { configPath, profile, mode, hooksPort, env, cwd, readyTimeoutMs,
//         proxyBin (test-only fixture injection) }
// Does NOT pass --port so the proxy prints "READY <port>" on stdout.
async function spawnProxy(opts = {}) {
  const { configPath, profile, mode, hooksPort, env: extraEnv = {}, cwd } = opts;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_HERMETIC_READY_TIMEOUT_MS;
  const proxyBin = opts.proxyBin || PROXY_BIN;

  const args = [];
  if (configPath) args.push('--config', configPath);
  if (profile)    args.push('--profile', profile);
  if (mode)       args.push('--mode', mode);

  const ownsTmpHome = !opts.tmpHome;
  const tmpHome = opts.tmpHome || makeIsolatedTmpDir('c-thru-home-');
  const profileDir = path.join(tmpHome, '.claude');
  const processCwd = cwd || tmpHome;
  fs.mkdirSync(profileDir, { recursive: true });

  const proxyEnv = Object.assign({}, process.env, {
    HOME: tmpHome,
    CLAUDE_PROFILE_DIR: profileDir,
    CLAUDE_MODEL_MAP_LAUNCH_CWD: processCwd,
  }, extraEnv);
  if (!extraEnv.CLAUDE_MODEL_MAP_PATH) delete proxyEnv.CLAUDE_MODEL_MAP_PATH;
  // When this test runs from inside a live c-thru session, the ambient
  // CLAUDE_CONFIG_DIR/CLAUDE_PROFILE_DIR/CLAUDE_DIR point at that session's
  // real ephemeral profile dir. Pin CLAUDE_PROFILE_DIR above and scrub the
  // lower-precedence aliases unless a test explicitly supplies them.
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_DIR']) {
    if (!Object.prototype.hasOwnProperty.call(extraEnv, k)) delete proxyEnv[k];
  }
  Object.assign(proxyEnv, {
    CLAUDE_PROXY_STARTUP_PROBE: '0',
    CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
    CLAUDE_PROXY_HOOKS_PORT: String(hooksPort || await getFreePort()),
  }, extraEnv);
  // T9: prevent host-shell auth keys from silently leaking into the proxy
  // child. Tests assert "no auth header when unset" — but Object.assign only
  // overwrites, never deletes, so a host-set GOOGLE_API_KEY survives into
  // applyOutboundAuth and gets stamped onto the upstream request. Scrub
  // every auth_env value referenced by the active config (so adding a new
  // backend can't silently re-introduce the leak), plus a small static
  // fallback for tests that don't pass a configPath.
  const STATIC_AUTH_KEYS = [
    'GOOGLE_API_KEY', 'GOOGLE_CLOUD_TOKEN', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_REGION',
    'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
  ];
  let configAuthKeys = [];
  if (configPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const endpoints = raw.endpoints || raw.backends || {};
      // Cover both schemas applyOutboundAuth accepts: top-level
      // `auth_env: "FOO"` and nested `auth: {env: "FOO"}`.
      configAuthKeys = Object.values(endpoints).flatMap(e => {
        if (!e || typeof e !== 'object') return [];
        const out = [];
        if (e.auth_env) out.push(e.auth_env);
        if (e.auth && typeof e.auth === 'object' && e.auth.env) out.push(e.auth.env);
        return out;
      });
    } catch {}
  }
  const AUTH_ENV_KEYS = [...new Set([...STATIC_AUTH_KEYS, ...configAuthKeys])];
  for (const k of AUTH_ENV_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(extraEnv, k)) delete proxyEnv[k];
  }
  // Anthropic upstream override must not leak from a live c-thru shell into
  // hermetic suites (proxy exits 2 on invalid/loopback override without opt-in).
  for (const k of [
    'CLAUDE_PROXY_ANTHROPIC_UPSTREAM',
    'C_THRU_ANTHROPIC_UPSTREAM',
    'C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT',
    'C_THRU_TRUST_AMBIENT_UPSTREAM',
    'C_THRU_IGNORE_AMBIENT_ANTHROPIC_BASE_URL',
    'C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM',
    'C_THRU_ALLOW_LOOPBACK_ANTHROPIC_UPSTREAM',
  ]) {
    if (!Object.prototype.hasOwnProperty.call(extraEnv, k)) delete proxyEnv[k];
  }

  const child = spawn(process.execPath, [proxyBin, ...args], {
    env: proxyEnv,
    cwd: processCwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const resolvedHooksPort = Number(proxyEnv.CLAUDE_PROXY_HOOKS_PORT);

  let port;
  try {
    port = await new Promise((resolve, reject) => {
      let buf = '';
      let settled = false;
      let timeout;

      const cleanup = () => {
        clearTimeout(timeout);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        child.stdout.removeListener('data', onData);
      };

      const rejectNow = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const rejectAfterReap = async (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          await terminateAndReap(child, 'SIGKILL');
        } catch (cleanupError) {
          reject(new AggregateError(
            [error, cleanupError],
            'spawnProxy: READY wait failed and child cleanup failed',
          ));
          return;
        }
        reject(error);
      };

      function onError(err) {
        const error = new Error(`spawnProxy: spawn error: ${err.message}`);
        if (child.pid) void rejectAfterReap(error);
        else rejectNow(error);
      }

      function onExit(code, signal) {
        rejectNow(new Error(
          `spawnProxy: proxy exited with code ${code} signal ${signal || 'none'} before emitting READY`,
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
        void rejectAfterReap(new Error(
          `spawnProxy: timed out after ${readyTimeoutMs}ms waiting for READY line`,
        ));
      }, readyTimeoutMs);
      child.once('error', onError);
      child.once('exit', onExit);
      child.stdout.on('data', onData);
    });
  } catch (e) {
    if (ownsTmpHome) {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
    throw e;
  }

  return { child, port, hooksPort: resolvedHooksPort, tmpHome };
}

// ── /ping poller ───────────────────────────────────────────────────────────

// Hermetic proxy tests still cross child-process and loopback boundaries, so
// loaded hosts need wider infrastructure budgets than behavior-specific tests.
// These remain finite and intentionally separate from model/live timeouts.
const DEFAULT_HERMETIC_READY_TIMEOUT_MS = 15_000;
const DEFAULT_HERMETIC_REQUEST_TIMEOUT_MS = 10_000;

// Polls the proxy's /ping endpoint until it returns 200, or `timeoutMs` elapses.
// Per-attempt timeout grows from 250ms → 1500ms (catches slow first-bind on
// loaded machines without burning the whole budget on the happy-path first
// try). Backoff between attempts grows similarly: 30/60/120/250/500ms capped.
// ECONNREFUSED and ECONNRESET both retry immediately (next event-loop tick):
// ECONNREFUSED = listener not bound yet; ECONNRESET = "socket hang up" (proxy
// accepted then reset the connection while still coming up under load). Both
// mean "listener not stable yet" and we shouldn't sleep on either.
function waitForPing(port, timeoutMs = DEFAULT_HERMETIC_READY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const lastError = { kind: null, message: null };
    let attemptCount = 0;
    let activeRequest = null;
    let settled = false;
    const perAttemptTimeouts = [250, 500, 750, 1000, 1500];
    const backoffMs        = [30, 60, 120, 250, 500];
    const deadlineTimer = setTimeout(rejectAtDeadline, timeoutMs);

    function rejectAtDeadline() {
      if (settled) return;
      settled = true;
      if (activeRequest) activeRequest.destroy();
      reject(new Error(
        `waitForPing: timed out after ${timeoutMs}ms (last: ${lastError.kind || 'none'} ${lastError.message || ''})`,
      ));
    }

    function attempt() {
      if (settled) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return rejectAtDeadline();
      const idx = Math.min(attemptCount, perAttemptTimeouts.length - 1);
      attemptCount++;
      const req = http.request({ hostname: '127.0.0.1', port, path: '/ping', method: 'GET' }, res => {
        if (settled) { res.resume(); return; }
        // Drain so the socket can be released even on non-200.
        res.resume();
        if (res.statusCode === 200) {
          settled = true;
          clearTimeout(deadlineTimer);
          activeRequest = null;
          resolve();
          return;
        }
        lastError.kind = 'status';
        lastError.message = `status=${res.statusCode}`;
        schedule(false);
      });
      activeRequest = req;
      req.on('error', (err) => {
        if (settled) return;
        lastError.kind = err.code || 'error';
        lastError.message = err.message;
        // ECONNREFUSED = listener not bound yet; ECONNRESET = socket hang up
        // (accepted-then-reset during startup under load). Both mean the
        // listener isn't stable yet — retry on next tick instead of waiting
        // full backoff — saves up to 500ms during proxy startup.
        schedule(err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET');
      });
      const attemptTimeoutMs = Math.max(1, Math.min(perAttemptTimeouts[idx], remainingMs));
      req.setTimeout(attemptTimeoutMs, () => {
        if (settled) return;
        lastError.kind = 'timeout';
        lastError.message = `per-attempt timeout ${attemptTimeoutMs}ms`;
        req.destroy();
      });
      req.end();
    }
    function schedule(immediate) {
      if (settled) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return rejectAtDeadline();
      if (immediate) return setImmediate(attempt);
      const idx = Math.min(attemptCount - 1, backoffMs.length - 1);
      setTimeout(attempt, Math.min(backoffMs[Math.max(0, idx)], remainingMs));
    }
    attempt();
  });
}

// ── HTTP helper ────────────────────────────────────────────────────────────

// Returns { status, headers, json, bodyText }.
// timeoutOrOpts: number ms, or { timeout, retries } where retries is one
// additional attempt after a request timeout (not connection errors).
// On timeout before final attempt, dumps lightweight load diagnostics to stderr
// so full-suite flakes leave evidence without raising the default 10s bound.
function httpJson(
  port,
  method,
  urlPath,
  body,
  extraHeaders = {},
  timeoutOrOpts = DEFAULT_HERMETIC_REQUEST_TIMEOUT_MS,
) {
  let timeout = DEFAULT_HERMETIC_REQUEST_TIMEOUT_MS;
  let retries = 0;
  if (timeoutOrOpts && typeof timeoutOrOpts === 'object') {
    if (timeoutOrOpts.timeout != null) timeout = timeoutOrOpts.timeout;
    if (timeoutOrOpts.retries != null) retries = timeoutOrOpts.retries;
  } else if (typeof timeoutOrOpts === 'number') {
    timeout = timeoutOrOpts;
  }

  function once() {
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
            resolve({ status: res.statusCode, headers: res.headers, json, body: json, bodyText });
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

  async function withRetry() {
    let attempt = 0;
    // attempt 0 + retries extra attempts
    for (;;) {
      try {
        return await once();
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        const isTimeout = /timed out after \d+ms/.test(msg);
        if (!isTimeout || attempt >= retries) throw err;
        attempt += 1;
        try {
          const load = typeof os.loadavg === 'function' ? os.loadavg() : null;
          process.stderr.write(
            `httpJson: timeout ${method} ${urlPath} port=${port}; retry ${attempt}/${retries}` +
            (load ? ` loadavg=${load.map(n => n.toFixed(2)).join(',')}` : '') +
            ` free_mb≈${Math.round((os.freemem?.() || 0) / 1024 / 1024)}\n`,
          );
        } catch { /* diagnostic best-effort */ }
      }
    }
  }

  return withRetry();
}

// ── withProxy wrapper ──────────────────────────────────────────────────────

function childExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function childExitPromise(child) {
  if (childExited(child)) return Promise.resolve();
  return new Promise(resolve => {
    const onExit = () => resolve();
    child.once('exit', onExit);
    // Close the race where the child exits between the initial state check and
    // listener registration.
    if (childExited(child)) {
      child.removeListener('exit', onExit);
      resolve();
    }
  });
}

function settlesWithin(promise, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(false);
    }, timeoutMs);
    promise.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

// Best-effort but bounded child shutdown used by both normal teardown and
// startup failures. The exit listener is armed before signaling so a fast exit
// cannot be missed; all watchdog timers are cleared when the child exits.
async function terminateAndReap(child, initialSignal = 'SIGTERM', finalReapTimeoutMs = 1000) {
  if (!child) return;
  const exitPromise = childExitPromise(child);
  if (childExited(child)) {
    await exitPromise;
    return;
  }
  let signalSent = false;
  try { signalSent = child.kill(initialSignal); } catch {}
  if (!signalSent && !childExited(child)) {
    throw new Error(`terminateAndReap: failed to send ${initialSignal} to child ${child.pid}`);
  }
  if (initialSignal === 'SIGKILL') {
    if (!await settlesWithin(exitPromise, finalReapTimeoutMs)) {
      throw new Error(
        `terminateAndReap: child ${child.pid} did not report exit within ${finalReapTimeoutMs}ms after SIGKILL`,
      );
    }
    return;
  }
  if (await settlesWithin(exitPromise, 3000)) return;
  signalSent = false;
  try { signalSent = child.kill('SIGKILL'); } catch {}
  if (!signalSent && !childExited(child)) {
    throw new Error(`terminateAndReap: failed to SIGKILL child ${child.pid}`);
  }
  // Once SIGKILL is accepted, do not report cleanup complete unless Node has
  // observed the exit and reaped the child. Remain bounded and fail loudly if
  // that invariant cannot be confirmed.
  if (!await settlesWithin(exitPromise, finalReapTimeoutMs)) {
    throw new Error(
      `terminateAndReap: child ${child.pid} did not report exit within ${finalReapTimeoutMs}ms after SIGKILL`,
    );
  }
}

// Spawns proxy, waits for /ping, runs fn({ port, hooksPort, child }), then cleans up.
// Guarantees SIGTERM even if fn throws.
async function withProxy(opts, fn) {
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_HERMETIC_READY_TIMEOUT_MS;
  const readyDeadline = Date.now() + readyTimeoutMs;
  const hooksPort = opts.hooksPort || await getFreePort();
  const tmpHome = makeIsolatedTmpDir('c-thru-home-');
  let child, port, resolvedHooksPort;
  try {
    const remainingForReady = Math.max(1, readyDeadline - Date.now());
    ({ child, port, hooksPort: resolvedHooksPort } = await spawnProxy(
      Object.assign({}, opts, {
        hooksPort,
        tmpHome,
        readyTimeoutMs: remainingForReady,
      })
    ));

    const remainingForPing = readyDeadline - Date.now();
    if (remainingForPing <= 0) {
      throw new Error(`withProxy: readiness timed out after ${readyTimeoutMs}ms before /ping`);
    }
    try {
      await waitForPing(port, remainingForPing);
    } catch (e) {
      throw new Error(
        `withProxy: readiness timed out after ${readyTimeoutMs}ms (${e.message})`,
        { cause: e },
      );
    }
  } catch (e) {
    try {
      await terminateAndReap(child);
    } finally {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
    throw e;
  }

  let fnError = null;
  try {
    await fn({ port, hooksPort: resolvedHooksPort, child, tmpHome });
  } catch (e) {
    fnError = e;
  } finally {
    await terminateAndReap(child);
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
//
// Options:
//   failWith: <statusCode>  — respond with this HTTP status on every request (e.g. 502)
//                              instead of 200. Used by fallback/hard_fail tests.
//   responseBody: <obj>     — override the JSON body returned (200 path only).
function stubBackend(opts = {}) {
  const { failWith, responseBody } = opts;
  const requests = [];
  // Optional custom handler. If set and returns truthy, the stub yields request
  // handling to it (no default 200 response is sent). Used by translation tests
  // that need protocol-specific response shapes (e.g., Gemini SSE).
  //
  // Contract: customHandler MUST `return true` if it called res.writeHead /
  // res.write / res.end. Otherwise the fallthrough below tries to write the
  // default Anthropic response, hits "Cannot set headers after they are sent",
  // and the request hangs waiting for a body that will never arrive. Defensive
  // check: if the handler returned falsy but already started the response,
  // log loudly and treat as handled so the test surfaces a clear error.
  let customHandler = null;
  const server = http.createServer((req, res) => {
    if (customHandler) {
      // Record basic request metadata up-front so tests can assert on
      // headers/path even when the handler consumes the body itself.
      requests.push({
        method:      req.method,
        path:        req.url,
        headers:     req.headers,
        body:        null,
        model_used:  null,
        serving_url: `http://127.0.0.1:${server.address().port}${req.url}`,
      });
      const handled = customHandler(req, res);
      if (handled) return;
      // Detect cases where the handler "fell through" without `return true`
      // but had already started a response (sync writeHead) OR registered
      // async listeners that will eventually finish the response. Either way,
      // letting the default fallthrough fire would race and crash on
      // "Cannot set headers after they are sent". Be robust: treat as handled.
      if (res.headersSent || res.writableEnded || req.listenerCount('data') > 0 || req.listenerCount('end') > 0) {
        process.stderr.write(
          `[stubBackend] customHandler did not return true but appears to be handling the response — ` +
          `treating as handled. Add 'return true' inside your stub.setHandler callback to silence this.\n` +
          `  request: ${req.method} ${req.url}\n`
        );
        // Belt-and-suspenders: if the handler never closes the response, the
        // client times out. We can't know its async timing here, so just
        // let it run; the warning identifies the test that needs fixing.
        return;
      }
    }
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
      if (failWith) {
        const errBody = JSON.stringify({ type: 'error', error: { type: 'api_error', message: `stub forced ${failWith}` } });
        res.writeHead(failWith, { 'Content-Type': 'application/json' });
        res.end(errBody);
        return;
      }
      const response = responseBody || {
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
        setHandler: (fn) => { customHandler = fn; },
        close: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

// ── Streaming stub backend ─────────────────────────────────────────────────
// Returns a backend that responds with a Server-Sent Events stream built from
// the given event list. Each entry is `{ event: <name>, data: <obj> }` and
// gets emitted as `event: <name>\ndata: <json>\n\n`.
//
// Captures every request body to `.requests` like stubBackend does.
function streamingStubBackend(events) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({ method: req.method, path: req.url, body, model_used: body?.model || null });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      for (const ev of events) {
        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
      }
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        requests,
        lastRequest: () => requests[requests.length - 1] || null,
        close: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

// ── Ollama stub backend ────────────────────────────────────────────────────
// Stub that mimics Ollama's /api/chat endpoint: emits the supplied ndjson
// chunks one per line with a small inter-chunk delay (so streaming behaviour
// is observable end-to-end). Records every incoming request body for
// assertions. Use to test the proxy's Ollama→Anthropic SSE translation.
//
//   const stub = await ollamaStubBackend([
//     { message: { content: '', thinking: 'Considering...' } },
//     { message: { content: 'Hi', thinking: '' } },
//     { done: true, done_reason: 'stop', prompt_eval_count: 4, eval_count: 2 },
//   ]);
function ollamaStubBackend(ndjsonChunks, opts = {}) {
  const interChunkMs = opts.interChunkMs || 5;
  const requests = [];
  // Track active per-request timers so we can clear them if close() races
  // mid-stream. Otherwise the recursive setTimeout keeps the test event loop
  // alive and may write to a destroyed socket.
  const activeTimers = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({ method: req.method, path: req.url, body, model_used: body?.model || null });

      // Honor the request's `stream` field (matches real Ollama behaviour).
      // stream:false → emit a single JSON object summarizing the full
      // exchange. stream:true (or omitted) → emit ndjson chunks one per line.
      // This matters because forwardOllama's non-streaming path JSON.parses
      // the entire response as a single object — feeding it ndjson causes
      // a parse failure that surfaces as 502 to the client.
      const isStream = body?.stream !== false;
      if (!isStream) {
        // Build a single Ollama-shape JSON response from the chunks.
        const finalChunk = ndjsonChunks[ndjsonChunks.length - 1] || {};
        const contentChunk = ndjsonChunks.find(c => c.message?.content) || { message: { content: '' } };
        const thinkingChunks = ndjsonChunks.filter(c => c.message?.thinking).map(c => c.message.thinking).join('');
        const message = {
          role: 'assistant',
          content: contentChunk.message?.content || '',
        };
        if (thinkingChunks) message.thinking = thinkingChunks;
        const respObj = {
          model: body?.model || 'stub-ollama',
          created_at: new Date().toISOString(),
          message,
          done: true,
          done_reason: finalChunk.done_reason || 'stop',
          prompt_eval_count: finalChunk.prompt_eval_count || 0,
          eval_count: finalChunk.eval_count || 0,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(respObj));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
      });
      let i = 0;
      let timer = null;
      const cancelTimer = () => {
        if (timer) { clearTimeout(timer); activeTimers.delete(timer); timer = null; }
      };
      const tick = () => {
        cancelTimer();
        if (!res.writable) return;
        if (i < ndjsonChunks.length) {
          res.write(JSON.stringify(ndjsonChunks[i++]) + '\n');
          timer = setTimeout(tick, interChunkMs);
          activeTimers.add(timer);
        } else {
          res.end();
        }
      };
      // Cancel pending timer if the client (proxy) gives up mid-stream.
      res.on('close', cancelTimer);
      tick();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        requests,
        lastRequest: () => requests[requests.length - 1] || null,
        close: () => new Promise(r => {
          // Cancel any in-flight chunk timers before closing the server,
          // otherwise close() waits for in-flight requests to drain and the
          // timers race against socket destruction.
          for (const t of activeTimers) clearTimeout(t);
          activeTimers.clear();
          server.close(r);
        }),
      });
    });
    server.on('error', reject);
  });
}

// ── Classifier stub (Phase A dynamic classifier) ──────────────────────────
// Mimics Ollama's /api/generate endpoint, returning a JSON response object
// shaped as {response: '<json string>', done: true}. The classifier in
// claude-proxy parses `response` for {role, confidence}.
//
// Options:
//   role:       which role to "classify" prompts as (default 'coder')
//   confidence: confidence to return (default 0.85)
//   responses:  array of {role, confidence} to return in sequence — once
//               exhausted, falls back to default. Useful for asserting cache
//               (subsequent calls return same role even after stub flips).
//   delay_ms:   artificial latency before responding
//   broken:     if true, return malformed JSON (tests parse-failed soft-fail)
function classifierStub(opts = {}) {
  const { role = 'coder', confidence = 0.85, responses, delay_ms, broken } = opts;
  const requests = [];
  let respIdx = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({ method: req.method, path: req.url, body });

      const respond = () => {
        if (broken) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{not valid json');
          return;
        }
        let pick;
        if (Array.isArray(responses) && respIdx < responses.length) {
          pick = responses[respIdx++];
        } else {
          pick = { role, confidence };
        }
        // Ollama /api/generate response shape: {response, done, ...}
        const ollamaResp = {
          model: body?.model || 'stub',
          response: JSON.stringify({ role: pick.role, confidence: pick.confidence }),
          done: true,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ollamaResp));
      };
      if (delay_ms) setTimeout(respond, delay_ms); else respond();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        requests,
        lastRequest: () => requests[requests.length - 1] || null,
        close: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

// ── HTTP streaming consumer ────────────────────────────────────────────────
// Issues a request and reads the full response body, parsing SSE events.
// Returns { status, headers, events: [{event, data}], rawBody }.
// `data` is parsed as JSON when possible; otherwise the raw string is kept.
function httpStream(port, method, urlPath, body, extraHeaders = {}, timeout = 10000) {
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
          const raw = Buffer.concat(chunks).toString('utf8');
          // Parse SSE: split on blank line between events
          const events = [];
          for (const block of raw.split(/\r?\n\r?\n/)) {
            const trimmed = block.trim();
            if (!trimmed) continue;
            const ev = { event: null, data: null };
            for (const line of trimmed.split(/\r?\n/)) {
              if (line.startsWith('event:')) ev.event = line.slice(6).trim();
              else if (line.startsWith('data:')) {
                const raw = line.slice(5).trim();
                try { ev.data = JSON.parse(raw); } catch { ev.data = raw; }
              }
            }
            events.push(ev);
          }
          resolve({ status: res.statusCode, headers: res.headers, events, rawBody: raw });
        });
      }
    );
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`httpStream: request to ${urlPath} timed out after ${timeout}ms`));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── STATUS block parser ────────────────────────────────────────────────────
// Unified parser shared by live and behavioral test suites.
// Strips <think> blocks and normalizes Qwen3 pipe-separated STATUS lines.

function normalizeStatusText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/\|([A-Z_]+:)/g, '\n$1');
}

function boundedDiagnosticSnippet(value, maxChars = 120) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error('maxChars must be a positive safe integer');
  }
  const sanitized = String(value ?? '')
    .replace(
      /\b((?:[A-Z][A-Z0-9_.-]*[_-])?(?:API[_-]?KEY|AUTH(?:ORIZATION)?(?:[_-]?TOKEN)?|ACCESS[_-]?KEY|TOKEN|SECRET|PASSWORD))\s*[:=]\s*(?:"[^"]*"|'[^']*'|(?:Bearer\s+)?[^\s,;]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /\bBearer\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      'Bearer [REDACTED]',
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|gh[opusr]_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
      '[REDACTED]',
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (sanitized.length <= maxChars) return sanitized;
  if (maxChars === 1) return '…';
  return `${sanitized.slice(0, maxChars - 1)}…`;
}

function parseStatusBlock(text) {
  const stripped = normalizeStatusText(text);
  const out = {};
  for (const line of stripped.split('\n')) {
    const m = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const VALID_TASK_STATUSES = new Set(['COMPLETE', 'PARTIAL', 'FAILED']);
const TASK_CONTRACT_FIELDS = new Set([
  'ATTEMPTED',
  'COMPLETED',
  'FAILED',
  'PARTIAL',
  'UNBLOCKED_TASKS',
  'VERDICT',
]);
const RECUSAL_CONTRACT_FIELDS = new Set(['INSTALL', 'REASON', 'RECUSAL_REASON']);

function finalContractBlockError(text) {
  const lines = normalizeStatusText(text).split('\n');
  const statusIndexes = [];
  for (let index = 0; index < lines.length; index++) {
    if (/^\s*(?:TASK_STATUS|STATUS):\s*/.test(lines[index])) {
      statusIndexes.push(index);
    }
  }
  if (statusIndexes.length > 1) {
    return 'response contains multiple TASK_STATUS/STATUS contract blocks';
  }
  if (statusIndexes.length === 0) return null;

  const start = statusIndexes[0];
  const marker = lines[start].trimStart().match(/^(TASK_STATUS|STATUS):/)[1];
  const allowedFields = marker === 'TASK_STATUS'
    ? TASK_CONTRACT_FIELDS
    : RECUSAL_CONTRACT_FIELDS;
  let continuationField = null;
  const seenFields = new Set();
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === '') continue;
    if (/^(?:```|~~~)$/.test(line.trim()) &&
        lines.slice(index + 1).every(remaining => remaining.trim() === '')) {
      continue;
    }
    const fieldMatch = line.match(/^([A-Z_]+):\s*/);
    if (fieldMatch) {
      const field = fieldMatch[1];
      const diagnosticField = boundedDiagnosticSnippet(field);
      if (!allowedFields.has(field)) {
        return (
          `TASK_STATUS/STATUS contract block contains unexpected field ` +
          `${JSON.stringify(diagnosticField)} on line ${index + 1}`
        );
      }
      const semanticField = field === 'REASON' || field === 'RECUSAL_REASON'
        ? 'RECUSAL_REASON'
        : field;
      if (seenFields.has(semanticField)) {
        return (
          `TASK_STATUS/STATUS contract block contains duplicate field ` +
          `${JSON.stringify(diagnosticField)} on line ${index + 1}`
        );
      }
      seenFields.add(semanticField);
      continuationField = field;
      continue;
    }
    if ((/^\s+/.test(line) || /^[-*]\s+/.test(line)) && continuationField) {
      continue;
    }
    if (continuationField === 'UNBLOCKED_TASKS' &&
        (/^Task\(/.test(line.trim()) ||
         /^#\s*(?:Task\(|COMPLETE\b|PARTIAL\b|FAILED\b|APPROVED\b|NEEDS_REVISION\b)/.test(
           line.trim(),
         ))) {
      continue;
    }
    const unexpected = boundedDiagnosticSnippet(line);
    return (
      `TASK_STATUS/STATUS contract block is not final; ` +
      `unexpected trailing content on line ${index + 1}: ` +
      `${JSON.stringify(unexpected)}`
    );
  }
  return null;
}

// Current structured agents use TASK_STATUS for normal completion. STATUS is
// reserved for the separate recusal path; accepting STATUS: COMPLETE here would
// let a deleted contract silently return.
function parseAgentContractResult(text) {
  const fields = parseStatusBlock(text);
  const placementError = finalContractBlockError(text);
  if (placementError) {
    return {
      kind: 'invalid',
      valid: false,
      status: null,
      fields,
      reason: placementError,
    };
  }
  const hasTaskStatus = Object.prototype.hasOwnProperty.call(fields, 'TASK_STATUS');
  const hasStatus = Object.prototype.hasOwnProperty.call(fields, 'STATUS');
  const hasRecusalReason =
    Object.prototype.hasOwnProperty.call(fields, 'RECUSAL_REASON') ||
    Object.prototype.hasOwnProperty.call(fields, 'REASON');
  const recusalReason = fields.RECUSAL_REASON || fields.REASON || '';

  if (fields.STATUS === 'RECUSE' && !hasTaskStatus) {
    if (!recusalReason) {
      return {
        kind: 'invalid',
        valid: false,
        status: null,
        fields,
        reason: 'STATUS: RECUSE requires a non-empty RECUSAL_REASON or REASON',
      };
    }
    return {
      kind: 'recusal',
      valid: true,
      status: 'RECUSE',
      recusalReason,
      fields,
    };
  }
  if (!hasStatus && !hasRecusalReason && VALID_TASK_STATUSES.has(fields.TASK_STATUS)) {
    return { kind: 'task', valid: true, status: fields.TASK_STATUS, fields };
  }

  let reason = 'missing TASK_STATUS or STATUS: RECUSE';
  if (hasStatus && fields.STATUS !== 'RECUSE') {
    reason =
      `legacy normal STATUS ` +
      `${JSON.stringify(boundedDiagnosticSnippet(fields.STATUS))} is not accepted`;
  } else if (hasTaskStatus && !VALID_TASK_STATUSES.has(fields.TASK_STATUS)) {
    reason =
      `TASK_STATUS ${JSON.stringify(boundedDiagnosticSnippet(fields.TASK_STATUS))} ` +
      `is not in {COMPLETE, PARTIAL, FAILED}`;
  } else if (fields.STATUS === 'RECUSE' && hasTaskStatus) {
    reason = 'response mixes STATUS: RECUSE with TASK_STATUS';
  } else if (hasTaskStatus && hasRecusalReason) {
    reason = 'response mixes TASK_STATUS with a recusal reason';
  }
  return { kind: 'invalid', valid: false, status: null, fields, reason };
}

// ── Tier timeouts ──────────────────────────────────────────────────────────

// Keep every model-backed test operation bounded to one hour. The same cap is
// propagated to the outer HTTP/CLI wait and the proxy's upstream watchdogs so
// a provider or tool hang cannot outlive the test's configured deadline.
const MAX_MODEL_TEST_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MODEL_TEST_TIMEOUT_MS = MAX_MODEL_TEST_TIMEOUT_MS;
const MODEL_TEST_SUPERVISOR = path.resolve(
  __dirname,
  '..',
  'tools',
  'run-with-hard-timeout.js',
);
const {
  consumeTestSupervisorCapability,
} = require('../tools/test-supervisor-capability');

function hasActiveModelTestSupervisor(env = process.env, nowMs = Date.now()) {
  return consumeTestSupervisorCapability({
    env,
    nowMs,
    claimantParentPid: process.ppid,
    maxRemainingMs: MAX_MODEL_TEST_TIMEOUT_MS,
  });
}

// Directly invoked model suites re-exec once through the same out-of-process
// supervisor used by run-all.sh. Unlike an HTTP inactivity timer, this deadline
// still fires during spawnSync, CPU stalls, or a response that trickles bytes.
function ensureModelTestSupervisor() {
  if (hasActiveModelTestSupervisor()) return false;
  const timeoutSeconds = process.env.C_THRU_TEST_TIMEOUT_SECONDS || '3600';
  const result = spawnSync(
    process.execPath,
    [
      MODEL_TEST_SUPERVISOR,
      '--timeout-seconds',
      timeoutSeconds,
      '--',
      process.execPath,
      ...process.argv.slice(1),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    },
  );
  if (result.error) {
    console.error(`model test supervisor failed: ${result.error.message}`);
    process.exit(127);
  }
  if (Number.isInteger(result.status)) process.exit(result.status);
  const signalExitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGKILL: 137 };
  process.exit(signalExitCodes[result.signal] || 1);
}

function validateModelTestTimeoutMs(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MODEL_TEST_TIMEOUT_MS) {
    throw new Error(`${label} must be an integer from 1 to ${MAX_MODEL_TEST_TIMEOUT_MS}`);
  }
  return value;
}

function modelTestTimeoutMs(fallback = DEFAULT_MODEL_TEST_TIMEOUT_MS) {
  const raw = process.env.C_THRU_MODEL_TEST_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') {
    return validateModelTestTimeoutMs(fallback, 'model test fallback timeout');
  }
  if (!/^[1-9]\d*$/.test(raw.trim())) {
    throw new Error('C_THRU_MODEL_TEST_TIMEOUT_MS must be a positive integer');
  }
  const value = Number(raw);
  return validateModelTestTimeoutMs(value, 'C_THRU_MODEL_TEST_TIMEOUT_MS');
}

function modelTestProxyEnv(timeoutMs = modelTestTimeoutMs()) {
  const value = String(validateModelTestTimeoutMs(timeoutMs, 'model proxy timeout'));
  return {
    C_THRU_MODEL_TEST_TIMEOUT_MS: value,
    CLAUDE_PROXY_ANTHROPIC_TIMEOUT_MS: value,
    CLAUDE_PROXY_GEMINI_TIMEOUT_MS: value,
    CLAUDE_PROXY_RESPONSES_TIMEOUT_MS: value,
    CLAUDE_PROXY_OLLAMA_TIMEOUT_MS: value,
    CLAUDE_PROXY_OLLAMA_TTFT_MS: value,
    CLAUDE_PROXY_STREAM_STALL_MS: value,
    CLAUDE_PROXY_STREAM_WALL_MS: value,
  };
}

function modelHttpJson(port, method, urlPath, body, extraHeaders = {}) {
  return httpJson(port, method, urlPath, body, extraHeaders, modelTestTimeoutMs());
}

function modelHttpStream(port, method, urlPath, body, extraHeaders = {}) {
  return httpStream(port, method, urlPath, body, extraHeaders, modelTestTimeoutMs());
}

function withModelTestProxy(opts, fn) {
  const modelEnv = modelTestProxyEnv();
  const merged = Object.assign({}, opts, {
    env: Object.assign({}, modelEnv, opts.env || {}),
  });
  return withProxy(merged, fn);
}

const TIER_TIMEOUTS_MS = {
  'judge':              600_000,
  'judge-strict':       600_000,
  'implementer-heavy':   300_000,
  'test-writer-heavy': 300_000,
  'code-analyst':      300_000,
  'deep-coder':        300_000,
  'pattern-coder':     600_000,
  'orchestrator':      600_000,
  'local-planner':     600_000,
};

function tierTimeout(tier, fallback = 180_000) {
  return modelTestTimeoutMs(TIER_TIMEOUTS_MS[tier] || fallback);
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
//
// A genuine unhandledRejection BEFORE the suite computes its verdict is a real
// failure — fail loud (exit 1) so a swallowed async error can't pass silently.
//
// But once summary() has run the verdict is COMMITTED and the suite is about to
// call its own `process.exit(failed > 0 ? 1 : 0)`. A stray late rejection in
// that window (e.g. a teardown timer or an aborted in-flight socket settling
// after the result) must NOT call process.exit(1): doing so would FLIP a green
// suite to red (false failure) and races the suite's authoritative gated exit.
// After the result is computed we therefore log the late rejection prominently
// (so it's never invisible) but leave the suite's own exit code intact.
process.on('unhandledRejection', err => {
  if (_resultComputed) {
    console.error('unhandledRejection AFTER summary() (verdict already committed; not flipping exit code):', err);
    return;
  }
  console.error('unhandledRejection:', err);
  process.exit(1);
});

module.exports = {
  assert,
  assertEq,
  skip,
  summary,
  makeIsolatedTmpDir,
  withTmpDir,
  writeConfig,
  writeConfigFresh,
  getFreePort,
  startStubServer,
  spawnCapture,
  spawnProxy,
  DEFAULT_HERMETIC_READY_TIMEOUT_MS,
  DEFAULT_HERMETIC_REQUEST_TIMEOUT_MS,
  waitForPing,
  httpJson,
  terminateAndReap,
  withProxy,
  assertLogContains,
  collectStderr,
  stubBackend,
  streamingStubBackend,
  ollamaStubBackend,
  classifierStub,
  httpStream,
  modelTestTimeoutMs,
  hasActiveModelTestSupervisor,
  ensureModelTestSupervisor,
  modelTestProxyEnv,
  modelHttpJson,
  modelHttpStream,
  withModelTestProxy,
  boundedDiagnosticSnippet,
  parseStatusBlock,
  parseAgentContractResult,
  tierTimeout,
  registerTmpDir,
  cleanupTmpDirs,
  installExitHandlers,
  stripBehavioralContract,
};
