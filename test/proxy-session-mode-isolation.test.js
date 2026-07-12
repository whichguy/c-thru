#!/usr/bin/env node
'use strict';
// Round-5 Phase B2 regression: per-session mode isolation on a shared proxy.
//
// Pre-fix, POST /c-thru/mode mutated process.env.CLAUDE_LLM_MODE — global,
// unpinned mutable state. One session's mode switch instantly rerouted every
// other session sharing the proxy, including requests already in flight.
//
// Fix: a real Claude Code client's actual /v1/messages traffic preserves a
// `/s/<session-id>` path prefix on ANTHROPIC_BASE_URL (verified live via a
// canary against the real vendor binary — see round-5 plan notes), so the
// proxy strips + trusts that prefix as session identity, keeps a per-session
// mode map (POST /s/<id>/c-thru/mode), and resolves+pins the mode ONCE per
// request into an AsyncLocalStorage-backed store (session -> global override
// -> resolveLlmMode's own env/config fallback for unkeyed/CLI callers).
//
// Run: node test/proxy-session-mode-isolation.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, httpStream,
} = require('./helpers');

console.log('proxy session-mode isolation tests\n');

// Two full mode graphs so switching mode actually changes the resolved model
// — best-cloud -> workhorse-a, best-cloud-oss -> workhorse-b. Slow enough to
// hold open for the in-flight test (streamed with an artificial delay via a
// stub backend below).
function baseConfig(stubPort) {
  return {
    endpoints: { anthropic: { kind: 'anthropic', format: 'anthropic', url: `http://127.0.0.1:${stubPort}`, auth: 'none' } },
    llm_profiles: {
      workhorse: {
        'best-cloud': { '64gb': 'model-best-cloud' },
        'best-cloud-oss': { '64gb': 'model-best-cloud-oss' },
      },
    },
    model_routes: { 'model-best-cloud': 'anthropic', 'model-best-cloud-oss': 'anthropic' },
    agent_to_capability: { workhorse: 'workhorse' },
  };
}

// Stub Anthropic backend: echoes back the requested model in its response so
// tests can observe which model a request actually resolved to. Supports an
// optional artificial delay (ms) for the in-flight-pin test, and a request
// log for inspecting what was actually dispatched.
function modelEchoStub({ delayMs = 0 } = {}) {
  const http = require('http');
  const seen = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch {}
      seen.push({ model: body.model, url: req.url });
      const respond = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_echo', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: `served-by:${body.model}` }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 2 },
        }));
      };
      if (delayMs > 0) setTimeout(respond, delayMs); else respond();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port, seen,
      close: () => new Promise(r => server.close(r)),
    }));
    server.on('error', reject);
  });
}

async function messagesReq(port, sessionPrefix, timeout = 5000) {
  return httpStream(port, 'POST', `${sessionPrefix}/v1/messages`, {
    model: 'workhorse', stream: false, max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  }, {}, timeout);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-session-mode-'));

  try {
    // ── 1. Two-session isolation ─────────────────────────────────────────
    console.log('1. Two sessions on one proxy: mode switch is isolated per session');
    {
      const stub = await modelEchoStub();
      try {
        const cfg = baseConfig(stub.port);
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'best-cloud' }, async ({ port }) => {
          // Both sessions start on the proxy's default (best-cloud).
          const beforeA = await httpJson(port, 'GET', '/s/session-a/ping');
          const beforeB = await httpJson(port, 'GET', '/s/session-b/ping');
          assertEq(beforeA.json.active_mode, 'best-cloud', 'session A starts on best-cloud');
          assertEq(beforeB.json.active_mode, 'best-cloud', 'session B starts on best-cloud');

          // Session A switches to best-cloud-oss via its OWN prefix.
          const switchA = await httpJson(port, 'POST', '/s/session-a/c-thru/mode', { mode: 'best-cloud-oss' });
          assertEq(switchA.status, 200, 'session A mode-switch succeeds');
          assertEq(switchA.json.scope, 'session', 'mode-switch reports session scope');

          // Session A now resolves to best-cloud-oss; session B is UNCHANGED.
          const afterA = await httpJson(port, 'GET', '/s/session-a/ping');
          const afterB = await httpJson(port, 'GET', '/s/session-b/ping');
          assertEq(afterA.json.active_mode, 'best-cloud-oss', 'session A now on best-cloud-oss');
          assertEq(afterB.json.active_mode, 'best-cloud', 'session B STILL on best-cloud (isolated)');

          // Bare/unkeyed /ping reports the global default, untouched by A's switch.
          const bare = await httpJson(port, 'GET', '/ping');
          assertEq(bare.json.active_mode, 'best-cloud', 'unkeyed /ping reports the global default, unaffected');

          // Actual routing follows the session's mode: A dispatches to the
          // best-cloud-oss model, B still dispatches to best-cloud.
          const reqA = await messagesReq(port, '/s/session-a');
          const reqB = await messagesReq(port, '/s/session-b');
          const bodyA = JSON.parse(reqA.rawBody);
          const bodyB = JSON.parse(reqB.rawBody);
          assertEq(bodyA.content[0].text, 'served-by:model-best-cloud-oss', 'session A request actually routed via best-cloud-oss');
          assertEq(bodyB.content[0].text, 'served-by:model-best-cloud', 'session B request actually routed via best-cloud (isolated)');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── 2. In-flight pin: mode switch mid-request doesn't affect it ──────
    console.log('\n2. In-flight request is pinned to the mode active when it started');
    {
      const stub = await modelEchoStub({ delayMs: 600 });
      try {
        const cfg = baseConfig(stub.port);
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'best-cloud' }, async ({ port }) => {
          // Start a slow request under session A (currently best-cloud)...
          const slow = messagesReq(port, '/s/session-a', 8000);
          // ...then, while it's in flight, switch session A's mode.
          await new Promise(r => setTimeout(r, 100));
          const sw = await httpJson(port, 'POST', '/s/session-a/c-thru/mode', { mode: 'best-cloud-oss' });
          assertEq(sw.status, 200, 'mid-flight mode switch itself succeeds');
          const result = await slow;
          const body = JSON.parse(result.rawBody);
          assertEq(body.content[0].text, 'served-by:model-best-cloud',
            'in-flight request completed on the mode active when it STARTED, not the mid-flight switch');

          // A NEW request after the switch uses the new mode.
          const after = await messagesReq(port, '/s/session-a');
          const afterBody = JSON.parse(after.rawBody);
          assertEq(afterBody.content[0].text, 'served-by:model-best-cloud-oss',
            'a new request after the switch uses the new mode');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── 3. Unkeyed backward-compat ────────────────────────────────────────
    console.log('\n3. Unkeyed (no /s/ prefix) client: identical to pre-B2 behavior');
    {
      const stub = await modelEchoStub();
      try {
        const cfg = baseConfig(stub.port);
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'best-cloud' }, async ({ port }) => {
          const before = await httpJson(port, 'GET', '/ping');
          assertEq(before.json.active_mode, 'best-cloud', 'unkeyed client starts on the launch mode');

          // A bare (unkeyed) mode switch sets the GLOBAL default — visible to
          // every unkeyed client, exactly like the pre-B2 env-mutation did.
          const sw = await httpJson(port, 'POST', '/c-thru/mode', { mode: 'best-cloud-oss' });
          assertEq(sw.status, 200, 'bare mode-switch succeeds');
          assertEq(sw.json.scope, 'global', 'bare mode-switch reports global scope');

          const after = await httpJson(port, 'GET', '/ping');
          assertEq(after.json.active_mode, 'best-cloud-oss', 'unkeyed /ping reflects the bare switch');

          const req = await messagesReq(port, '');
          const body = JSON.parse(req.rawBody);
          assertEq(body.content[0].text, 'served-by:model-best-cloud-oss', 'unkeyed request routes via the new global mode');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── 4. Reload invalidation: global override ───────────────────────────
    console.log('\n4. Config reload dropping the active GLOBAL override mode: loud advisory, no crash');
    {
      const stub = await modelEchoStub();
      try {
        const cfg = Object.assign(baseConfig(stub.port), {
          custom_modes: { 'temp-mode': { base: 'best-cloud' } },
        });
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'best-cloud' }, async ({ port }) => {
          const sw = await httpJson(port, 'POST', '/c-thru/mode', { mode: 'temp-mode' });
          assertEq(sw.status, 200, 'switch to custom mode succeeds');

          const beforeStatus = await httpJson(port, 'GET', '/c-thru/status');
          assertEq(beforeStatus.json.mode_degraded, false, 'not degraded before reload');

          // Rewrite config WITHOUT temp-mode, then reload.
          const cfgNoCustom = baseConfig(stub.port);
          fs.writeFileSync(configPath, JSON.stringify(cfgNoCustom, null, 2));
          const reload = await httpJson(port, 'POST', '/c-thru/reload', {});
          assertEq(reload.status, 200, 'reload succeeds');

          const afterStatus = await httpJson(port, 'GET', '/c-thru/status');
          assertEq(afterStatus.json.mode_degraded, true, 'global mode_degraded true after orphaning reload');
          assert(afterStatus.json.mode_degraded_detail && afterStatus.json.mode_degraded_detail.was_mode === 'temp-mode',
            'mode_degraded_detail names the orphaned global mode');

          // Fail-open: still serves requests (falls back to best-cloud).
          const req = await messagesReq(port, '');
          assertEq(req.status, 200, 'still serves requests after orphaning (fail-open)');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── 5. Reload invalidation: session-scoped override ───────────────────
    console.log('\n5. Config reload dropping a SESSION\'s custom mode: session-scoped advisory, other sessions unaffected');
    {
      const stub = await modelEchoStub();
      try {
        const cfg = Object.assign(baseConfig(stub.port), {
          custom_modes: { 'sess-temp-mode': { base: 'best-cloud' } },
        });
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'best-cloud' }, async ({ port }) => {
          const swA = await httpJson(port, 'POST', '/s/session-a/c-thru/mode', { mode: 'sess-temp-mode' });
          assertEq(swA.status, 200, 'session A switches to the custom mode');
          // Session B stays on the default the whole time.

          const cfgNoCustom = baseConfig(stub.port);
          fs.writeFileSync(configPath, JSON.stringify(cfgNoCustom, null, 2));
          await httpJson(port, 'POST', '/c-thru/reload', {});

          const statusA = await httpJson(port, 'GET', '/s/session-a/c-thru/status');
          const statusB = await httpJson(port, 'GET', '/s/session-b/c-thru/status');
          assertEq(statusA.json.session_mode_degraded, true, 'session A reports session_mode_degraded: true');
          assert(statusA.json.session_mode_degraded_detail && statusA.json.session_mode_degraded_detail.was_mode === 'sess-temp-mode',
            'session A detail names the orphaned session mode');
          assertEq(statusB.json.session_mode_degraded, false, 'session B (never used the custom mode) reports false');
          // Global scope is untouched by a session-only orphaning.
          assertEq(statusA.json.mode_degraded, false, 'global mode_degraded stays false — only the session was orphaned');
        });
      } finally { await stub.close().catch(() => {}); }
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
