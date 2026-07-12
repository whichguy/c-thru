#!/usr/bin/env node
'use strict';
// Spawn-tests for the two prompt-path hooks migrated to cthru_hook_listen_port
// (commit 03c127f): c-thru-proxy-health.sh and c-thru-classify.sh. session-start
// is already spawned by session-start-injection.test.js; these two were not.
//
// Pins, for BOTH the tools/ and the bundled plugins/c-thru/hooks/ layouts (the
// plugin case proves ROUTER_REPO_ROOT/.. resolves the lib under plugins/c-thru/tools/):
//   • proxy-health resolves the port from ANTHROPIC_BASE_URL and curls /ping
//     (warns on a closed port, silent on a healthy one),
//   • classify resolves the port and POSTs the prompt to /hooks/context, echoing
//     the returned additionalContext,
//   • the fail-open contract: with c-thru-lib.sh absent, each hook exits 0 silently.
//
// Run: node test/hook-port-resolution.test.js

const { assert, assertEq, summary, startStubServer, spawnCapture, getFreePort } = require('./helpers');
const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const LAYOUTS = [
  { name: 'tools',  hookDir: path.join(REPO, 'tools') },
  { name: 'plugin', hookDir: path.join(REPO, 'plugins', 'c-thru', 'hooks') },
];

// Env with the port ladder scrubbed except ANTHROPIC_BASE_URL, so that var is the
// only signal cthru_hook_listen_port can use.
function hookEnv(extra = {}) {
  const env = Object.assign({}, process.env);
  for (const k of ['CLAUDE_PROXY_PORT', 'PROXY_PORT', 'CLAUDE_PROXY_USE_OLLAMA_PORT', 'C_THRU_PLUGIN_PORT', 'OLLAMA_URL', 'OLLAMA_BASE_URL', 'C_THRU_SESSION_ID', 'C_THRU_SESSION_SCOPED_MODE']) delete env[k];
  return Object.assign(env, extra);
}

// spawnCapture ignores stdin; classify reads the prompt from stdin, so it needs this.
function spawnWithStdin(hookPath, input, env) {
  return new Promise((resolve) => {
    const child = spawn('bash', [hookPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.stdin.write(input); child.stdin.end();
  });
}

async function main() {
  console.log('hook port-resolution (proxy-health + classify spawn tests)\n');

  for (const { name, hookDir } of LAYOUTS) {
    const health   = path.join(hookDir, 'c-thru-proxy-health.sh');
    const classify = path.join(hookDir, 'c-thru-classify.sh');

    // ── proxy-health: closed port → warns naming the resolved port ──────────
    {
      const closed = await getFreePort(); // bound then released → nothing listening
      const r = await spawnCapture('bash', [health], {
        env: hookEnv({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${closed}` }), timeout: 8000,
      });
      assertEq(r.status, 0, `[${name}] proxy-health exits 0 on a down proxy`);
      assert(r.stderr.includes(`unreachable on :${closed}`),
        `[${name}] proxy-health resolved the ANTHROPIC_BASE_URL port and warned (got stderr: ${r.stderr.trim().slice(0, 120)})`);
    }

    // ── proxy-health: healthy /ping → exit 0, no warning ────────────────────
    {
      const stub = await startStubServer({ 'GET /ping': (req, res) => { res.writeHead(200); res.end('ok'); } });
      try {
        const r = await spawnCapture('bash', [health], {
          env: hookEnv({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}` }), timeout: 8000,
        });
        assertEq(r.status, 0, `[${name}] proxy-health exits 0 on a healthy proxy`);
        assert(!r.stderr.includes('unreachable'), `[${name}] proxy-health is silent when /ping answers 200`);
        assert(stub.requests.some(q => q.path === '/ping'), `[${name}] proxy-health actually hit /ping`);
      } finally { await stub.close(); }
    }

    // ── classify: resolves port + echoes /hooks/context additionalContext ───
    {
      const stub = await startStubServer({
        'POST /hooks/context': (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'CTX-MARKER-42' } }));
        },
      });
      try {
        const r = await spawnWithStdin(classify, '{"prompt":"hello world"}',
          hookEnv({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}` }));
        assertEq(r.status, 0, `[${name}] classify exits 0`);
        assert(stub.requests.some(q => q.path === '/hooks/context'), `[${name}] classify hit /hooks/context`);
        let ctx = null;
        try { ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch {}
        assert(ctx && ctx.includes('CTX-MARKER-42'),
          `[${name}] classify echoed the returned additionalContext (got: ${JSON.stringify(r.stdout).slice(0, 120)})`);
      } finally { await stub.close(); }
    }

    // ── classify: stdin session_id scopes /hooks/context + preserves context ─
    {
      const contextResponse = {
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'CTX-SCOPED-MARKER-123' },
      };
      const stub = await startStubServer({
        'POST /hooks/context': contextResponse,
        'POST /s/abc123/hooks/context': contextResponse,
      });
      try {
        const r = await spawnWithStdin(classify, '{"prompt":"hello world","session_id":"abc123"}',
          hookEnv({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}` }));
        assertEq(r.status, 0, `[${name}] scoped classify exits 0`);
        assert(stub.requests.some(q => q.path === '/s/abc123/hooks/context'),
          `[${name}] scoped classify hit /s/abc123/hooks/context`);
        assert(!stub.requests.some(q => q.path === '/hooks/context'),
          `[${name}] scoped classify did not hit bare /hooks/context`);
        let ctx = null;
        try { ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch {}
        assert(ctx && ctx.includes('CTX-SCOPED-MARKER-123'),
          `[${name}] scoped classify echoed the returned additionalContext (got: ${JSON.stringify(r.stdout).slice(0, 120)})`);
      } finally { await stub.close(); }
    }
  }

  // ── Fail-open: lib absent → both hooks exit 0 silently, never hit the stub ──
  {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-failopen-'));
    const sTools = path.join(scratch, 'tools');
    fs.mkdirSync(sTools, { recursive: true });
    // Copy the hooks but NOT c-thru-lib.sh → the `[ -r … ] ||` guard takes the fail-open path.
    fs.copyFileSync(path.join(REPO, 'tools', 'c-thru-proxy-health.sh'), path.join(sTools, 'c-thru-proxy-health.sh'));
    fs.copyFileSync(path.join(REPO, 'tools', 'c-thru-classify.sh'),     path.join(sTools, 'c-thru-classify.sh'));
    try {
      const stub = await startStubServer({ '*': (req, res) => { res.writeHead(200); res.end('{}'); } });
      try {
        const rh = await spawnCapture('bash', [path.join(sTools, 'c-thru-proxy-health.sh')], {
          env: hookEnv({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}` }), timeout: 8000,
        });
        assertEq(rh.status, 0, 'fail-open: proxy-health exits 0 when lib is absent');
        assert(!rh.stderr.includes('unreachable'), 'fail-open: proxy-health is silent (never resolved a port)');

        const rc = await spawnWithStdin(path.join(sTools, 'c-thru-classify.sh'), '{"prompt":"hello"}',
          hookEnv({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}` }));
        assertEq(rc.status, 0, 'fail-open: classify exits 0 when lib is absent');
        assertEq(rc.stdout.trim(), '', 'fail-open: classify emits nothing');

        assertEq(stub.requests.length, 0, 'fail-open: neither hook reached the proxy stub');
      } finally { await stub.close(); }
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
