#!/usr/bin/env node
'use strict';
// Default statusline: model|cwd + last served/tokens + optional fallback + dash.
// Same real-proxy recipe as the overlay suite.
// Run: node test/c-thru-statusline.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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
      assert(out1.stdout.includes('secondary-target') || /secondary/.test(out1.stdout),
        `shows served/fallback model (got ${JSON.stringify(out1.stdout)})`);
      assert(/\[fallback\]/.test(out1.stdout), `fallback badge (got ${JSON.stringify(out1.stdout)})`);
      assert(out1.stdout.includes(`dash :${port}/c-thru/dashboard`),
        `plain dash hint (got ${JSON.stringify(out1.stdout)})`);
      assert(!/\u26A0/.test(out1.stdout) && !/\x1b\]8;/.test(out1.stdout),
        'no emoji / no OSC-8');

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
    });
  } finally {
    try { await primary.close(); } catch {}
    try { await secondary.close(); } catch {}
    fs.rmSync(base, { recursive: true, force: true });
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
