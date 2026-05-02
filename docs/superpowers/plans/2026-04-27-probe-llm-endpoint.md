# Probe-LLM Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET /v1/probe-llm[?model=<name>]` to the proxy — it fires a hardcoded diagnostic question at the resolved Ollama model and returns the text response as JSON.

**Architecture:** A standalone `handleProbeLlm` async function is added to `tools/claude-proxy` and wired into the existing request-router `if/else if` chain (before the `/v1/messages` route). It uses the same `resolveBackend()` + `http.request()` primitives already in the file, makes a non-streaming Ollama `/api/chat` call, and returns `{ ok, model_used, backend, response, elapsed_ms }`. The `?model` query param overrides the default route.

**Tech Stack:** Node.js stdlib only (no new deps). Tests use existing `test/helpers.js` helpers (`withProxy`, `ollamaStubBackend`, `httpJson`).

---

## Files

- **Modify:** `tools/claude-proxy` — add `handleProbeLlm` function and one router entry
- **Create:** `test/proxy-probe-llm.test.js` — 5 test cases
- **Modify:** `test/run-all.sh` — register the new test file

---

### Task 1: Write failing tests

**Files:**
- Create: `test/proxy-probe-llm.test.js`

- [ ] **Step 1: Create the test file**

```javascript
#!/usr/bin/env node
'use strict';
// Tests for GET /v1/probe-llm[?model=<name>]
// Run: node test/proxy-probe-llm.test.js

const http = require('http');
const {
  assert, assertEq, summary,
  writeConfig, withProxy, ollamaStubBackend, httpJson,
} = require('./helpers');

console.log('proxy /v1/probe-llm tests\n');

// Minimal stub: returns a single non-streaming Ollama response.
// ollamaStubBackend sends ndjson by default; we need the stub to also handle
// stream:false. The existing stub honours the `stream` field in the request body —
// stream:false returns a single JSON object (not ndjson).
function probeConfig(stubPort, modelName = 'probe-model') {
  return {
    backends: {
      probe_stub: { kind: 'ollama', url: `http://127.0.0.1:${stubPort}` },
    },
    routes: { default: modelName },
    model_routes: { [modelName]: 'probe_stub' },
    llm_profiles: {
      '128gb': {
        workhorse: { connected_model: modelName, disconnect_model: modelName },
      },
    },
  };
}

async function main() {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-probe-'));

  // Stub chunks — one content chunk + done frame.
  const stubChunks = [
    { message: { content: 'I am TestBot, made by StubCo.', thinking: '' } },
    { done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 10 },
  ];

  try {
    // ── Test 1: default model (no ?model param) ─────────────────────────────
    console.log('1. default model — uses routes.default');
    {
      const stub = await ollamaStubBackend(stubChunks);
      try {
        const configPath = writeConfig(tmpDir, probeConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'GET', '/v1/probe-llm');
          assertEq(r.status, 200, 'status 200');
          assertEq(r.body.ok, true, 'ok: true');
          assertEq(r.body.model_used, 'probe-model', 'model_used matches');
          assertEq(r.body.backend, 'probe_stub', 'backend id present');
          assert(typeof r.body.response === 'string' && r.body.response.length > 0, 'response is non-empty string');
          assert(typeof r.body.elapsed_ms === 'number', 'elapsed_ms is a number');
        });
      } finally { await stub.close(); }
    }

    // ── Test 2: ?model query param overrides default ─────────────────────────
    console.log('2. ?model=custom-model — overrides default route');
    {
      const stub = await ollamaStubBackend(stubChunks);
      try {
        const cfg = {
          backends: { probe_stub: { kind: 'ollama', url: `http://127.0.0.1:${stub.port}` } },
          routes: { default: 'other-model' },
          model_routes: {
            'other-model': 'probe_stub',
            'custom-model': 'probe_stub',
          },
          llm_profiles: {
            '128gb': { workhorse: { connected_model: 'other-model', disconnect_model: 'other-model' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'GET', '/v1/probe-llm?model=custom-model');
          assertEq(r.status, 200, 'status 200');
          assertEq(r.body.model_used, 'custom-model', 'model_used is the override');
        });
      } finally { await stub.close(); }
    }

    // ── Test 3: no default route and no ?model → 400 ─────────────────────────
    console.log('3. no model, no default route → 400');
    {
      const stub = await ollamaStubBackend(stubChunks);
      try {
        const cfg = {
          backends: { probe_stub: { kind: 'ollama', url: `http://127.0.0.1:${stub.port}` } },
          model_routes: { 'some-model': 'probe_stub' },
          llm_profiles: {
            '128gb': { workhorse: { connected_model: 'some-model', disconnect_model: 'some-model' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'GET', '/v1/probe-llm');
          assertEq(r.status, 400, 'status 400');
          assertEq(r.body.ok, false, 'ok: false');
          assert(typeof r.body.error === 'string', 'error message present');
        });
      } finally { await stub.close(); }
    }

    // ── Test 4: ?model resolves to unknown model → 400 ───────────────────────
    console.log('4. ?model=nonexistent → 400 (model not in routes)');
    {
      const stub = await ollamaStubBackend(stubChunks);
      try {
        const configPath = writeConfig(tmpDir, probeConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'GET', '/v1/probe-llm?model=nonexistent-xyz');
          assertEq(r.status, 400, 'status 400');
          assertEq(r.body.ok, false, 'ok: false');
        });
      } finally { await stub.close(); }
    }

    // ── Test 5: stub returns non-200 → 502 ───────────────────────────────────
    console.log('5. ollama returns 404 → 502');
    {
      // Custom stub that always returns 404
      const badStub = await new Promise((resolve, reject) => {
        const s = http.createServer((req, res) => {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'model not found' }));
        });
        s.listen(0, '127.0.0.1', () => resolve(s));
        s.on('error', reject);
      });
      try {
        const cfg = {
          backends: { bad_stub: { kind: 'ollama', url: `http://127.0.0.1:${badStub.address().port}` } },
          routes: { default: 'probe-model' },
          model_routes: { 'probe-model': 'bad_stub' },
          llm_profiles: { '128gb': { workhorse: { connected_model: 'probe-model', disconnect_model: 'probe-model' } } },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'GET', '/v1/probe-llm');
          assertEq(r.status, 502, 'status 502');
          assertEq(r.body.ok, false, 'ok: false');
        });
      } finally { await new Promise(r => badStub.close(r)); }
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  summary();
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Check that `httpJson` exists in helpers**

```bash
grep -n "^function httpJson\|^async function httpJson\|exports.*httpJson" /Users/dadleet/src/c-thru/test/helpers.js
```

Expected: a line showing `httpJson` is exported. If it is NOT present, add this to `test/helpers.js` just before the `module.exports` block:

```javascript
// Simple JSON GET/POST helper — returns { status, body } (body is parsed JSON).
async function httpJson(port, method, urlPath, reqBody) {
  return new Promise((resolve, reject) => {
    const bodyStr = reqBody ? JSON.stringify(reqBody) : null;
    const opts = {
      hostname: '127.0.0.1', port, method, path: urlPath,
      headers: { 'content-type': 'application/json', ...(bodyStr ? { 'content-length': Buffer.byteLength(bodyStr) } : {}) },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let body; try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
```

And add `httpJson` to the `module.exports` at the bottom of `test/helpers.js`.

- [ ] **Step 3: Run the test — verify it fails with "not found" or connection error**

```bash
node test/proxy-probe-llm.test.js 2>&1 | tail -20
```

Expected: FAIL — the endpoint doesn't exist yet, so you'll see 404 responses or assertion failures on `r.status`.

- [ ] **Step 4: Commit the failing test**

```bash
git add test/proxy-probe-llm.test.js test/helpers.js
git commit -m "test(proxy): add failing tests for GET /v1/probe-llm endpoint"
```

---

### Task 2: Implement `GET /v1/probe-llm` in claude-proxy

**Files:**
- Modify: `tools/claude-proxy`

The implementation has two parts: a handler function and one router line.

- [ ] **Step 1: Read the area just before `/v1/messages` route (~line 1805–1812)**

```bash
grep -n "v1/active-models\|v1/messages\|v1/probe" tools/claude-proxy | head -10
```

This confirms the exact line numbers where you'll insert the new route.

- [ ] **Step 2: Add `handleProbeLlm` function**

Find the `handleOllamaNonStream` function (currently around line 1427). Insert the following new function **immediately before** `handleOllamaNonStream`:

```javascript
const PROBE_QUESTION = 'What is your model name, model id, where were you born, and who made you?';

async function handleProbeLlm(req, res) {
  const tier = resolveActiveTier(CONFIG);
  const mode = resolveLlmMode(CONFIG);

  let modelParam = null;
  try { modelParam = new URL(req.url, 'http://x').searchParams.get('model') || null; } catch {}

  const modelName = modelParam || (CONFIG.routes && CONFIG.routes.default) || null;
  if (!modelName) {
    return send(res, 400, { ok: false, error: 'no model specified and no default route configured' });
  }

  const resolved = resolveBackend(modelName, CONFIG, tier, mode);
  if (resolved.error) {
    return send(res, 400, { ok: false, error: resolved.error });
  }

  const { backend, effectiveModel } = resolved;
  if ((backend.kind || 'anthropic') !== 'ollama') {
    return send(res, 400, { ok: false, error: `probe only supports ollama backends; '${backend.id}' is kind '${backend.kind || 'anthropic'}'` });
  }

  const ollamaBody = JSON.stringify({
    model: effectiveModel,
    messages: [{ role: 'user', content: PROBE_QUESTION }],
    stream: false,
    keep_alive: OLLAMA_KEEP_ALIVE,
    options: { num_ctx: 4096 },
  });

  const startedAt = Date.now();
  const url = backend.url.replace(/\/$/, '') + '/api/chat';

  return new Promise(resolve => {
    const up = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, upRes => {
      let body = '';
      upRes.on('data', c => { body += c.toString(); });
      upRes.on('end', () => {
        if (upRes.statusCode !== 200) {
          send(res, 502, { ok: false, error: `ollama returned ${upRes.statusCode}`, backend: backend.id });
          return resolve();
        }
        let parsed;
        try { parsed = JSON.parse(body); } catch {
          send(res, 502, { ok: false, error: 'ollama returned invalid JSON', backend: backend.id });
          return resolve();
        }
        send(res, 200, {
          ok: true,
          model_used: effectiveModel,
          backend: backend.id,
          response: (parsed.message && parsed.message.content) || '',
          elapsed_ms: Date.now() - startedAt,
        });
        resolve();
      });
    });
    up.setTimeout(15000, () => { up.destroy(new Error('probe timeout')); });
    up.on('error', e => {
      send(res, 502, { ok: false, error: `ollama unreachable: ${e.message}`, backend: backend.id });
      resolve();
    });
    up.write(ollamaBody);
    up.end();
  });
}
```

- [ ] **Step 3: Add the router entry**

In the `if/else if` routing chain, find the `GET /v1/active-models` check (around line 1805). Insert the following **immediately after** the `active-models` block and **before** the `/v1/messages` block:

```javascript
      if (req.method === 'GET' && req.url.startsWith('/v1/probe-llm')) {
        return handleProbeLlm(req, res);
      }
```

- [ ] **Step 4: Verify node syntax**

```bash
node --check tools/claude-proxy
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add tools/claude-proxy
git commit -m "feat(proxy): add GET /v1/probe-llm diagnostic endpoint"
```

---

### Task 3: Verify tests pass and register in run-all

**Files:**
- Modify: `test/run-all.sh`

- [ ] **Step 1: Run the probe test suite**

```bash
node test/proxy-probe-llm.test.js
```

Expected: `5 passed, 0 failed`

- [ ] **Step 2: Run the broader proxy test suite to check for regressions**

```bash
node test/proxy-messages.test.js && node test/proxy-active-models.test.js && node test/proxy-streaming-ollama.test.js
```

Expected: all exit 0.

- [ ] **Step 3: Register in run-all.sh**

Find the line in `test/run-all.sh` that registers `proxy-active-models.test.js` (or another adjacent proxy test). Add the probe test on the next line following the same pattern. The file uses `run_test` or direct `node` calls — match the existing style exactly.

- [ ] **Step 4: Run full suite**

```bash
bash test/run-all.sh 2>&1 | tail -20
```

Expected: `proxy-probe-llm.test.js` appears in output and exits 0. Overall pass count increases by 5.

- [ ] **Step 5: Commit**

```bash
git add test/run-all.sh
git commit -m "test(proxy): register proxy-probe-llm.test.js in run-all.sh"
```

---

## Verification

```bash
# Syntax
node --check tools/claude-proxy

# All probe tests
node test/proxy-probe-llm.test.js

# Full suite
bash test/run-all.sh 2>&1 | tail -20

# Manual smoke test (requires running proxy on port 9876):
curl -s "http://localhost:9876/v1/probe-llm" | jq .
curl -s "http://localhost:9876/v1/probe-llm?model=qwen3.5:9b" | jq .
```

Expected JSON shape:
```json
{
  "ok": true,
  "model_used": "qwen3.5:9b",
  "backend": "ollama_local",
  "response": "I am Qwen 3.5...",
  "elapsed_ms": 842
}
```

---

## Notes

- `resolveBackend` returns `{ error, status }` on failure — always check `.error` before destructuring.
- `backend.kind` defaults to `'anthropic'` when absent (per CLAUDE.md). The probe only supports `kind: 'ollama'` since Anthropic requires auth headers we don't want to forward.
- The 15s `up.setTimeout` on the probe request is intentional — probes are diagnostic, not interactive. A hung probe should fail fast.
- The `PROBE_QUESTION` constant is module-level so it appears in logs and is easy to change without hunting through the function body.
