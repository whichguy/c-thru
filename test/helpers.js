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

// assertEq(actual, expected, label) — generates "(got actual)" automatically.
// Use instead of assert(actual === expected, `label (got ${actual})`).
function assertEq(actual, expected, label) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
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
// opts: { configPath, profile, mode, hooksPort, env, cwd }
// Does NOT pass --port so the proxy prints "READY <port>" on stdout.
async function spawnProxy(opts = {}) {
  const { configPath, profile, mode, hooksPort, env: extraEnv = {}, cwd } = opts;

  const args = [];
  if (configPath) args.push('--config', configPath);
  if (profile)    args.push('--profile', profile);
  if (mode)       args.push('--mode', mode);

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
//
// Options:
//   failWith: <statusCode>  — respond with this HTTP status on every request (e.g. 502)
//                              instead of 200. Used by fallback/hard_fail tests.
//   responseBody: <obj>     — override the JSON body returned (200 path only).
function stubBackend(opts = {}) {
  const { failWith, responseBody } = opts;
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
  'judge':              600_000,
  'judge-strict':       600_000,
  'deep-coder-cloud':   300_000,
  'code-analyst-cloud': 300_000,
  'code-analyst':      300_000,
  'deep-coder':        300_000,
  'pattern-coder':     600_000,
  'orchestrator':      600_000,
  'local-planner':     600_000,
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
  assertEq,
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
  streamingStubBackend,
  ollamaStubBackend,
  classifierStub,
  httpStream,
  parseStatusBlock,
  tierTimeout,
  registerTmpDir,
  cleanupTmpDirs,
  installExitHandlers,
  stripBehavioralContract,
};
