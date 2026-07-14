#!/usr/bin/env node
'use strict';
// Part-2 contract: tools/c-thru-session-start.sh is the SINGLE canonical injector
// of the proxy's control-plane block. It curls POST /hooks/context and prepends
// the returned additionalContext to its emitted SessionStart context.
//
// Node port of the former session-start-injection.test.sh — same recipe, now on
// the shared test/helpers.js harness (startStubServer + assert/skip/summary):
// a scratch repo holding ONLY the hook (so first-run seeding / pollution /
// git-divergence checks are all inert — no config dir, no model-map-config.js,
// not a git checkout), plus a stub HTTP server standing in for the proxy.
//
// Cases:
//   B1  proxy up → block injected once; stub saw POST /hooks/context and NO
//       GET /ping (the #3 regression lock — the double-curl was collapsed into
//       a single /hooks/context probe).
//   B2  proxy down (closed port) → no block, "proxy down" advisory, exit 0.
//   B3  proxy up + Ollama down → block AND advisory, block first.
//   B4  jq forced absent (minimal PATH) → node fallback yields the same block.
//   B5  slow /hooks/context → hook honors --max-time 2 (bounded wall-time, exit 0).
//
// Run: node test/session-start-injection.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const {
  assert, assertEq, skip, summary, getFreePort, startStubServer, spawnCapture,
} = require('./helpers');

const REPO_DIR    = path.join(__dirname, '..');
const HOOK_SOURCE = path.join(REPO_DIR, 'tools', 'c-thru-session-start.sh');
// The hook sources the shared resolver lib from $ROUTER_REPO_ROOT/tools/ — it
// must be co-located in the scratch tree (as it is in every real deployment).
const LIB_SOURCE  = path.join(REPO_DIR, 'tools', 'c-thru-lib.sh');

console.log('session-start-injection (Node port: proxy /hooks/context block injected once)\n');

// Resolve a tool's absolute path via the host shell (so a minimal-PATH child
// can't hide the launcher itself). Returns '' when absent.
function which(tool) {
  const r = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}
const BASH = which('bash') || 'bash';
const SH   = which('sh')   || 'sh';

// The canonical control-plane block a real proxy returns, built from a given
// port (mirrors the proxy's own POST /hooks/context output).
function blockFor(port) {
  return [
    `(c-thru) proxy control plane: http://127.0.0.1:${port} — query with curl:`,
    `  GET /c-thru/status (routes, per-model usage, cooldowns)`,
    `  GET /c-thru/recent?n=N (recent requests: served model, tokens, latency, errors)`,
    `  GET /c-thru/dashboard (live HTML stats — open in a browser)`,
    `Profile: stub-tier, Mode: connected. Dashboard: http://127.0.0.1:${port}/c-thru/dashboard`,
  ].join('\n');
}

async function main() {
  // ── Scratch repo: ONLY the hook (seeding/pollution/git checks all skip) ─────
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-injection-'));
  const scratchTools = path.join(base, 'scratch', 'tools');
  fs.mkdirSync(scratchTools, { recursive: true });
  const scratchHook = path.join(scratchTools, 'c-thru-session-start.sh');
  fs.copyFileSync(HOOK_SOURCE, scratchHook);
  fs.copyFileSync(LIB_SOURCE, path.join(scratchTools, 'c-thru-lib.sh'));
  const profileDir = path.join(base, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  // Build the hook's env: plugin-mode shape (discovery from ANTHROPIC_BASE_URL),
  // with OLLAMA_URL/OLLAMA_BASE_URL/CLAUDE_PROXY_PORT scrubbed unless overridden.
  function hookEnv(extra = {}) {
    const env = Object.assign({}, process.env);
    delete env.OLLAMA_URL;
    delete env.OLLAMA_BASE_URL;
    delete env.CLAUDE_PROXY_PORT;
    delete env.C_THRU_SESSION_ID;
    delete env.C_THRU_SESSION_SCOPED_MODE;
    return Object.assign(env, { CLAUDE_PROFILE_DIR: profileDir }, extra);
  }

  // Async (spawnCapture, NOT spawnSync): the hook curls the in-process stub, so
  // this process's event loop must stay free to answer it.
  async function runHook(env, stdinPayload) {
    let r;
    if (stdinPayload === undefined) {
      r = await spawnCapture(BASH, [scratchHook], { env, timeout: 15000 });
    } else {
      r = await new Promise((resolve, reject) => {
        const child = spawn(BASH, [scratchHook], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 15000);
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('error', err => { clearTimeout(timer); reject(err); });
        child.on('close', (status, signal) => {
          clearTimeout(timer);
          resolve({ status, signal, stdout, stderr });
        });
        child.stdin.end(stdinPayload);
      });
    }
    let addl = '';
    try { addl = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch {}
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', addl };
  }

  const jqOnHost = which('jq') !== '';

  // Stub proxy used by B1/B3/B4: answers POST /hooks/context with the canonical
  // block built from its own port. No /ping route — the hook must not need one.
  const upContext = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: blockFor(upStub.port) },
    }));
  };
  const upStub = await startStubServer({
    'POST /hooks/context': upContext,
    'POST /s/ss-sess-1/hooks/context': upContext,
  });

  // Slow stub for B5: stalls /hooks/context ~10s (cleared if the client aborts).
  const slowStub = await startStubServer({
    'POST /hooks/context': (req, res) => {
      const t = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '(c-thru) proxy control plane: SLOW' },
        }));
      }, 10000);
      res.on('close', () => clearTimeout(t));
    },
  });

  try {
    // ── B1: proxy up → merged context carries the block exactly once ──────────
    console.log('B1. proxy up → block injected once; stub saw POST /hooks/context, no GET /ping');
    const b1 = await runHook(hookEnv({ ANTHROPIC_BASE_URL: upStub.url }));
    assertEq(b1.status, 0, `hook exits 0 (stderr: ${b1.stderr.slice(0, 200)})`);
    assert(b1.addl.includes(`http://127.0.0.1:${upStub.port}`), 'proxy base URL present');
    assert(b1.addl.includes('/c-thru/status'),    'lists /c-thru/status');
    assert(b1.addl.includes('/c-thru/recent'),    'lists /c-thru/recent');
    assert(b1.addl.includes('/c-thru/dashboard'), 'lists /c-thru/dashboard');
    assert(b1.addl.includes(`http://127.0.0.1:${upStub.port}/c-thru/dashboard`), 'carries the dashboard_url');
    const b1BlockCount = (b1.addl.match(/proxy control plane/g) || []).length;
    assertEq(b1BlockCount, 1, 'proxy block injected exactly once (no double-injection)');

    // #3 regression lock: the collapsed probe hits /hooks/context only — never /ping.
    const sawPing  = upStub.requests.some(r => r.method === 'GET'  && r.path === '/ping');
    const sawHooks = upStub.requests.some(r => r.method === 'POST' && r.path === '/hooks/context');
    assert(!sawPing,  'stub saw NO GET /ping (double-curl collapsed — #3 regression lock)');
    assert(sawHooks,  'stub saw POST /hooks/context (the single canonical probe)');
    const sawSessionStartEvent = upStub.requests.some(
      r => r.method === 'POST' && r.path === '/hooks/context' && r.body && r.body.event === 'SessionStart'
    );
    assert(sawSessionStartEvent, 'POST /hooks/context body carries event=SessionStart (long-variant channel)');

    // ── B2: proxy down (closed port) → no block, advisory, exit 0 ─────────────
    // C_THRU_NO_RESURRECT=1 so ensure-proxy cannot spawn a real proxy on the free
    // port (scratch has no ensure script either; flag pins the advisory path).
    console.log('\nB2. proxy down → no block, proxy-down advisory, hook exits 0');
    const closedProxyPort = await getFreePort();   // bound-then-freed → definitively closed
    const b2 = await runHook(hookEnv({
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${closedProxyPort}`,
      C_THRU_NO_RESURRECT: '1',
    }));
    assertEq(b2.status, 0, `hook exits 0 when proxy is down (stderr: ${b2.stderr.slice(0, 200)})`);
    assert(!b2.addl.includes('proxy control plane'), 'no proxy block when proxy is down');
    assert(b2.addl.includes(`proxy down on :${closedProxyPort}`), 'proxy-down advisory present');

    // ── B3: proxy up + Ollama down → block AND advisory, block first ──────────
    console.log('\nB3. proxy up + Ollama down → block present, advisory present, block first');
    const closedOllamaPort = await getFreePort();
    const b3 = await runHook(hookEnv({
      ANTHROPIC_BASE_URL: upStub.url,
      OLLAMA_URL: `http://127.0.0.1:${closedOllamaPort}`,
    }));
    assertEq(b3.status, 0, `hook exits 0 (proxy up + advisory) (stderr: ${b3.stderr.slice(0, 200)})`);
    assert(b3.addl.includes('proxy control plane'), 'B3: proxy block present');
    assert(b3.addl.includes('Ollama unreachable'),  'B3: Ollama-down advisory present');
    const b3Lines = b3.addl.split('\n');
    const blockLine = b3Lines.findIndex(l => l.includes('proxy control plane'));
    const advLine   = b3Lines.findIndex(l => l.includes('Ollama unreachable'));
    assert(blockLine >= 0 && advLine >= 0 && blockLine < advLine,
      `B3: proxy block appears before the advisory (block@${blockLine} advisory@${advLine})`);

    // ── B4: jq forced absent → node fallback extracts the same block ──────────
    console.log('\nB4. jq forced absent → node fallback extracts the same block');
    const nojqBin = path.join(base, 'nojq-bin');
    fs.mkdirSync(nojqBin, { recursive: true });
    // Symlink only the tools the hook uses — NOT jq — so `command -v jq` fails
    // under this PATH and the hook takes its node fallback. (Prepending an empty
    // dir would NOT hide jq: `command -v` walks the whole PATH.)
    for (const t of ['bash', 'sh', 'env', 'curl', 'node', 'sed', 'awk', 'grep',
                     'cat', 'tr', 'paste', 'cut', 'dirname', 'readlink', 'find', 'git',
                     'head', 'ollama']) {
      const p = which(t);
      if (p) { try { fs.symlinkSync(p, path.join(nojqBin, t)); } catch {} }
    }
    const jqHidden = spawnSync(SH, ['-c', 'command -v jq'],
      { encoding: 'utf8', env: Object.assign({}, process.env, { PATH: nojqBin }) }).status !== 0;
    if (!jqHidden) {
      assert(false, 'B4 setup: minimal PATH still exposes jq — cannot exercise the node fallback');
    } else {
      assert(true, 'B4 setup: jq hidden under minimal PATH (node fallback will be taken)');
      // Launch bash by absolute path (the minimal PATH has no need to resolve it);
      // the hook itself runs under PATH=nojqBin so its `command -v jq` fails.
      const b4 = await runHook(hookEnv({ ANTHROPIC_BASE_URL: upStub.url, PATH: nojqBin }));
      assertEq(b4.status, 0, `hook exits 0 (node fallback path) (stderr: ${b4.stderr.slice(0, 200)})`);
      assert(b4.addl.includes('proxy control plane'), 'node fallback extracts the proxy block');
      assert(b4.addl.includes(`http://127.0.0.1:${upStub.port}`), 'node fallback carries the base URL');
    }
    // If jq is present on this host, the B1 run already exercised the jq path —
    // assert it produced the same block. Otherwise only the node fallback exists.
    if (jqOnHost) {
      assert(b1.addl.includes('proxy control plane'), 'jq path (B1 run) yields the same block');
    } else {
      skip('jq path assertion (jq absent on host — node fallback covered above)');
    }

    // ── B5: slow /hooks/context → bounded wall-time, no hang ──────────────────
    console.log('\nB5. slow /hooks/context → hook completes within a bounded wall-time');
    const t0 = Date.now();
    const b5 = await runHook(hookEnv({ ANTHROPIC_BASE_URL: slowStub.url }));
    const elapsedMs = Date.now() - t0;
    assertEq(b5.status, 0, `hook exits 0 despite slow /hooks/context (stderr: ${b5.stderr.slice(0, 200)})`);
    assert(elapsedMs < 5000,
      `hook completes within bounded wall-time (${elapsedMs}ms < 5000ms — proves --max-time 2)`);
    assert(!b5.addl.includes('SLOW'), 'slow block dropped (no partial block on timeout)');

    // ── B6: plugin-mode session_id scopes the hook context request ───────────
    console.log('\nB6. stdin session_id scopes /hooks/context and preserves the injected block');
    const b6RequestStart = upStub.requests.length;
    const b6 = await runHook(hookEnv({ ANTHROPIC_BASE_URL: upStub.url }), '{"session_id":"ss-sess-1"}');
    const b6Requests = upStub.requests.slice(b6RequestStart);
    assertEq(b6.status, 0, `hook exits 0 with stdin session_id (stderr: ${b6.stderr.slice(0, 200)})`);
    assert(b6Requests.some(r => r.method === 'POST' && r.path === '/s/ss-sess-1/hooks/context'),
      'stub saw POST /s/ss-sess-1/hooks/context');
    assert(!b6Requests.some(r => r.method === 'POST' && r.path === '/hooks/context'),
      'stdin session_id does not use the bare /hooks/context path');
    assert(b6.addl.includes('/c-thru/status') && b6.addl.includes('/c-thru/recent') && b6.addl.includes('/c-thru/dashboard'),
      'scoped hook response carries all control-plane endpoints');
    const b6BlockCount = (b6.addl.match(/proxy control plane/g) || []).length;
    assertEq(b6BlockCount, 1, 'scoped hook response injects the proxy block exactly once');
  } finally {
    await upStub.close();
    await slowStub.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(summary() ? 1 : 0))
  .catch(err => { console.error(err); process.exit(1); });
