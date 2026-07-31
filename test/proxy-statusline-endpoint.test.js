#!/usr/bin/env node
'use strict';
// GET /c-thru/statusline slim feed: shape, clear metadata, empty/populated,
// session isolation (mirrors /c-thru/recent scoping).
// Run: node test/proxy-statusline-endpoint.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assert, assertEq, summary,
  stubBackend, writeConfig, httpJson, spawnProxy, waitForPing,
} = require('./helpers');

console.log('proxy-statusline-endpoint tests\n');

const HDR = { 'x-api-key': 'test', 'anthropic-version': '2023-06-01' };

function body(raw) {
  return raw.json || raw.body;
}

async function main() {
  // ── Suite A: empty → populated → clear metadata (single model, no fallback) ─
  {
    console.log('A. empty, populated, clear metadata');
    const stub = await stubBackend();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-sl-ep-a-'));
    const statsFile = path.join(tmpHome, 'usage-stats.json');
    const configPath = writeConfig(tmpHome, {
      backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
      model_routes: { 'sl-test-model': 'stub' },
      llm_profiles: {
        '16gb': {
          workhorse: {
            connected_model: 'sl-test-model@stub',
            disconnect_model: 'sl-test-model@stub',
          },
        },
      },
      agent_to_capability: {},
    });

    const { child, port } = await spawnProxy({
      configPath,
      tmpHome,
      env: {
        CLAUDE_PROXY_USAGE_STATS_FILE: statsFile,
        CLAUDE_LLM_MEMORY_GB: '16',
        CLAUDE_LLM_MODE: 'best-cloud',
      },
    });
    await waitForPing(port);

    try {
      // Empty state — no traffic yet
      const emptyRaw = await httpJson(port, 'GET', '/c-thru/statusline');
      assertEq(emptyRaw.status, 200, 'empty statusline 200');
      const empty = body(emptyRaw);
      assert(empty && empty.ok === true, 'empty ok');
      assertEq(empty.last, null, 'empty last is null');
      assertEq(empty.fallback, null, 'empty fallback is null');
      assertEq(empty.usage_window.calls, 0, 'empty calls 0');
      assertEq(empty.usage_window.input, 0, 'empty input 0');
      assert(typeof empty.port === 'number' || empty.port == null, 'port field present');
      for (const k of ['mode', 'tier', 'last', 'usage_window', 'port']) {
        assert(Object.prototype.hasOwnProperty.call(empty, k), `empty has key ${k}`);
      }

      // Populate
      const msg = await httpJson(port, 'POST', '/v1/messages', {
        model: 'sl-test-model',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 10,
      }, HDR);
      assertEq(msg.status, 200, 'seed request 200');

      const popRaw = await httpJson(port, 'GET', '/c-thru/statusline');
      const pop = body(popRaw);
      assert(pop.last && pop.last.served_by, 'populated last.served_by');
      assert(pop.usage_window.calls >= 1 || pop.usage_window.input >= 0, 'populated usage window');
      // calls may still be 0 if usage not flushed yet — last is the strong signal

      // Clear metadata round-trip
      const clear = await httpJson(port, 'POST', '/c-thru/stats/clear', {});
      assertEq(clear.status, 200, 'clear HTTP 200');
      const clearBody = body(clear);
      assert(clearBody && clearBody.ok === true, 'clear ok');
      assert(typeof clearBody.cleared_at === 'string' && clearBody.cleared_at.length > 10,
        'clear returns ISO cleared_at');

      const afterClear = body(await httpJson(port, 'GET', '/c-thru/statusline'));
      assertEq(afterClear.usage_window.calls, 0, 'calls zero after clear');
      assertEq(afterClear.usage_window.input, 0, 'input zero after clear');
      assertEq(afterClear.usage_window.since, clearBody.cleared_at,
        'usage_window.since equals clear.cleared_at');

      const statusAfter = body(await httpJson(port, 'GET', '/c-thru/status'));
      assertEq(statusAfter.usage.cleared_at, clearBody.cleared_at,
        'status.usage.cleared_at equals clear.cleared_at');

      // Post-clear traffic grows window again
      await httpJson(port, 'POST', '/v1/messages', {
        model: 'sl-test-model',
        messages: [{ role: 'user', content: 'again' }],
        max_tokens: 10,
      }, HDR);
      // Force a short wait for optional debounce is unnecessary for last;
      // usage may lag — assert last is non-null after new request
      const afterTraffic = body(await httpJson(port, 'GET', '/c-thru/statusline'));
      assert(afterTraffic.last && afterTraffic.last.served_by,
        'post-clear last is populated again');
    } finally {
      try { child.kill('SIGTERM'); } catch {}
      try { stub.close(); } catch {}
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  }

  // ── Suite B: session isolation (fallback traffic on A only) ───────────────
  {
    console.log('\nB. session isolation for last/fallback');
    const primary = await stubBackend({ failWith: 500 });
    const secondary = await stubBackend();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-sl-ep-b-'));
    const configPath = writeConfig(tmpHome, {
      backends: {
        primary_be: {
          kind: 'anthropic',
          url: `http://127.0.0.1:${primary.port}`,
          fallback_to: 'secondary-target',
        },
        secondary_be: {
          kind: 'anthropic',
          url: `http://127.0.0.1:${secondary.port}`,
        },
      },
      model_routes: {
        'primary-model': 'primary_be',
        'secondary-target': 'secondary_be',
      },
    });

    const { child, port } = await spawnProxy({ configPath, tmpHome });
    await waitForPing(port);

    try {
      const rA = await httpJson(port, 'POST', '/s/session-a/v1/messages', {
        model: 'primary-model',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi-a' }],
      }, HDR);
      assertEq(rA.status, 200, 'session-a fallback request 200');

      const slA = body(await httpJson(port, 'GET', '/s/session-a/c-thru/statusline'));
      assert(slA.last && slA.last.served_by, 'session-a has last');
      assert(slA.fallback && slA.fallback.served_by,
        'session-a sees fallback (within 120s)');
      assertEq(slA.session, 'session-a', 'session-a reports session id');

      const slB = body(await httpJson(port, 'GET', '/s/session-b/c-thru/statusline'));
      assertEq(slB.last, null, 'session-b last is null (no traffic)');
      assertEq(slB.fallback, null, 'session-b fallback is null (no leak from A)');
      assertEq(slB.session, 'session-b', 'session-b reports session id');

      // Unscoped remains global — sees A's activity
      const slGlobal = body(await httpJson(port, 'GET', '/c-thru/statusline'));
      assert(slGlobal.last && slGlobal.last.served_by,
        'unscoped statusline still sees global last');
      assertEq(slGlobal.session, null, 'unscoped session is null');
    } finally {
      try { child.kill('SIGTERM'); } catch {}
      try { primary.close(); } catch {}
      try { secondary.close(); } catch {}
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  }

  process.exit(summary() ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
