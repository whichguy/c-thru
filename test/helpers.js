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

function summary() {
  const total = _passed + _failed;
  const skipNote = _skipped ? ` (${_skipped} skipped)` : '';
  console.log(`\n${_passed}/${total} passed${skipNote}${_failed ? ` — ${_failed} FAILED` : ''}`);
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

// Polls the proxy's /ping endpoint until it returns 200, or `timeoutMs` elapses.
// Per-attempt timeout grows from 250ms → 1500ms (catches slow first-bind on
// loaded machines without burning the whole budget on the happy-path first
// try). Backoff between attempts grows similarly: 30/60/120/250/500ms capped.
// ECONNREFUSED retries immediately (next event-loop tick) since that
// definitively means "listener not up yet" and we shouldn't sleep on it.
function waitForPing(port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const lastError = { kind: null, message: null };
    let attemptCount = 0;
    const perAttemptTimeouts = [250, 500, 750, 1000, 1500];
    const backoffMs        = [30, 60, 120, 250, 500];
    function attempt() {
      const idx = Math.min(attemptCount, perAttemptTimeouts.length - 1);
      attemptCount++;
      const req = http.request({ hostname: '127.0.0.1', port, path: '/ping', method: 'GET' }, res => {
        // Drain so the socket can be released even on non-200.
        res.resume();
        if (res.statusCode === 200) return resolve();
        lastError.kind = 'status';
        lastError.message = `status=${res.statusCode}`;
        schedule(false);
      });
      req.on('error', (err) => {
        lastError.kind = err.code || 'error';
        lastError.message = err.message;
        // ECONNREFUSED = listener not bound yet. Retry on next tick instead
        // of waiting full backoff — saves up to 500ms during proxy startup.
        schedule(err.code === 'ECONNREFUSED');
      });
      req.setTimeout(perAttemptTimeouts[idx], () => {
        lastError.kind = 'timeout';
        lastError.message = `per-attempt timeout ${perAttemptTimeouts[idx]}ms`;
        req.destroy();
      });
      req.end();
    }
    function schedule(immediate) {
      if (Date.now() >= deadline) {
        return reject(new Error(
          `waitForPing: timed out after ${timeoutMs}ms (last: ${lastError.kind || 'none'} ${lastError.message || ''})`,
        ));
      }
      if (immediate) return setImmediate(attempt);
      const idx = Math.min(attemptCount - 1, backoffMs.length - 1);
      setTimeout(attempt, backoffMs[Math.max(0, idx)]);
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
  // Optional custom handler. If set and returns truthy, the stub yields request
  // handling to it (no default 200 response is sent). Used by translation tests
  // that need protocol-specific response shapes (e.g., Gemini SSE).
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
  'implementer-heavy':   300_000,
  'test-writer-heavy': 300_000,
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
  skip,
  summary,
  withTmpDir,
  writeConfig,
  writeConfigFresh,
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
