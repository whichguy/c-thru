#!/usr/bin/env node
'use strict';
// C23 — control-plane authentication on MUTATING routes.
// The proxy binds 127.0.0.1 and is SHARED across parallel c-thru sessions, so a
// per-user control token (0600 file ~/.claude/proxy.control-token, mirrored by
// the CLAUDE_PROXY_CONTROL_TOKEN env override the harness uses) gates the three
// mutating routes: POST /c-thru/mode, /c-thru/reload, /c-thru/stats/clear.
//   token present → require X-C-Thru-Control header (timingSafeEqual) → 403 else
//   token absent  → FAIL OPEN + one-time warning (today's behavior preserved)
// READ routes (/ping, /c-thru/status, /v1/active-models, /hooks/context) stay open.
//
// Run with: node test/proxy-control-auth.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const { assert, summary, httpJson, withProxy, stubBackend } = require('./helpers');

console.log('proxy control-plane auth (C23) integration tests\n');

const TOKEN = 'a'.repeat(64); // 64-hex stand-in for the per-user control token

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

    // ── 1. Token CONFIGURED (via env override) ───────────────────────────────
    console.log('1. token configured → mutating routes require X-C-Thru-Control');
    await withProxy({
      configPath, profile: '16gb',
      env: { CLAUDE_LLM_MODE: 'best-cloud', CLAUDE_PROXY_CONTROL_TOKEN: TOKEN },
    }, async ({ port }) => {
      // correct token → 200
      const okMode = await httpJson(port, 'POST', '/c-thru/mode', { mode: 'best-cloud' }, { 'X-C-Thru-Control': TOKEN });
      assert(okMode.status === 200, `correct token on /c-thru/mode → 200 (got ${okMode.status})`);

      const okReload = await httpJson(port, 'POST', '/c-thru/reload', {}, { 'X-C-Thru-Control': TOKEN });
      assert(okReload.status === 200, `correct token on /c-thru/reload → 200 (got ${okReload.status})`);

      const okClear = await httpJson(port, 'POST', '/c-thru/stats/clear', null, { 'X-C-Thru-Control': TOKEN });
      assert(okClear.status === 200, `correct token on /c-thru/stats/clear → 200 (got ${okClear.status})`);

      // missing token → 403
      const noTokMode = await httpJson(port, 'POST', '/c-thru/mode', { mode: 'best-cloud' });
      assert(noTokMode.status === 403, `missing token on /c-thru/mode → 403 (got ${noTokMode.status})`);

      const noTokReload = await httpJson(port, 'POST', '/c-thru/reload', {});
      assert(noTokReload.status === 403, `missing token on /c-thru/reload → 403 (got ${noTokReload.status})`);

      const noTokClear = await httpJson(port, 'POST', '/c-thru/stats/clear', null);
      assert(noTokClear.status === 403, `missing token on /c-thru/stats/clear → 403 (got ${noTokClear.status})`);

      // wrong token → 403
      const badTok = await httpJson(port, 'POST', '/c-thru/mode', { mode: 'best-cloud' }, { 'X-C-Thru-Control': 'b'.repeat(64) });
      assert(badTok.status === 403, `wrong token on /c-thru/mode → 403 (got ${badTok.status})`);

      // wrong-length token → 403 (timingSafeEqual length guard)
      const shortTok = await httpJson(port, 'POST', '/c-thru/reload', {}, { 'X-C-Thru-Control': 'short' });
      assert(shortTok.status === 403, `wrong-length token on /c-thru/reload → 403 (got ${shortTok.status})`);

      // READ routes work WITHOUT a token
      const ping = await httpJson(port, 'GET', '/ping');
      assert(ping.status === 200, `/ping (read) works without token → 200 (got ${ping.status})`);

      const status = await httpJson(port, 'GET', '/c-thru/status');
      assert(status.status === 200, `/c-thru/status (read) works without token → 200 (got ${status.status})`);

      const models = await httpJson(port, 'GET', '/v1/active-models');
      assert(models.status === 200, `/v1/active-models (read) works without token → 200 (got ${models.status})`);

      const hooks = await httpJson(port, 'POST', '/hooks/context', {});
      assert(hooks.status === 200, `/hooks/context (read-ish, ungated) works without token → 200 (got ${hooks.status})`);
    });

    // ── 2. Token ABSENT → fail-open + one-time warning ────────────────────────
    console.log('\n2. token absent → fail-open (mutating routes still work) + warning');
    // Point the proxy log at a path we control so the prominent advisory is
    // assertable (proxyLog writes to CLAUDE_PROXY_LOG_FILE when set).
    const logPath = path.join(tmpRoot, 'failopen-proxy.log');
    await withProxy({
      configPath, profile: '16gb',
      env: { CLAUDE_LLM_MODE: 'best-cloud', CLAUDE_PROXY_LOG_FILE: logPath }, // no token → fail-open
    }, async ({ port }) => {
      const failOpenMode = await httpJson(port, 'POST', '/c-thru/mode', { mode: 'best-cloud' });
      assert(failOpenMode.status === 200, `token absent: /c-thru/mode without header → 200 fail-open (got ${failOpenMode.status})`);

      const failOpenClear = await httpJson(port, 'POST', '/c-thru/stats/clear', null);
      assert(failOpenClear.status === 200, `token absent: /c-thru/stats/clear without header → 200 fail-open (got ${failOpenClear.status})`);

      let logText = '';
      try { logText = fs.readFileSync(logPath, 'utf8'); } catch {}
      assert(/control\.auth_disabled/.test(logText) && /UNAUTHENTICATED/.test(logText),
        'token absent: prominent fail-open warning (control.auth_disabled / UNAUTHENTICATED) is logged');
    });
  } finally {
    try { if (stub) await stub.close(); } catch {}
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
