#!/usr/bin/env node
'use strict';
// Default statusline: model|cwd + last served/tokens + optional fallback + dash.
// Same real-proxy recipe as the overlay suite.
// Run: node test/c-thru-statusline.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, stubBackend,
} = require('./helpers');

const REPO_DIR = path.join(__dirname, '..');
const HOOK_SOURCE = path.join(REPO_DIR, 'tools', 'c-thru-statusline.sh');
const LIB_SOURCE = path.join(REPO_DIR, 'tools', 'c-thru-lib.sh');
const OVERLAY_SOURCE = path.join(REPO_DIR, 'tools', 'c-thru-statusline-overlay.sh');

console.log('c-thru-statusline (default bar + recent stats)\n');

function which(tool) {
  const r = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}
const BASH = which('bash') || 'bash';
const haveJq = which('jq') !== '';

const CTHRU_ENV_KEYS = [
  'CLAUDE_PROXY_PORT', 'PROXY_PORT', 'ANTHROPIC_BASE_URL',
  'CLAUDE_PROXY_USE_OLLAMA_PORT', 'C_THRU_SESSION_ID', 'C_THRU_PLUGIN_PORT',
  'C_THRU_SESSION_SCOPED_MODE', 'C_THRU_STATUSLINE_OVERLAY', 'C_THRU_STATUSLINE_DASH',
  'C_THRU_STATUSLINE_STYLE', 'C_THRU_ORIGINAL_PROFILE_DIR',
];

function runStatusline(scratchHook, fakeClaudeHome, port, sessionId, stdinObj, extraEnv = {}) {
  const env = Object.assign({}, process.env, { HOME: fakeClaudeHome }, extraEnv);
  for (const k of CTHRU_ENV_KEYS) {
    if (!(k in extraEnv)) delete env[k];
  }
  if (port) env.CLAUDE_PROXY_PORT = String(port);
  if (sessionId) env.C_THRU_SESSION_ID = sessionId;
  const r = spawnSync(BASH, [scratchHook], {
    env,
    encoding: 'utf8',
    timeout: 10000,
    input: JSON.stringify(stdinObj || {}),
  });
  return { status: r.status, stdout: (r.stdout || ''), stderr: r.stderr || '' };
}

async function main() {
  if (!haveJq) {
    console.log('jq not on PATH — skipping (statusline fail-opens without jq for proxy bits).');
    process.exit(0);
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-statusline-full-'));
  const scratchTools = path.join(base, 'scratch', 'tools');
  fs.mkdirSync(scratchTools, { recursive: true });
  const scratchHook = path.join(scratchTools, 'c-thru-statusline.sh');
  fs.copyFileSync(HOOK_SOURCE, scratchHook);
  fs.copyFileSync(LIB_SOURCE, path.join(scratchTools, 'c-thru-lib.sh'));
  fs.copyFileSync(OVERLAY_SOURCE, path.join(scratchTools, 'c-thru-statusline-overlay.sh'));
  fs.chmodSync(scratchHook, 0o755);

  let primary, secondary;
  try {
    primary = await stubBackend({ failWith: 500 });
    secondary = await stubBackend();
    const cfg = {
      backends: {
        primary_be: { kind: 'anthropic', url: `http://127.0.0.1:${primary.port}`, fallback_to: 'secondary-target' },
        secondary_be: { kind: 'anthropic', url: `http://127.0.0.1:${secondary.port}` },
      },
      model_routes: {
        'primary-model': 'primary_be',
        'secondary-target': 'secondary_be',
      },
    };
    const configPath = writeConfig(base, cfg);

    await withProxy({ configPath }, async ({ port }) => {
      console.log('1. After fallback: bar shows model, cwd, served, fallback, dash');
      const rA = await httpJson(port, 'POST', '/s/session-a/v1/messages', {
        model: 'primary-model', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }],
      }, { 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
      assertEq(rA.status, 200, 'fallback request 200');

      const homeA = fs.mkdtempSync(path.join(base, 'home-a-'));
      const out1 = runStatusline(scratchHook, homeA, port, 'session-a', {
        model: { id: 'sonnet' },
        workspace: { current_dir: '/Users/me/proj' },
      });
      assertEq(out1.status, 0, 'statusline exits 0');
      assert(out1.stdout.includes('sonnet'), `shows prompt model (got ${JSON.stringify(out1.stdout)})`);
      assert(out1.stdout.includes('~/proj') || out1.stdout.includes('/Users/me/proj'),
        `shows cwd (got ${JSON.stringify(out1.stdout)})`);
      assert(/\[fallback\]/.test(out1.stdout) && /secondary/.test(out1.stdout),
        `fallback badge names serving model once (got ${JSON.stringify(out1.stdout)})`);
      // Newest request is the fallback: do not also print bare "served" twice.
      const fbHits = (out1.stdout.match(/secondary-target/g) || []).length;
      assert(fbHits === 1,
        `served model appears once under fallback (hits=${fbHits}, got ${JSON.stringify(out1.stdout)})`);
      assert(out1.stdout.includes(`dash :${port}/c-thru/dashboard`),
        `plain dash hint (got ${JSON.stringify(out1.stdout)})`);
      assert(!/\u26A0/.test(out1.stdout) && !/\u2026/.test(out1.stdout) && !/\x1b\]8;/.test(out1.stdout),
        'no emoji / no unicode ellipsis / no OSC-8');

      console.log('\n2. C_THRU_STATUSLINE_OVERLAY=0: model|cwd only (no dash/stats)');
      const out2 = runStatusline(scratchHook, homeA, port, 'session-a', {
        model: { id: 'sonnet' },
        workspace: { current_dir: '/tmp/x' },
      }, { C_THRU_STATUSLINE_OVERLAY: '0' });
      assertEq(out2.status, 0, 'overlay-off exits 0');
      assert(!/\[fallback\]/.test(out2.stdout), 'no fallback when overlay off');
      assert(!out2.stdout.includes('dash :'), 'no dash when overlay off');
      assert(out2.stdout.includes('sonnet'), 'still shows model');

      console.log('\n3. C_THRU_STATUSLINE_DASH=0: stats ok, no dash');
      const out3 = runStatusline(scratchHook, homeA, port, 'session-a', {
        model: { display_name: 'opus' },
        cwd: '/tmp',
      }, { C_THRU_STATUSLINE_DASH: '0' });
      assertEq(out3.status, 0, 'dash-off exits 0');
      assert(!out3.stdout.includes('dash :'), 'dash hidden');
      assert(out3.stdout.includes('opus'), 'shows model');

      console.log('\n4. C_THRU_STATUSLINE_STYLE=minimal: model|cwd only');
      const out4 = runStatusline(scratchHook, homeA, port, 'session-a', {
        model: { id: 'haiku' },
        workspace: { current_dir: '/tmp/y' },
      }, { C_THRU_STATUSLINE_STYLE: 'minimal' });
      assertEq(out4.status, 0, 'style=minimal exits 0');
      assert(out4.stdout.includes('haiku'), 'minimal shows model');
      assert(!/\[fallback\]/.test(out4.stdout), 'minimal no fallback');
      assert(!out4.stdout.includes('dash :'), 'minimal no dash');

      console.log('\n5. C_THRU_STATUSLINE_STYLE=stats: mode/tier chips from /c-thru/statusline');
      const out5 = runStatusline(scratchHook, homeA, port, 'session-a', {
        model: { id: 'sonnet' },
        workspace: { current_dir: '/tmp/z' },
      }, { C_THRU_STATUSLINE_STYLE: 'stats', C_THRU_STATUSLINE_DASH: '0' });
      assertEq(out5.status, 0, 'style=stats exits 0');
      assert(out5.stdout.includes('sonnet'), 'stats shows model');
      // mode chip is a short tag (cloud/oss/local/gov) before a pipe+number tier
      assert(/\| (cloud|oss|local|gov|local-gov|\?)\|/.test(out5.stdout) || /\| [a-z0-9-]+\|\d+/.test(out5.stdout),
        `stats includes mode|tier chip (got ${JSON.stringify(out5.stdout)})`);

      console.log('\n6. Durable pref file style=stats (no C_THRU_STATUSLINE_STYLE env)');
      const durableHome = fs.mkdtempSync(path.join(base, 'durable-pref-'));
      fs.writeFileSync(path.join(durableHome, 'c-thru-statusline.json'),
        JSON.stringify({ style: 'stats' }) + '\n');
      const out6 = runStatusline(scratchHook, durableHome, port, 'session-a', {
        model: { id: 'sonnet' },
        workspace: { current_dir: '/tmp/pref' },
      }, {
        C_THRU_ORIGINAL_PROFILE_DIR: durableHome,
        C_THRU_STATUSLINE_DASH: '0',
        // explicitly no STYLE env — runStatusline deletes unset keys
      });
      assertEq(out6.status, 0, 'pref-file stats exits 0');
      assert(/\| (cloud|oss|local|gov|local-gov|\?)\|/.test(out6.stdout) || /\| [a-z0-9-]+\|\d+/.test(out6.stdout),
        `pref-file style=stats includes mode|tier (got ${JSON.stringify(out6.stdout)})`);

      // T-A: env style wins over durable pref (env=stats, pref=minimal → chips)
      console.log('\n6b. Env style overrides durable pref (env=stats > pref=minimal)');
      const prefMinimalHome = fs.mkdtempSync(path.join(base, 'pref-min-'));
      fs.writeFileSync(path.join(prefMinimalHome, 'c-thru-statusline.json'),
        JSON.stringify({ style: 'minimal' }) + '\n');
      const out6b = runStatusline(scratchHook, prefMinimalHome, port, 'session-a', {
        model: { id: 'sonnet' },
        workspace: { current_dir: '/tmp/env-wins' },
      }, {
        C_THRU_ORIGINAL_PROFILE_DIR: prefMinimalHome,
        C_THRU_STATUSLINE_STYLE: 'stats',
        C_THRU_STATUSLINE_DASH: '0',
      });
      assertEq(out6b.status, 0, 'env>pref exits 0');
      assert(out6b.stdout.includes('sonnet'), 'env>pref shows model');
      assert(/\| (cloud|oss|local|gov|local-gov|\?)\|/.test(out6b.stdout) || /\| [a-z0-9-]+\|\d+/.test(out6b.stdout),
        `env=stats wins over pref=minimal — mode|tier chip present (got ${JSON.stringify(out6b.stdout)})`);

      // T-F: fail-open when proxy is down (stats style still prints model|cwd)
      console.log('\n6c. Fail-open: dead proxy port (stats style)');
      const deadPort = 9; // nothing listening on privileged-range closed port
      const out6c = runStatusline(scratchHook, homeA, deadPort, 'session-a', {
        model: { id: 'sonnet' },
        workspace: { current_dir: '/tmp/dead' },
      }, { C_THRU_STATUSLINE_STYLE: 'stats', C_THRU_STATUSLINE_DASH: '0' });
      assertEq(out6c.status, 0, 'dead-proxy statusline exits 0');
      assert(out6c.stdout.includes('sonnet'), 'dead-proxy still shows model');
      assert(out6c.stdout.includes('/tmp/dead') || out6c.stdout.includes('dead'),
        `dead-proxy still shows cwd (got ${JSON.stringify(out6c.stdout)})`);

      // Gap 9: shadow pref ignored — durable wins when ORIGINAL_PROFILE_DIR set
      console.log('\n6d. Shadow pref ignored (durable stats wins over shadow minimal)');
      const dualBase = fs.mkdtempSync(path.join(base, 'dual-pref-'));
      const durablePref = path.join(dualBase, 'durable');
      const shadowPref = path.join(dualBase, 'shadow');
      fs.mkdirSync(durablePref, { recursive: true });
      fs.mkdirSync(shadowPref, { recursive: true });
      fs.writeFileSync(path.join(durablePref, 'c-thru-statusline.json'),
        JSON.stringify({ style: 'stats' }) + '\n');
      fs.writeFileSync(path.join(shadowPref, 'c-thru-statusline.json'),
        JSON.stringify({ style: 'minimal' }) + '\n');
      const out6d = runStatusline(scratchHook, shadowPref, port, 'session-a', {
        model: { id: 'sonnet' },
        workspace: { current_dir: '/tmp/dual' },
      }, {
        C_THRU_ORIGINAL_PROFILE_DIR: durablePref,
        // HOME/CLAUDE_DIR point at shadow — product must not use them for pref
        CLAUDE_DIR: shadowPref,
        C_THRU_STATUSLINE_DASH: '0',
      });
      assertEq(out6d.status, 0, 'dual-pref exits 0');
      assert(/\| (cloud|oss|local|gov|local-gov|\?)\|/.test(out6d.stdout) || /\| [a-z0-9-]+\|\d+/.test(out6d.stdout),
        `durable stats pref wins over shadow minimal (got ${JSON.stringify(out6d.stdout)})`);
    });
  } finally {
    try { await primary.close(); } catch {}
    try { await secondary.close(); } catch {}
    fs.rmSync(base, { recursive: true, force: true });
  }

  // ── Gap 5: HTTP route gating by style (child fixture server — spawnSync
  // blocks the event loop so an in-process server cannot accept curl). ───────
  console.log('\n7. Style → enrichment HTTP route counts');
  const gateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-sl-gate-'));
  const gateTools = path.join(gateHome, 'tools');
  fs.mkdirSync(gateTools, { recursive: true });
  const gateHook = path.join(gateTools, 'c-thru-statusline.sh');
  fs.copyFileSync(HOOK_SOURCE, gateHook);
  fs.copyFileSync(LIB_SOURCE, path.join(gateTools, 'c-thru-lib.sh'));
  fs.chmodSync(gateHook, 0o755);

  const hitFile = path.join(gateHome, 'hits.json');
  const portFile = path.join(gateHome, 'port.txt');
  const fixtureScript = path.join(gateHome, 'fixture-server.js');
  fs.writeFileSync(fixtureScript, `
'use strict';
const http = require('http');
const fs = require('fs');
let hits = [];
function flush() { fs.writeFileSync(process.env.HIT_FILE, JSON.stringify(hits)); }
function maybeResetFromFile() {
  // Parent clears HIT_FILE to [] between cases; honor that so counts are per-case.
  try {
    const cur = JSON.parse(fs.readFileSync(process.env.HIT_FILE, 'utf8'));
    if (Array.isArray(cur) && cur.length === 0) hits = [];
  } catch { /* first request */ }
}
const s = http.createServer((req, res) => {
  maybeResetFromFile();
  const pathOnly = (req.url || '').split('?')[0];
  hits.push(pathOnly);
  flush();
  res.setHeader('Content-Type', 'application/json');
  if (pathOnly.includes('/c-thru/statusline')) {
    res.end(JSON.stringify({
      ok: true, mode: 'best-cloud-oss', tier: '128gb', port: 1,
      last: { served_by: 'fixture-model', input_tokens: 1, output_tokens: 1, fallback_from: null, ts: new Date().toISOString() },
      fallback: null, usage_window: { calls: 1, input: 1, output: 1, since: null },
    }));
    return;
  }
  if (pathOnly.includes('/c-thru/recent')) {
    res.end(JSON.stringify({
      ok: true,
      requests: [{ served_by: 'fixture-model', input_tokens: 1, output_tokens: 1, fallback_from: null, ts: new Date().toISOString() }],
    }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});
s.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.PORT_FILE, String(s.address().port));
  flush();
});
`);

  const fixtureChild = spawn(process.execPath, [fixtureScript], {
    env: { ...process.env, HIT_FILE: hitFile, PORT_FILE: portFile },
    stdio: 'ignore',
  });

  function readHits() {
    try { return JSON.parse(fs.readFileSync(hitFile, 'utf8')); } catch { return []; }
  }
  function countPaths(hits, sub) {
    return hits.filter(p => p.includes(sub)).length;
  }
  function clearHits() {
    fs.writeFileSync(hitFile, '[]');
  }

  // Wait for port file
  let gatePort = 0;
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(portFile)) {
      gatePort = parseInt(fs.readFileSync(portFile, 'utf8'), 10);
      if (gatePort > 0) break;
    }
    await new Promise(r => setTimeout(r, 20));
  }
  assert(gatePort > 0, 'fixture server published port');

  try {
    clearHits();
    runStatusline(gateHook, gateHome, gatePort, 'sess', {
      model: { id: 'm' }, workspace: { current_dir: '/tmp' },
    }, { C_THRU_STATUSLINE_STYLE: 'stats', C_THRU_STATUSLINE_DASH: '0' });
    let hits = readHits();
    assertEq(countPaths(hits, '/c-thru/statusline'), 1, 'stats: exactly one /c-thru/statusline');
    assertEq(countPaths(hits, '/c-thru/recent'), 0, 'stats: no /c-thru/recent');

    clearHits();
    runStatusline(gateHook, gateHome, gatePort, 'sess', {
      model: { id: 'm' }, workspace: { current_dir: '/tmp' },
    }, { C_THRU_STATUSLINE_STYLE: 'default', C_THRU_STATUSLINE_DASH: '0' });
    hits = readHits();
    assertEq(countPaths(hits, '/c-thru/recent'), 1, 'default: one /c-thru/recent');
    assertEq(countPaths(hits, '/c-thru/statusline'), 0, 'default: no /c-thru/statusline');

    clearHits();
    runStatusline(gateHook, gateHome, gatePort, 'sess', {
      model: { id: 'm' }, workspace: { current_dir: '/tmp' },
    }, { C_THRU_STATUSLINE_STYLE: 'minimal' });
    hits = readHits();
    assertEq(hits.length, 0, 'minimal: zero enrichment GETs');

    clearHits();
    runStatusline(gateHook, gateHome, gatePort, 'sess', {
      model: { id: 'm' }, workspace: { current_dir: '/tmp' },
    }, { C_THRU_STATUSLINE_STYLE: 'stats', C_THRU_STATUSLINE_OVERLAY: '0' });
    hits = readHits();
    assertEq(hits.length, 0, 'stats+OVERLAY=0: zero enrichment GETs');
  } finally {
    try { fixtureChild.kill('SIGTERM'); } catch {}
    fs.rmSync(gateHome, { recursive: true, force: true });
  }

  // ── T-F: fail-open on non-JSON / 500 from enrichment endpoint ───────────
  console.log('\n8. Fail-open: bad JSON / 500 from /c-thru/statusline');
  const badHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-sl-bad-'));
  const badTools = path.join(badHome, 'tools');
  fs.mkdirSync(badTools, { recursive: true });
  const badHook = path.join(badTools, 'c-thru-statusline.sh');
  fs.copyFileSync(HOOK_SOURCE, badHook);
  fs.copyFileSync(LIB_SOURCE, path.join(badTools, 'c-thru-lib.sh'));
  fs.chmodSync(badHook, 0o755);
  const badPortFile = path.join(badHome, 'port.txt');
  const badFixture = path.join(badHome, 'bad-server.js');
  fs.writeFileSync(badFixture, `
'use strict';
const http = require('http');
const fs = require('fs');
const s = http.createServer((req, res) => {
  res.statusCode = 500;
  res.setHeader('Content-Type', 'text/plain');
  res.end('not-json{{{');
});
s.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.PORT_FILE, String(s.address().port));
});
`);
  const badChild = spawn(process.execPath, [badFixture], {
    env: { ...process.env, PORT_FILE: badPortFile },
    stdio: 'ignore',
  });
  let badPort = 0;
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(badPortFile)) {
      badPort = parseInt(fs.readFileSync(badPortFile, 'utf8'), 10);
      if (badPort > 0) break;
    }
    await new Promise(r => setTimeout(r, 20));
  }
  try {
    assert(badPort > 0, 'bad-JSON fixture published port');
    const outBad = runStatusline(badHook, badHome, badPort, 'sess', {
      model: { id: 'haiku' }, workspace: { current_dir: '/tmp/badjson' },
    }, { C_THRU_STATUSLINE_STYLE: 'stats', C_THRU_STATUSLINE_DASH: '0' });
    assertEq(outBad.status, 0, 'bad-JSON enrichment exits 0');
    assert(outBad.stdout.includes('haiku'), 'bad-JSON still shows model');
    assert(outBad.stdout.includes('badjson') || outBad.stdout.includes('/tmp'),
      `bad-JSON still shows cwd (got ${JSON.stringify(outBad.stdout)})`);
  } finally {
    try { badChild.kill('SIGTERM'); } catch {}
    fs.rmSync(badHome, { recursive: true, force: true });
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
