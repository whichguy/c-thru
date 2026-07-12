#!/usr/bin/env node
'use strict';
// tools/c-thru-postcompact-context.sh (the PreCompact hook) had zero
// behavioral test coverage before this file — it was previously fixed this
// same session for resolving its port via a dead env var
// (CLAUDE_PROXY_HOOKS_PORT, never set anywhere) instead of the canonical
// cthru_hook_listen_port() ladder, which made PreCompact context reinjection
// effectively dead code. This locks in the fix and the hookEventName re-wrap.
//
// Same recipe as test/session-start-injection.test.js's Node port: a scratch
// copy of the hook + shared lib, driven via spawnCapture against an
// in-process stub standing in for the proxy's /hooks/context endpoint.
//
// Run: node test/c-thru-postcompact-context.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const {
  assert, assertEq, skip, summary, getFreePort, startStubServer, spawnCapture,
} = require('./helpers');

const REPO_DIR    = path.join(__dirname, '..');
const HOOK_SOURCE = path.join(REPO_DIR, 'tools', 'c-thru-postcompact-context.sh');
const LIB_SOURCE  = path.join(REPO_DIR, 'tools', 'c-thru-lib.sh');

console.log('c-thru-postcompact-context (PreCompact hook: context reinjection, port resolution)\n');

function which(tool) {
  const r = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}
const BASH = which('bash') || 'bash';
const SH   = which('sh')   || 'sh';

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-postcompact-'));
  const scratchTools = path.join(base, 'scratch', 'tools');
  fs.mkdirSync(scratchTools, { recursive: true });
  const scratchHook = path.join(scratchTools, 'c-thru-postcompact-context.sh');
  fs.copyFileSync(HOOK_SOURCE, scratchHook);
  fs.copyFileSync(LIB_SOURCE, path.join(scratchTools, 'c-thru-lib.sh'));

  function hookEnv(extra = {}) {
    const env = Object.assign({}, process.env);
    delete env.CLAUDE_PROXY_PORT;
    delete env.PROXY_PORT;
    delete env.ANTHROPIC_BASE_URL;
    delete env.C_THRU_SESSION_ID;
    delete env.C_THRU_SESSION_SCOPED_MODE;
    return Object.assign(env, extra);
  }

  async function runHook(env, input) {
    let r;
    if (input === undefined) {
      r = await spawnCapture(BASH, [scratchHook], { env, timeout: 10000 });
    } else {
      r = await new Promise((resolve, reject) => {
        const child = spawn(BASH, [scratchHook], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10000);
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('error', err => { clearTimeout(timer); reject(err); });
        child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
        child.stdin.end(input);
      });
    }
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch {}
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', parsed };
  }

  const jqOnHost = which('jq') !== '';
  const CONTEXT_TEXT = '(c-thru) recent routing: workhorse -> qwen3.6:35b (best-cloud, 64gb)';

  const upStub = await startStubServer({
    'POST /hooks/context': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // The proxy's real /hooks/context handler hardcodes hookEventName:
      // "SessionStart" regardless of which hook called it — the postcompact
      // hook's job is to re-wrap this under its OWN event name.
      res.end(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONTEXT_TEXT },
      }));
    },
    'POST /s/pc-sess-1/hooks/context': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONTEXT_TEXT },
      }));
    },
  });

  const emptyStub = await startStubServer({
    'POST /hooks/context': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' } }));
    },
  });

  const errorStub = await startStubServer({
    'POST /hooks/context': (req, res) => { res.writeHead(500); res.end('boom'); },
  });

  try {
    // ── 1. No resolvable port (c-thru not active) → silent, exit 0 ───────────
    console.log('1. no resolvable proxy port → silent no-op');
    const r1 = await runHook(hookEnv());
    assertEq(r1.status, 0, `hook exits 0 with no port resolvable (stderr: ${r1.stderr.slice(0, 200)})`);
    assertEq(r1.stdout, '', 'no stdout when c-thru is not active');

    // ── 2. Port set but nothing listening (closed port) → silent ─────────────
    console.log('\n2. proxy port set but connection refused → silent, exit 0');
    const closedPort = await getFreePort();
    const r2 = await runHook(hookEnv({ CLAUDE_PROXY_PORT: String(closedPort) }));
    assertEq(r2.status, 0, `hook exits 0 when the proxy is unreachable (stderr: ${r2.stderr.slice(0, 200)})`);
    assertEq(r2.stdout, '', 'no stdout when the proxy connection is refused');

    // ── 3. Non-200 from /hooks/context → silent ───────────────────────────────
    console.log('\n3. /hooks/context returns 500 → silent, exit 0');
    const r3 = await runHook(hookEnv({ CLAUDE_PROXY_PORT: String(errorStub.port) }));
    assertEq(r3.status, 0, `hook exits 0 on upstream 500 (stderr: ${r3.stderr.slice(0, 200)})`);
    assertEq(r3.stdout, '', 'no stdout on a non-200 response (curl --fail)');

    // ── 4. Empty additionalContext → silent ───────────────────────────────────
    console.log('\n4. /hooks/context returns an empty additionalContext → silent');
    const r4 = await runHook(hookEnv({ CLAUDE_PROXY_PORT: String(emptyStub.port) }));
    assertEq(r4.status, 0, `hook exits 0 on empty context (stderr: ${r4.stderr.slice(0, 200)})`);
    assertEq(r4.stdout, '', 'no stdout when additionalContext is empty');

    // ── 5. Success → re-wrapped under hookEventName:"PreCompact" ─────────────
    // Regression guard for the exact bug fixed this session: the proxy's raw
    // response hardcodes "SessionStart"; this hook must re-wrap it as its own
    // real event, not pass the proxy's label through unchanged.
    console.log('\n5. success → correctly re-wrapped as hookEventName:"PreCompact"');
    const r5 = await runHook(hookEnv({ CLAUDE_PROXY_PORT: String(upStub.port) }));
    assertEq(r5.status, 0, `hook exits 0 on success (stderr: ${r5.stderr.slice(0, 200)})`);
    assert(r5.parsed !== null, 'stdout is valid JSON');
    assertEq(r5.parsed?.hookSpecificOutput?.hookEventName, 'PreCompact', 'hookEventName is PreCompact, not the proxy\'s raw "SessionStart"');
    assertEq(r5.parsed?.hookSpecificOutput?.additionalContext, CONTEXT_TEXT, 'additionalContext is extracted verbatim');
    const sawHooksContext = upStub.requests.some(r => r.method === 'POST' && r.path === '/hooks/context' && r.body?.event === 'PreCompact');
    assert(sawHooksContext, 'stub received POST /hooks/context with {"event":"PreCompact"} in the request body');

    // ── 6. jq forced absent → node fallback yields the same re-wrapped result ─
    console.log('\n6. jq forced absent → node fallback extracts + re-wraps identically');
    const nojqBin = path.join(base, 'nojq-bin');
    fs.mkdirSync(nojqBin, { recursive: true });
    for (const t of ['bash', 'sh', 'env', 'curl', 'node', 'sed', 'awk', 'grep', 'cat', 'tr', 'cut', 'dirname', 'readlink']) {
      const p = which(t);
      if (p) { try { fs.symlinkSync(p, path.join(nojqBin, t)); } catch {} }
    }
    const jqHidden = spawnSync(SH, ['-c', 'command -v jq'],
      { encoding: 'utf8', env: Object.assign({}, process.env, { PATH: nojqBin }) }).status !== 0;
    if (!jqHidden) {
      assert(false, '6 setup: minimal PATH still exposes jq — cannot exercise the node fallback');
    } else {
      assert(true, '6 setup: jq hidden under minimal PATH (node fallback will be taken)');
      const r6 = await runHook(hookEnv({ CLAUDE_PROXY_PORT: String(upStub.port), PATH: nojqBin }));
      assertEq(r6.status, 0, `hook exits 0 (node fallback path) (stderr: ${r6.stderr.slice(0, 200)})`);
      assertEq(r6.parsed?.hookSpecificOutput?.hookEventName, 'PreCompact', 'node fallback: hookEventName is PreCompact');
      assertEq(r6.parsed?.hookSpecificOutput?.additionalContext, CONTEXT_TEXT, 'node fallback: additionalContext matches the jq path');
    }
    if (jqOnHost) {
      assertEq(r5.parsed?.hookSpecificOutput?.additionalContext, CONTEXT_TEXT, 'jq path (test 5) matches the node fallback result');
    } else {
      skip('jq-path cross-check (jq absent on host — node fallback already covered above)');
    }

    // ── 7. stdin session_id scopes the request + preserves PreCompact output ─
    console.log('\n7. stdin session_id scopes /hooks/context and preserves PreCompact output');
    const requestsBeforeScoped = upStub.requests.length;
    const r7 = await runHook(hookEnv({ CLAUDE_PROXY_PORT: String(upStub.port) }), '{"session_id":"pc-sess-1"}');
    assertEq(r7.status, 0, `hook exits 0 with stdin session_id (stderr: ${r7.stderr.slice(0, 200)})`);
    const scopedRequests = upStub.requests.slice(requestsBeforeScoped);
    assert(scopedRequests.some(r => r.method === 'POST' && r.path === '/s/pc-sess-1/hooks/context'),
      'stdin session_id hit POST /s/pc-sess-1/hooks/context');
    assert(!scopedRequests.some(r => r.method === 'POST' && r.path === '/hooks/context'),
      'stdin session_id did not hit bare POST /hooks/context');
    assertEq(r7.parsed?.hookSpecificOutput?.hookEventName, 'PreCompact', 'scoped response is re-wrapped as PreCompact');
    assertEq(r7.parsed?.hookSpecificOutput?.additionalContext, CONTEXT_TEXT, 'scoped response additionalContext is extracted verbatim');
  } finally {
    await upStub.close();
    await emptyStub.close();
    await errorStub.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(summary() ? 1 : 0))
  .catch(err => { console.error(err); process.exit(1); });
