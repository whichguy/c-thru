#!/usr/bin/env node
'use strict';
// Tests for recordUsage debounce flush and SIGTERM flush in claude-proxy.
//
// recordUsage() (tools/claude-proxy L318) accumulates token counts in memory and
// schedules a debounced write via scheduleUsageFlush() (L349).
// flushPersistentUsageNowSync() (L361) is called on SIGTERM/SIGINT so the last
// debounce window's data is not lost.
//
// USAGE_FLUSH_DEBOUNCE_MS is hardcoded to 5000ms.
// CLAUDE_PROXY_USAGE_STATS_FILE overrides the stats file path (L289).
//
// Test A: debounce flush — send a /v1/messages request that produces token
//   usage, wait 6s (>5s debounce), verify usage-stats.json written with counts.
//
// Test B: SIGTERM flush — send request, immediately SIGTERM the proxy, verify
//   usage-stats.json exists (sync flush from SIGTERM handler, L1615).
//
// Run: node test/proxy-usage-stats.test.js

const fs   = require('fs');
const http = require('http');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  stubBackend, writeConfig, httpJson, spawnProxy, waitForPing,
} = require('./helpers');

console.log('proxy-usage-stats tests\n');

// ── Config builder (mirrors proxy-messages.test.js) ───────────────────────

const CONCRETE_MODEL = 'stats-test-model';

function buildConfig(stubPort) {
  return {
    backends: {
      stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    model_routes: {
      [CONCRETE_MODEL]: 'stub',
    },
    llm_profiles: {
      '16gb': {
        workhorse: {
          connected_model:  `${CONCRETE_MODEL}@stub`,
          disconnect_model: `${CONCRETE_MODEL}@stub`,
        },
      },
    },
    agent_to_capability: {},
  };
}

// Minimal /v1/messages body that the proxy will forward.
const MSG_BODY = {
  model: CONCRETE_MODEL,
  messages: [{ role: 'user', content: 'ping' }],
  max_tokens: 10,
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Test helpers ───────────────────────────────────────────────────────────

// Spawn a fully-configured proxy pointing at a stub backend.
// Returns { child, port, statsFile, tmpHome, configPath, stub }.
async function spawnUsageProxy() {
  const stub = await stubBackend();

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-usage-'));
  const statsFile = path.join(tmpHome, 'usage-stats.json');

  // Write config into tmpHome
  const configPath = writeConfig(tmpHome, buildConfig(stub.port));

  const { child, port } = await spawnProxy({
    configPath,
    tmpHome,
    env: {
      CLAUDE_PROXY_USAGE_STATS_FILE: statsFile,
    },
  });

  await waitForPing(port, 5000);

  return { child, port, statsFile, tmpHome, configPath, stub };
}

function killAndWait(child, signal = 'SIGTERM') {
  return new Promise(resolve => {
    // Guard: if already exited, resolve immediately.
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.on('exit', finish);
    try { child.kill(signal); } catch {}
    // Escalate to SIGKILL after 3s if still alive
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(); }, 3000);
  });
}

function cleanup(tmpHome) {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
}

// ── Test A: debounce flush (5s window) ────────────────────────────────────

async function testDebounceFlush() {
  console.log('Test A: debounce flush — wait for scheduleUsageFlush timeout');
  let state;
  try {
    state = await spawnUsageProxy();
    const { child, port, statsFile, tmpHome, stub } = state;

    // Send one /v1/messages request — the stub returns usage:{input:1,output:1}.
    const { status } = await httpJson(port, 'POST', '/v1/messages', MSG_BODY, {
      'x-api-key': 'test',
      'anthropic-version': '2023-06-01',
    });
    assertEq(status, 200, 'Test A: /v1/messages returned 200');

    // Stats file should NOT exist yet (debounce window hasn't elapsed).
    assert(
      !fs.existsSync(statsFile),
      'Test A: stats file not written immediately after request (debounce pending)'
    );

    // Wait for the debounce flush (5s + 1.5s grace).
    await sleep(6500);

    assert(
      fs.existsSync(statsFile),
      'Test A: stats file written after 6.5s debounce window'
    );

    const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    assert(
      stats.total_input >= 1,
      `Test A: total_input >= 1 (got ${stats.total_input})`
    );
    assert(
      stats.total_output >= 1,
      `Test A: total_output >= 1 (got ${stats.total_output})`
    );
    assert(
      stats.by_model && stats.by_model[CONCRETE_MODEL],
      `Test A: by_model entry for ${CONCRETE_MODEL} present`
    );
    const byModel = stats.by_model[CONCRETE_MODEL];
    assertEq(byModel.calls, 1, 'Test A: by_model[model].calls === 1');

    assert(
      stats.by_backend && stats.by_backend['stub'],
      'Test A: by_backend.stub entry present'
    );
    assertEq(stats.by_backend['stub'].calls, 1, 'Test A: by_backend.stub.calls === 1');
    assert(stats.first_recorded !== null, 'Test A: first_recorded is set');
    assert(stats.last_recorded !== null,  'Test A: last_recorded is set');

    await killAndWait(child);
    await stub.close();
    cleanup(tmpHome);
  } catch (e) {
    if (state) {
      try { state.child.kill('SIGKILL'); } catch {}
      try { await state.stub.close(); } catch {}
      cleanup(state.tmpHome);
    }
    throw e;
  }
}

// ── Test B: SIGTERM flush (sync, no waiting) ──────────────────────────────

async function testSigtermFlush() {
  console.log('\nTest B: SIGTERM flush — stats written synchronously before exit');
  let state;
  try {
    state = await spawnUsageProxy();
    const { child, port, statsFile, tmpHome, stub } = state;

    // Send request to record usage in memory.
    const { status } = await httpJson(port, 'POST', '/v1/messages', MSG_BODY, {
      'x-api-key': 'test',
      'anthropic-version': '2023-06-01',
    });
    assertEq(status, 200, 'Test B: /v1/messages returned 200');

    // Confirm the debounce hasn't fired yet (< 1s since request).
    assert(
      !fs.existsSync(statsFile),
      'Test B: stats file not yet written before SIGTERM (debounce pending)'
    );

    // SIGTERM — the handler calls flushPersistentUsageNowSync() then process.exit(0).
    await killAndWait(child, 'SIGTERM');

    // After the process exits, the sync flush must have written the file.
    assert(
      fs.existsSync(statsFile),
      'Test B: stats file written synchronously by SIGTERM handler'
    );

    const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    assert(
      stats.total_input >= 1,
      `Test B: total_input >= 1 (got ${stats.total_input})`
    );
    assert(
      stats.total_output >= 1,
      `Test B: total_output >= 1 (got ${stats.total_output})`
    );
    assert(
      stats.by_model && stats.by_model[CONCRETE_MODEL],
      `Test B: by_model entry for ${CONCRETE_MODEL} present after SIGTERM flush`
    );
    assertEq(
      stats.by_model[CONCRETE_MODEL].calls,
      1,
      'Test B: by_model[model].calls === 1 after SIGTERM'
    );

    await stub.close();
    cleanup(tmpHome);
  } catch (e) {
    if (state) {
      try { state.child.kill('SIGKILL'); } catch {}
      try { await state.stub.close(); } catch {}
      cleanup(state.tmpHome);
    }
    throw e;
  }
}

// ── Test C: multiple requests accumulate before flush ─────────────────────

async function testMultipleRequests() {
  console.log('\nTest C: multiple requests accumulate into a single flush');
  let state;
  try {
    state = await spawnUsageProxy();
    const { child, port, statsFile, tmpHome, stub } = state;

    // Fire 3 requests in quick succession — all coalesced in one debounce window.
    for (let i = 0; i < 3; i++) {
      const { status } = await httpJson(port, 'POST', '/v1/messages', MSG_BODY, {
        'x-api-key': 'test',
        'anthropic-version': '2023-06-01',
      });
      assertEq(status, 200, `Test C: request ${i + 1} returned 200`);
    }

    // SIGTERM flush to avoid waiting 5s.
    await killAndWait(child, 'SIGTERM');

    assert(fs.existsSync(statsFile), 'Test C: stats file exists after SIGTERM');
    const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    assertEq(
      stats.by_model[CONCRETE_MODEL].calls,
      3,
      'Test C: 3 calls accumulated before flush'
    );
    assert(
      stats.total_input >= 3,
      `Test C: total_input >= 3 (got ${stats.total_input})`
    );

    await stub.close();
    cleanup(tmpHome);
  } catch (e) {
    if (state) {
      try { state.child.kill('SIGKILL'); } catch {}
      try { await state.stub.close(); } catch {}
      cleanup(state.tmpHome);
    }
    throw e;
  }
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  await testDebounceFlush();
  await testSigtermFlush();
  await testMultipleRequests();

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
