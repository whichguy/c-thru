#!/usr/bin/env node
'use strict';
// C23 — control-plane authentication on MUTATING routes (hybrid loopback policy).
//
//   loopback client  → always allow (no token required) — matches default bind 127.0.0.1
//   non-loopback     → require X-C-Thru-Control matching the per-user token
//
// Non-loopback is exercised via CLAUDE_PROXY_TEST_FORCE_REMOTE_CLIENT=1 (test-only).
// READ routes (/ping, /c-thru/status, /v1/active-models, /hooks/context) stay open.
//
// Run with: node test/proxy-control-auth.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const { assert, summary, httpJson, withProxy, stubBackend } = require('./helpers');

console.log('proxy control-plane auth (C23 hybrid loopback) integration tests\n');

const TOKEN = 'a'.repeat(64);

function mkConfig(stubPort) {
  return {
    backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` } },
    model_routes: { 'wh-model': 'stub' },
    llm_profiles: { workhorse: { 'best-cloud': { '16gb': 'wh-model' } } },
  };
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-ctlauth-'));
  let stub;
  try {
    stub = await stubBackend();
    const configPath = path.join(tmpRoot, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(mkConfig(stub.port)));

    // ── 1. Loopback + token configured → mutations free (no header) ─────────
    console.log('1. loopback client → mutating routes work without token even when configured');
    await withProxy({
      configPath, profile: '16gb',
      env: { CLAUDE_LLM_MODE: 'best-cloud', CLAUDE_PROXY_CONTROL_TOKEN: TOKEN },
    }, async ({ port }) => {
      const okMode = await httpJson(port, 'POST', '/c-thru/mode', { mode: 'best-cloud' });
      assert(okMode.status === 200, `loopback no header /c-thru/mode → 200 (got ${okMode.status})`);

      const okReload = await httpJson(port, 'POST', '/c-thru/reload', {});
      assert(okReload.status === 200, `loopback no header /c-thru/reload → 200 (got ${okReload.status})`);

      const okClear = await httpJson(port, 'POST', '/c-thru/stats/clear', null);
      assert(okClear.status === 200, `loopback no header /c-thru/stats/clear → 200 (got ${okClear.status})`);

      // Token still accepted when supplied
      const withTok = await httpJson(port, 'POST', '/c-thru/mode', { mode: 'best-cloud' }, { 'X-C-Thru-Control': TOKEN });
      assert(withTok.status === 200, `loopback with correct token → 200 (got ${withTok.status})`);

      // READ routes work WITHOUT a token
      const ping = await httpJson(port, 'GET', '/ping');
      assert(ping.status === 200, `/ping (read) works without token → 200 (got ${ping.status})`);

      const status = await httpJson(port, 'GET', '/c-thru/status');
      assert(status.status === 200, `/c-thru/status (read) works without token → 200 (got ${status.status})`);

      const models = await httpJson(port, 'GET', '/v1/active-models');
      assert(models.status === 200, `/v1/active-models (read) works without token → 200 (got ${models.status})`);

      const hooks = await httpJson(port, 'POST', '/hooks/context', {});
      assert(hooks.status === 200, `/hooks/context works without token → 200 (got ${hooks.status})`);
    });

    // ── 2. Forced non-loopback + token configured → require token ───────────
    console.log('\n2. non-loopback (forced) + token configured → require X-C-Thru-Control');
    const statsFile = path.join(tmpRoot, 'usage-stats-remote.json');
    fs.writeFileSync(statsFile, JSON.stringify({
      total_input: 50,
      total_output: 5,
      total_duration_ms: 10,
      by_model: { 'wh-model': { input: 50, output: 5, calls: 7, total_duration_ms: 10, first_call: null, last_call: null } },
      by_agent: {},
      by_backend: {},
      first_recorded: '2026-01-01T00:00:00.000Z',
      last_recorded: '2026-01-02T00:00:00.000Z',
    }));
    await withProxy({
      configPath, profile: '16gb',
      env: {
        CLAUDE_LLM_MODE: 'best-cloud',
        CLAUDE_PROXY_CONTROL_TOKEN: TOKEN,
        CLAUDE_PROXY_TEST_FORCE_REMOTE_CLIENT: '1',
        CLAUDE_PROXY_USAGE_STATS_FILE: statsFile,
      },
    }, async ({ port }) => {
      const okMode = await httpJson(port, 'POST', '/c-thru/mode', { mode: 'best-cloud' }, { 'X-C-Thru-Control': TOKEN });
      assert(okMode.status === 200, `remote correct token /c-thru/mode → 200 (got ${okMode.status})`);

      const okReload = await httpJson(port, 'POST', '/c-thru/reload', {}, { 'X-C-Thru-Control': TOKEN });
      assert(okReload.status === 200, `remote correct token /c-thru/reload → 200 (got ${okReload.status})`);

      // Unauthorized clear: 403 and counters preserved
      const beforeStatus = await httpJson(port, 'GET', '/c-thru/status');
      const beforeCalls = ((beforeStatus.json || beforeStatus.body || {}).usage || {}).by_model?.['wh-model']?.calls
        || ((beforeStatus.json || beforeStatus.body || {}).usage || {}).total_input;

      const noTokClear = await httpJson(port, 'POST', '/c-thru/stats/clear', null);
      assert(noTokClear.status === 403, `remote missing token /c-thru/stats/clear → 403 (got ${noTokClear.status})`);

      const badTokClear = await httpJson(port, 'POST', '/c-thru/stats/clear', {}, { 'X-C-Thru-Control': 'b'.repeat(64) });
      assert(badTokClear.status === 403, `remote wrong token /c-thru/stats/clear → 403 (got ${badTokClear.status})`);

      const midStatus = await httpJson(port, 'GET', '/c-thru/status');
      const midUsage = (midStatus.json || midStatus.body || {}).usage || {};
      const midCalls = midUsage.by_model?.['wh-model']?.calls ?? midUsage.total_input;
      assert(midCalls === beforeCalls || midCalls === 7 || midCalls === 50,
        `unauthorized clear did not zero usage (got mid=${midCalls} before=${beforeCalls})`);

      const okClearRemote = await httpJson(port, 'POST', '/c-thru/stats/clear', {}, { 'X-C-Thru-Control': TOKEN });
      assert(okClearRemote.status === 200, `remote correct token /c-thru/stats/clear → 200 (got ${okClearRemote.status})`);
      const clearBody = okClearRemote.json || okClearRemote.body || {};
      assert(clearBody.ok === true && typeof clearBody.cleared_at === 'string',
        'remote clear returns ok + cleared_at');
      const after = (await httpJson(port, 'GET', '/c-thru/statusline')).json
        || (await httpJson(port, 'GET', '/c-thru/statusline')).body;
      // re-fetch status for usage zeros
      const afterStatus = await httpJson(port, 'GET', '/c-thru/status');
      const afterUsage = (afterStatus.json || afterStatus.body || {}).usage || {};
      const afterModelCalls = (afterUsage.by_model && afterUsage.by_model['wh-model'] && afterUsage.by_model['wh-model'].calls) || 0;
      assert(afterModelCalls === 0 && (afterUsage.total_input || 0) === 0,
        'authorized remote clear zeros counters');
      void after;

      const noTokMode = await httpJson(port, 'POST', '/c-thru/mode', { mode: 'best-cloud' });
      assert(noTokMode.status === 403, `remote missing token /c-thru/mode → 403 (got ${noTokMode.status})`);

      const noTokReload = await httpJson(port, 'POST', '/c-thru/reload', {});
      assert(noTokReload.status === 403, `remote missing token /c-thru/reload → 403 (got ${noTokReload.status})`);

      const badTok = await httpJson(port, 'POST', '/c-thru/mode', { mode: 'best-cloud' }, { 'X-C-Thru-Control': 'b'.repeat(64) });
      assert(badTok.status === 403, `remote wrong token /c-thru/mode → 403 (got ${badTok.status})`);

      const shortTok = await httpJson(port, 'POST', '/c-thru/reload', {}, { 'X-C-Thru-Control': 'short' });
      assert(shortTok.status === 403, `remote short token /c-thru/reload → 403 (got ${shortTok.status})`);

      // reads still open
      const ping = await httpJson(port, 'GET', '/ping');
      assert(ping.status === 200, `remote /ping still open → 200 (got ${ping.status})`);
    });

    // ── 3. Forced non-loopback + token ABSENT → fail closed ─────────────────
    console.log('\n3. non-loopback (forced) + token absent → 403 fail-closed');
    const logPath = path.join(tmpRoot, 'remote-notoken-proxy.log');
    await withProxy({
      configPath, profile: '16gb',
      env: {
        CLAUDE_LLM_MODE: 'best-cloud',
        CLAUDE_PROXY_LOG_FILE: logPath,
        CLAUDE_PROXY_TEST_FORCE_REMOTE_CLIENT: '1',
        // no CLAUDE_PROXY_CONTROL_TOKEN
      },
    }, async ({ port }) => {
      const failClosed = await httpJson(port, 'POST', '/c-thru/mode', { mode: 'best-cloud' });
      assert(failClosed.status === 403, `remote no token configured → 403 (got ${failClosed.status})`);

      let logText = '';
      try { logText = fs.readFileSync(logPath, 'utf8'); } catch {}
      assert(/control\.auth_disabled/.test(logText) || /control\.auth_rejected/.test(logText),
        'remote no token: control.auth_* logged');
    });

    // ── 4. Loopback + token absent → free (local adapter) ───────────────────
    console.log('\n4. loopback + token absent → mutating routes free');
    await withProxy({
      configPath, profile: '16gb',
      env: { CLAUDE_LLM_MODE: 'best-cloud' },
    }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/c-thru/mode', { mode: 'best-cloud' });
      assert(r.status === 200, `loopback no token file → 200 (got ${r.status})`);
    });
  } finally {
    try { if (stub) await stub.close(); } catch {}
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
