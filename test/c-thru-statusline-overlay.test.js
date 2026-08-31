#!/usr/bin/env node
'use strict';
// c-thru-statusline-overlay.sh: prints a fallback badge when this session's
// most recent request was served by a fallback.
//
// Round-5 B3: rewritten (see test/c-thru-stop-hook.test.js's header for the
// full rationale — same rebuild, same rationale, same recipe). Drives a REAL
// spawned proxy through a REAL primary-fails/secondary-serves fallback and
// the hook's actual GET /c-thru/recent call.
//
// Run: node test/c-thru-statusline-overlay.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, stubBackend, spawnCapture,
} = require('./helpers');

const REPO_DIR = path.join(__dirname, '..');
const HOOK_SOURCE = path.join(REPO_DIR, 'tools', 'c-thru-statusline-overlay.sh');
const LIB_SOURCE  = path.join(REPO_DIR, 'tools', 'c-thru-lib.sh');

console.log('c-thru-statusline-overlay (fallback badge: real proxy, real fallback)\n');

function which(tool) {
  const r = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}
const BASH = which('bash') || 'bash';
const haveJq = which('jq') !== '';

const CTHRU_ENV_KEYS = [
  'CLAUDE_PROXY_PORT', 'PROXY_PORT', 'ANTHROPIC_BASE_URL',
  'CLAUDE_PROXY_USE_OLLAMA_PORT', 'C_THRU_SESSION_ID', 'C_THRU_PLUGIN_PORT',
  'C_THRU_SESSION_SCOPED_MODE',
];

// port + sessionId (not a pre-built URL): cthru_hook_base_url() constructs
// the /s/<id> suffix itself from C_THRU_SESSION_ID (matching how a real
// c-thru launch always sets CLAUDE_PROXY_PORT/PROXY_PORT and
// C_THRU_SESSION_ID together). Pass port=null/sessionId=null for "not active".
async function runHook(scratchHook, fakeClaudeHome, port, sessionId) {
  const env = Object.assign({}, process.env, { HOME: fakeClaudeHome });
  for (const k of CTHRU_ENV_KEYS) delete env[k];
  if (port) env.CLAUDE_PROXY_PORT = String(port);
  if (sessionId) env.C_THRU_SESSION_ID = sessionId;
  const r = await spawnCapture(BASH, [scratchHook], { env, timeout: 10000 });
  return { status: r.status, stdout: (r.stdout || ''), stderr: r.stderr || '' };
}

async function main() {
  if (!haveJq) {
    console.log('jq not on PATH — hook fail-opens by design; skipping (nothing to assert).');
    process.exit(0);
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-statusline-'));
  const scratchTools = path.join(base, 'scratch', 'tools');
  fs.mkdirSync(scratchTools, { recursive: true });
  const scratchHook = path.join(scratchTools, 'c-thru-statusline-overlay.sh');
  fs.copyFileSync(HOOK_SOURCE, scratchHook);
  fs.copyFileSync(LIB_SOURCE, path.join(scratchTools, 'c-thru-lib.sh'));
  fs.chmodSync(scratchHook, 0o755);

  let primary, secondary;
  try {
    primary = await stubBackend({ failWith: 500 });
    secondary = await stubBackend();
    const cfg = {
      backends: {
        primary_be:   { kind: 'anthropic', url: `http://127.0.0.1:${primary.port}`, fallback_to: 'secondary-target' },
        secondary_be: { kind: 'anthropic', url: `http://127.0.0.1:${secondary.port}` },
      },
      model_routes: {
        'primary-model':    'primary_be',
        'secondary-target': 'secondary_be',
      },
    };
    const configPath = writeConfig(base, cfg);

    await withProxy({ configPath }, async ({ port }) => {
      // ── 1. Session A: real fallback fires -> badge appears ──────────────
      console.log('1. Session A: real fallback fires -> badge shows serving model');
      const rA = await httpJson(port, 'POST', '/s/session-a/v1/messages', {
        model: 'primary-model', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }],
      }, { 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
      assertEq(rA.status, 200, 'session A request served via fallback (200)');

      const homeA = fs.mkdtempSync(path.join(base, 'home-a-'));
      const out1 = await runHook(scratchHook, homeA, port, 'session-a');
      assertEq(out1.status, 0, 'hook always exits 0');
      assert(
        /\[fallback\]/i.test(out1.stdout) && out1.stdout.includes('secondary-target') && !/\u26A0/.test(out1.stdout),
        `ASCII badge names the serving model (got: ${JSON.stringify(out1.stdout)})`);

      // ── 2. Session B: healthy only -> no badge, isolated from session A ──
      console.log('\n2. Session B (healthy request only): no badge, isolated from session A');
      const rB = await httpJson(port, 'POST', '/s/session-b/v1/messages', {
        model: 'secondary-target', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }],
      }, { 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
      assertEq(rB.status, 200, 'session B healthy request succeeds (200)');
      const homeB = fs.mkdtempSync(path.join(base, 'home-b-'));
      const out2 = await runHook(scratchHook, homeB, port, 'session-b');
      assertEq(out2.status, 0, 'session B hook exits 0');
      assertEq(out2.stdout, '', `session B shows no badge — no fallback in ITS history (got: ${JSON.stringify(out2.stdout)})`);

      // ── 3. No discoverable proxy (c-thru not active): silent ────────────
      console.log('\n3. No discoverable proxy: silent, no badge');
      const homeC = fs.mkdtempSync(path.join(base, 'home-c-'));
      const out3 = await runHook(scratchHook, homeC, null, null);
      assertEq(out3.status, 0, 'no-proxy case exits 0');
      assertEq(out3.stdout, '', 'no-proxy case shows no badge');
    });
  } finally {
    try { await primary.close(); } catch {}
    try { await secondary.close(); } catch {}
    fs.rmSync(base, { recursive: true, force: true });
  }

  console.log('\n4. Fallback badge keeps Ollama name:tag (not tag-only 0731-cloud)');
  const tagHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-sl-ov-tag-'));
  const tagTools = path.join(tagHome, 'tools');
  fs.mkdirSync(tagTools, { recursive: true });
  const tagHook = path.join(tagTools, 'c-thru-statusline-overlay.sh');
  fs.copyFileSync(HOOK_SOURCE, tagHook);
  fs.copyFileSync(LIB_SOURCE, path.join(tagTools, 'c-thru-lib.sh'));
  fs.chmodSync(tagHook, 0o755);
  const tagPortFile = path.join(tagHome, 'port.txt');
  const tagFixture = path.join(tagHome, 'tag-server.js');
  fs.writeFileSync(tagFixture, `
'use strict';
const http = require('http');
const fs = require('fs');
const hop = {
  served_by: 'deepseek-v4-flash:0731-cloud',
  fallback_from: 'primary-model',
  ts: new Date().toISOString(),
};
const s = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const pathOnly = (req.url || '').split('?')[0];
  if (pathOnly.includes('/c-thru/recent')) {
    res.end(JSON.stringify({ ok: true, requests: [hop] }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});
s.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.PORT_FILE, String(s.address().port));
});
`);
  const tagChild = spawn(process.execPath, [tagFixture], {
    env: { ...process.env, PORT_FILE: tagPortFile },
    stdio: 'ignore',
  });
  let tagPort = 0;
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(tagPortFile)) {
      tagPort = parseInt(fs.readFileSync(tagPortFile, 'utf8'), 10);
      if (tagPort > 0) break;
    }
    await new Promise(r => setTimeout(r, 20));
  }
  try {
    assert(tagPort > 0, 'overlay ollama-tag fixture published port');
    const home = fs.mkdtempSync(path.join(tagHome, 'home-'));
    const out = await runHook(tagHook, home, tagPort, 'sess');
    assertEq(out.status, 0, 'overlay colon-tag exits 0');
    assert(/\[fallback\]/.test(out.stdout) && out.stdout.includes('deepseek-v4-flash:cloud'),
      `overlay badge shows name:cloud (got ${JSON.stringify(out.stdout)})`);
    assert(!/0731/.test(out.stdout),
      `overlay drops the 0731 snapshot (got ${JSON.stringify(out.stdout)})`);
  } finally {
    try { tagChild.kill('SIGTERM'); } catch {}
    fs.rmSync(tagHome, { recursive: true, force: true });
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
