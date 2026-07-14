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

    // ── 1b. DOM-level structural smoke (the page's actual content, not just
    // the HTTP wiring around it) — every element the client-side JS writes
    // into by id must exist, and the page must only ever fetch its own two
    // endpoints (no accidental third-party/unexpected request target).
    console.log('\n1b. dashboard markup: expected structural elements + fetch targets');
    const EXPECTED_IDS = [
      'topbar', 'kv-mode', 'kv-tier', 'kv-port', 'kv-pid', 'kv-uptime',
      'kv-config', 'kv-default', 'conn', 'cooldown', 'recent-meta', 'recent',
      'totals-meta', 'by-model', 'by-agent', 'by-backend',
    ];
    for (const id of EXPECTED_IDS) {
      assert(new RegExp(`id="${id}"`).test(dash.bodyText), `markup has id="${id}"`);
    }
    const fetchTargets = [...dash.bodyText.matchAll(/fetch\(\s*'([^']+)'/g)].map(m => m[1]);
    assert(fetchTargets.length > 0, 'page issues at least one fetch() call');
    assert(
      fetchTargets.every(t => t.startsWith('/c-thru/status') || t.startsWith('/c-thru/recent')),
      `every fetch() target is one of the page's own two endpoints (got: ${JSON.stringify(fetchTargets)})`,
    );

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

    // ── 4. POST /hooks/context — long (SessionStart/empty) vs short (UPS prompt)
    // Proxy owns the control-plane URL + endpoint list. Long adds "when to
    // query" for rare channels only; UserPromptSubmit (prompt present) stays short.
    console.log('\n4a. POST /hooks/context empty body → long control-plane block');
    const hkLong = await httpJson(port, 'POST', '/hooks/context', null, {}, 3000);
    assertEq(hkLong.status, 200, '/hooks/context returns 200');
    const addlLong = hkLong.json && hkLong.json.hookSpecificOutput && hkLong.json.hookSpecificOutput.additionalContext;
    assert(typeof addlLong === 'string' && addlLong.length > 0, 'long additionalContext is a non-empty string');
    assert(addlLong.includes(`http://127.0.0.1:${port}`), `long block carries the proxy base URL (http://127.0.0.1:${port})`);
    assert(addlLong.includes('/c-thru/status'), 'long block lists /c-thru/status');
    assert(addlLong.includes('/c-thru/recent'), 'long block lists /c-thru/recent');
    assert(addlLong.includes('/c-thru/dashboard'), 'long block lists /c-thru/dashboard');
    assert(addlLong.includes(`http://127.0.0.1:${port}/c-thru/dashboard`), 'long block surfaces the dashboard_url');
    assert(addlLong.includes('When to query'), 'long block includes when-to-query blurb');
    assert(addlLong.includes('x-c-thru-served-by'), 'long block mentions served-by header');
    assert(addlLong.length <= 1200, `long block stays budgeted (got ${addlLong.length} chars)`);

    console.log('\n4b. POST /hooks/context event=SessionStart → long');
    const hkSs = await httpJson(port, 'POST', '/hooks/context', { event: 'SessionStart' }, {}, 3000);
    assertEq(hkSs.status, 200, 'SessionStart hooks/context 200');
    const addlSs = hkSs.json?.hookSpecificOutput?.additionalContext || '';
    assert(addlSs.includes('When to query'), 'SessionStart gets long when-to-query');

    console.log('\n4c. POST /hooks/context event=PreCompact → long');
    const hkPc = await httpJson(port, 'POST', '/hooks/context', { event: 'PreCompact' }, {}, 3000);
    assertEq(hkPc.status, 200, 'PreCompact hooks/context 200');
    const addlPc = hkPc.json?.hookSpecificOutput?.additionalContext || '';
    assert(addlPc.includes('When to query'), 'PreCompact gets long when-to-query');

    console.log('\n4d. POST /hooks/context with prompt (UPS) → short, no when-to-query');
    const hkShort = await httpJson(port, 'POST', '/hooks/context', { prompt: 'fix the typo in README' }, {}, 3000);
    assertEq(hkShort.status, 200, 'UPS hooks/context 200');
    const addlShort = hkShort.json?.hookSpecificOutput?.additionalContext || '';
    assert(addlShort.includes('/c-thru/status'), 'short block still lists status');
    assert(addlShort.includes(`http://127.0.0.1:${port}`), 'short block carries base URL');
    assert(!addlShort.includes('When to query'), 'short block omits when-to-query essay');
    assert(!addlShort.includes('x-c-thru-served-by'), 'short block omits header lecture');
    assert(addlShort.length < addlLong.length, 'short block is shorter than long');
    assert(addlShort.length <= 600, `short block stays budgeted (got ${addlShort.length} chars)`);

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
