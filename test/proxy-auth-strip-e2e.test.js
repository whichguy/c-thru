#!/usr/bin/env node
'use strict';
// C12 — outbound auth-leak prevention, SPAWNED-PROXY (end-to-end) coverage.
//
// THREAT: this proxy fronts Claude Code, so an inbound request's
// `Authorization: Bearer …` / `x-api-key` carry the user's Anthropic
// subscription OAuth or API key. Forwarding those verbatim to an arbitrary
// UNKNOWN, non-Anthropic backend would leak Anthropic credentials. The C12 fix
// (applyOutboundAuth, profile === 'passthrough' branch) STRIPS them for an
// unknown host with no explicit auth, UNLESS backend.kind === 'anthropic' or
// backend.auth_passthrough === true.
//
// WHY THIS FILE EXISTS (the structural gap it closes):
// The integration harness binds every stub on 127.0.0.1, and deriveAuthProfile
// maps loopback to profile 'none' (always-forward). So a spawned proxy can never
// reach the unknown-host STRIP branch through a loopback stub — and the only
// other C12 coverage (test/proxy-quality.test.js Phase 6) is a fragile
// new Function() string-extraction of the private applyOutboundAuth, not a real
// request through a live proxy.
//
// HOW WE REACH THE BRANCH (test-only, env-gated source hook):
// claude-proxy's deriveAuthProfile honors CLAUDE_PROXY_TEST_UNKNOWN_HOST_BACKENDS
// (comma-separated backend ids). For listed ids it returns null — i.e. forces the
// exact "unknown host" classification a genuine non-KNOWN_HOSTS host would derive
// — while the request still connects to the loopback stub so we can inspect what
// the backend actually received. The env var is set NOWHERE in production launch
// or config paths, so the override is inert outside tests. This buys a real
// end-to-end assertion (live proxy → live backend → captured headers) without
// weakening the security posture.
//
// Run with: node test/proxy-auth-strip-e2e.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const { assert, assertEq, summary, httpJson, withProxy, stubBackend } = require('./helpers');

console.log('proxy outbound auth-leak prevention (C12) — spawned-proxy e2e\n');

// Incoming Anthropic credentials a real Claude Code request would carry.
const USER_OAUTH = 'Bearer sk-ant-oat01-USER-SUBSCRIPTION';
const USER_APIKEY = 'sk-ant-api03-USER-APIKEY';
const INCOMING = { 'authorization': USER_OAUTH, 'x-api-key': USER_APIKEY };

// All four backends point at loopback stubs (the only thing the harness can
// bind). model_routes give each a direct, profile-free route key so a request
// with `body.model = <key>` resolves straight to that backend.
function mkConfig(ports) {
  return {
    backends: {
      // (1) UNKNOWN, non-anthropic, no explicit auth → forced unknown-host via
      //     the test env var → applyOutboundAuth must STRIP incoming auth.
      unknown_strip:     { kind: 'custom',    url: `http://127.0.0.1:${ports.strip}`,     format: 'anthropic' },
      // (a) positive control: kind:'anthropic' → FORWARD (genuine Anthropic family).
      anthropic_kind:    { kind: 'anthropic', url: `http://127.0.0.1:${ports.anthropic}`, format: 'anthropic' },
      // (b) positive control: auth_passthrough:true → FORWARD (explicit opt-in).
      optin_passthrough: { kind: 'custom',    url: `http://127.0.0.1:${ports.optin}`,     format: 'anthropic', auth_passthrough: true },
      // (c) positive control: loopback, NOT forced unknown → derives 'none' → FORWARD (today's behavior).
      loopback_none:     { kind: 'custom',    url: `http://127.0.0.1:${ports.none}`,       format: 'anthropic' },
    },
    model_routes: {
      'strip-model':       'unknown_strip',
      'anthropic-model':   'anthropic_kind',
      'optin-model':       'optin_passthrough',
      'none-model':        'loopback_none',
    },
  };
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-authstrip-'));
  let stripStub, anthropicStub, optinStub, noneStub;
  try {
    stripStub     = await stubBackend();
    anthropicStub = await stubBackend();
    optinStub     = await stubBackend();
    noneStub      = await stubBackend();

    const configPath = path.join(tmpRoot, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(mkConfig({
      strip:     stripStub.port,
      anthropic: anthropicStub.port,
      optin:     optinStub.port,
      none:      noneStub.port,
    })));

    const logPath = path.join(tmpRoot, 'proxy.log');

    await withProxy({
      configPath,
      env: {
        // TEST-ONLY: force unknown-host classification ONLY for the strip and the
        // two opt-in/anthropic positive controls. loopback_none is intentionally
        // omitted so it stays profile 'none' (forward) — proving the strip is
        // driven by the unknown-host classification, not by being a stub.
        CLAUDE_PROXY_TEST_UNKNOWN_HOST_BACKENDS: 'unknown_strip,anthropic_kind,optin_passthrough',
        CLAUDE_PROXY_LOG_FILE: logPath,
      },
    }, async ({ port }) => {
      const body = (model) => ({ model, messages: [{ role: 'user', content: 'hi' }] });

      // ── STRIP: unknown host, non-anthropic, no opt-in → auth must NOT reach backend
      console.log('1. unknown non-anthropic host (no opt-in) → incoming Anthropic auth STRIPPED');
      const stripRes = await httpJson(port, 'POST', '/v1/messages', body('strip-model'), INCOMING);
      assertEq(stripRes.status, 200, 'strip backend served the request (proxy did not error)');
      const stripReq = stripStub.lastRequest();
      assert(stripReq !== null, 'strip backend received the forwarded request');
      assertEq(stripReq.headers['authorization'], undefined, 'authorization STRIPPED (not leaked to unknown host)');
      assertEq(stripReq.headers['x-api-key'], undefined, 'x-api-key STRIPPED (not leaked to unknown host)');

      // ── (a) kind:'anthropic' → forward
      console.log('2. unknown host + kind:anthropic → incoming Bearer FORWARDED');
      await httpJson(port, 'POST', '/v1/messages', body('anthropic-model'), INCOMING);
      const aReq = anthropicStub.lastRequest();
      assert(aReq !== null, 'anthropic-kind backend received the request');
      // bearer_priority: incoming Bearer wins, incoming x-api-key dropped (not the C12 strip).
      assertEq(aReq.headers['authorization'], USER_OAUTH, 'incoming Bearer forwarded for kind:anthropic');

      // ── (b) auth_passthrough:true → forward both verbatim
      console.log('3. unknown host + auth_passthrough:true → incoming auth FORWARDED verbatim');
      await httpJson(port, 'POST', '/v1/messages', body('optin-model'), INCOMING);
      const oReq = optinStub.lastRequest();
      assert(oReq !== null, 'opt-in backend received the request');
      assertEq(oReq.headers['authorization'], USER_OAUTH, 'authorization forwarded on explicit auth_passthrough opt-in');
      assertEq(oReq.headers['x-api-key'], USER_APIKEY, 'x-api-key forwarded on explicit auth_passthrough opt-in');

      // ── (c) loopback 'none' (NOT forced unknown) → forward (today's behavior)
      console.log('4. loopback (derived "none", not forced unknown) → incoming auth FORWARDED');
      await httpJson(port, 'POST', '/v1/messages', body('none-model'), INCOMING);
      const nReq = noneStub.lastRequest();
      assert(nReq !== null, 'loopback-none backend received the request');
      assertEq(nReq.headers['authorization'], USER_OAUTH, 'authorization preserved on derived "none" loopback');
      assertEq(nReq.headers['x-api-key'], USER_APIKEY, 'x-api-key preserved on derived "none" loopback');

      // ── observability: the strip path emits an audit log line.
      console.log('5. strip path emits auth.strip_incoming_unknown_host audit event');
      let logText = '';
      try { logText = fs.readFileSync(logPath, 'utf8'); } catch {}
      assert(/auth\.strip_incoming_unknown_host/.test(logText), 'strip event logged for the unknown-host backend');
      assert(/"backend":"unknown_strip"/.test(logText), 'strip event names the offending backend id');
    });
  } finally {
    try { if (stripStub) await stripStub.close(); } catch {}
    try { if (anthropicStub) await anthropicStub.close(); } catch {}
    try { if (optinStub) await optinStub.close(); } catch {}
    try { if (noneStub) await noneStub.close(); } catch {}
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
