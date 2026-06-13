#!/usr/bin/env node
'use strict';
// Tests for the proxy dashboard surface (D4) + discovery wiring:
//   GET /c-thru/dashboard       — serves tools/proxy-dashboard.html
//   x-c-thru-dashboard header   — stamped on every response (incl. /v1/messages)
//   /c-thru/status additions    — pid / port / uptime_s / started_at / dashboard_url
//
// Run: node test/proxy-dashboard.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  stubBackend, writeConfig, httpJson, spawnProxy, waitForPing,
} = require('./helpers');

console.log('proxy-dashboard tests\n');

const CONCRETE_MODEL = 'dash-test-model';

function buildConfig(stubPort) {
  return {
    backends: {
      stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    model_routes: { [CONCRETE_MODEL]: 'stub' },
  };
}

function killAndWait(child, signal = 'SIGTERM') {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.on('exit', finish);
    try { child.kill(signal); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(); }, 3000);
  });
}

async function main() {
  const stub = await stubBackend();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-dash-'));
  const statsFile = path.join(tmpHome, 'usage-stats.json');
  const configPath = writeConfig(tmpHome, buildConfig(stub.port));
  let child;
  try {
    let port;
    ({ child, port } = await spawnProxy({
      configPath, tmpHome,
      env: { CLAUDE_PROXY_USAGE_STATS_FILE: statsFile },
    }));
    await waitForPing(port, 5000);

    // ── 1. GET /c-thru/dashboard serves the HTML asset ────────────────────
    console.log('1. GET /c-thru/dashboard serves HTML');
    const dash = await httpJson(port, 'GET', '/c-thru/dashboard', null, {}, 3000);
    assertEq(dash.status, 200, 'dashboard returns 200');
    assert((dash.headers['content-type'] || '').startsWith('text/html'),
      `content-type is text/html (got ${dash.headers['content-type']})`);
    assertEq(dash.headers['cache-control'], 'no-store', 'Cache-Control: no-store');
    assert(dash.bodyText.includes('<!DOCTYPE html>'), 'body is an HTML document');
    assert(dash.bodyText.includes('c-thru'), 'body carries the c-thru marker');
    assert(dash.bodyText.includes('/c-thru/recent'), 'page polls /c-thru/recent');
    assert(dash.bodyText.includes('/c-thru/status'), 'page polls /c-thru/status');
    assert(!dash.bodyText.includes('http://') || !/src\s*=\s*"http/.test(dash.bodyText),
      'no external script/CDN references');

    const dashSlash = await httpJson(port, 'GET', '/c-thru/dashboard/', null, {}, 3000);
    assertEq(dashSlash.status, 200, 'trailing-slash variant returns 200');

    // ── 2. /c-thru/status identity + discovery fields ─────────────────────
    console.log('\n2. /c-thru/status gains pid/port/uptime_s/started_at/dashboard_url');
    const st = await httpJson(port, 'GET', '/c-thru/status', null, {}, 3000);
    assertEq(st.status, 200, 'status returns 200');
    assert(typeof st.json.pid === 'number' && st.json.pid > 0, `status.pid is the proxy pid (got ${st.json.pid})`);
    assertEq(st.json.port, port, 'status.port matches the listening port');
    assert(typeof st.json.uptime_s === 'number' && st.json.uptime_s >= 0, 'status.uptime_s is a number');
    assert(typeof st.json.started_at === 'string' && st.json.started_at.includes('T'),
      'status.started_at is an ISO timestamp');
    assertEq(st.json.dashboard_url, `http://127.0.0.1:${port}/c-thru/dashboard`,
      'status.dashboard_url points at this instance');
    // Pre-existing shape intact alongside the additive keys.
    assert(st.json.usage && typeof st.json.usage.total_input === 'number',
      'status.usage shape unchanged (total_input present)');

    // ── 3. x-c-thru-dashboard discovery header on every response ──────────
    console.log('\n3. x-c-thru-dashboard header stamped on responses');
    assertEq(st.headers['x-c-thru-dashboard'], `http://127.0.0.1:${port}/c-thru/dashboard`,
      'header present on a control response');
    const msg = await httpJson(port, 'POST', '/v1/messages', {
      model: CONCRETE_MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 10,
    }, { 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
    assertEq(msg.status, 200, '/v1/messages returned 200');
    assertEq(msg.headers['x-c-thru-dashboard'], `http://127.0.0.1:${port}/c-thru/dashboard`,
      'header present on a proxied /v1/messages response');

    // ── 4. POST /hooks/context carries the canonical control-plane block ──
    // This is the Part-1 contract: the proxy owns the single source of the
    // proxy URL + endpoint list; c-thru-session-start.sh injects it verbatim.
    console.log('\n4. POST /hooks/context returns the full control-plane block');
    const hk = await httpJson(port, 'POST', '/hooks/context', null, {}, 3000);
    assertEq(hk.status, 200, '/hooks/context returns 200');
    const addl = hk.json && hk.json.hookSpecificOutput && hk.json.hookSpecificOutput.additionalContext;
    assert(typeof addl === 'string' && addl.length > 0, 'additionalContext is a non-empty string');
    assert(addl.includes(`http://127.0.0.1:${port}`), `block carries the proxy base URL (http://127.0.0.1:${port})`);
    assert(addl.includes('/c-thru/status'), 'block lists /c-thru/status');
    assert(addl.includes('/c-thru/recent'), 'block lists /c-thru/recent');
    assert(addl.includes('/c-thru/dashboard'), 'block lists /c-thru/dashboard');
    assert(addl.includes(`http://127.0.0.1:${port}/c-thru/dashboard`), 'block surfaces the dashboard_url');

    await killAndWait(child, 'SIGTERM');
    child = null;
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch {} }
    try { await stub.close(); } catch {}
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

process.on('unhandledRejection', err => {
  console.error('unhandledRejection:', err);
  process.exit(1);
});

main().catch(err => {
  console.error(err);
  process.exit(1);
});
