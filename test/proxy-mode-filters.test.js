#!/usr/bin/env node
'use strict';
// Integration tests for the Phase 2 provider-filter modes.
//
// claude-only and opensource-only classify by MODEL NAME (`^claude-` regex),
// so they're cleanly testable with stub backends. cloud-only classifies by
// BACKEND METADATA which is hard to fake with localhost stubs — it has
// exhaustive unit coverage in test/model-map-filter.test.js.
//
// Each integration case asserts:
//   - x-c-thru-resolved-via.served_by matches the expected (post-filter) model
//   - the correct stub received the request
//   - hard_fail returns 502 with a clear error message
//
// Run: node test/proxy-mode-filters.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, stubBackend,
} = require('./helpers');

console.log('proxy provider-filter mode tests (claude-only / opensource-only / hard_fail)\n');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-mfilt-'));
  const claude_stub = await stubBackend();    // simulates claude-* models
  const os_stub     = await stubBackend();    // simulates open-source models

  try {
    const config = {
      backends: {
        claude_be: { kind: 'anthropic', url: `http://127.0.0.1:${claude_stub.port}` },
        os_be:     { kind: 'anthropic', url: `http://127.0.0.1:${os_stub.port}` },
      },
      model_routes: {
        // Claude models route to claude_be
        'claude-opus-test':   'claude_be',
        'claude-sonnet-test': 'claude_be',
        // Non-Claude (OS) models route to os_be
        'qwen3-test':         'os_be',
        'gemma-test':         'os_be',
      },
      llm_profiles: {
        '128gb': {
          // Capability where primary is non-Claude, fallback chain has Claude
          // Used to test claude-only swap behavior
          mixed_chain: {
            connected_model:  'qwen3-test',
            disconnect_model: 'qwen3-test',
          },
          // Capability with Claude primary + OS fallback
          // Used to test opensource-only swap behavior
          claude_primary: {
            connected_model:  'claude-opus-test',
            disconnect_model: 'qwen3-test',
          },
          // Capability with all-Claude chain — used for opensource-only hard_fail
          all_claude: {
            connected_model:  'claude-opus-test',
            disconnect_model: 'claude-sonnet-test',
          },
        },
      },
      fallback_chains: {
        '128gb': {
          mixed_chain: [
            { model: 'qwen3-test',         quality_score: 80 },
            { model: 'claude-sonnet-test', quality_score: 90 },  // Claude
            { model: 'gemma-test',         quality_score: 70 },
          ],
          claude_primary: [
            { model: 'claude-opus-test',   quality_score: 95 },
            { model: 'qwen3-test',         quality_score: 80 },  // OS fallback
          ],
          all_claude: [
            { model: 'claude-opus-test',   quality_score: 95 },
            { model: 'claude-sonnet-test', quality_score: 90 },
            // No OS option → opensource-only must hard_fail
          ],
        },
      },
    };
    const configPath = writeConfig(tmpDir, config);

    const send = (port, model) => httpJson(port, 'POST', '/v1/messages', {
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    }, {}, 5000);
    const via = r => JSON.parse(r.headers['x-c-thru-resolved-via'] || '{}');

    // ── Test 1: claude-only with non-Claude primary → swap to chain Claude ──
    console.log('1. claude-only: qwen primary rejected, claude-sonnet-test from chain');
    claude_stub.requests.length = 0; os_stub.requests.length = 0;
    await withProxy({
      configPath, profile: '128gb', mode: 'claude-only',
      env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
    }, async ({ port }) => {
      const r = await send(port, 'mixed_chain');
      assertEq(r.status, 200, 'status 200');
      assertEq(via(r).served_by, 'claude-sonnet-test',
        'filter walked past qwen3-test, picked claude-sonnet-test');
      assertEq(via(r).mode, 'claude-only', 'header mode = claude-only');
      // After filter swap, the original capability/tier metadata MUST survive —
      // headers should reflect the requested capability, not the swapped model
      assertEq(via(r).capability, 'mixed_chain',
        'capability preserved across filter swap (regression guard)');
      assertEq(via(r).tier, '128gb', 'tier preserved across filter swap');
      assertEq(claude_stub.requests.length, 1, 'claude stub got request');
      assertEq(os_stub.requests.length, 0, 'os stub NOT touched after filter');
    });

    // ── Test 2: claude-only with Claude primary → no swap ──────────────────
    console.log('\n2. claude-only: Claude primary passes filter unchanged');
    claude_stub.requests.length = 0; os_stub.requests.length = 0;
    await withProxy({
      configPath, profile: '128gb', mode: 'claude-only',
      env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
    }, async ({ port }) => {
      const r = await send(port, 'claude_primary');
      assertEq(r.status, 200, 'status 200');
      assertEq(via(r).served_by, 'claude-opus-test', 'Claude primary served unchanged');
      assertEq(claude_stub.requests.length, 1, 'claude stub got request');
      assertEq(os_stub.requests.length, 0, 'os stub NOT touched');
    });

    // ── Test 3: opensource-only with Claude primary → swap to OS in chain ──
    console.log('\n3. opensource-only: Claude primary rejected, qwen3-test from chain');
    claude_stub.requests.length = 0; os_stub.requests.length = 0;
    await withProxy({
      configPath, profile: '128gb', mode: 'opensource-only',
      env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
    }, async ({ port }) => {
      // claude_primary capability: opensource-only resolves to disconnect_model = qwen3-test (OS already)
      // So no swap needed — primary is already compliant.
      const r = await send(port, 'claude_primary');
      assertEq(r.status, 200, 'status 200');
      assertEq(via(r).served_by, 'qwen3-test',
        'opensource-only resolves to OS disconnect_model directly');
      assertEq(via(r).mode, 'opensource-only', 'header mode = opensource-only');
      assertEq(os_stub.requests.length, 1, 'os stub got request');
      assertEq(claude_stub.requests.length, 0, 'claude stub NOT touched');
    });

    // ── Test 4: opensource-only forced swap (capability with all_claude chain) ─
    // Use mixed_chain capability with claude-only override forcing Claude primary,
    // then opensource-only mode walks chain to find OS.
    console.log('\n4. opensource-only: when override forces Claude primary, filter walks to OS');
    claude_stub.requests.length = 0; os_stub.requests.length = 0;
    // Build a tweaked config with modes['opensource-only'] explicitly set to Claude
    // (forcing the filter to swap)
    const swapConfig = JSON.parse(JSON.stringify(config));
    swapConfig.llm_profiles['128gb'].mixed_chain.modes = {
      'opensource-only': 'claude-opus-test',  // forces Claude to be the primary
    };
    const swapConfigPath = writeConfig(tmpDir, swapConfig);
    await withProxy({
      configPath: swapConfigPath, profile: '128gb', mode: 'opensource-only',
      env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
    }, async ({ port }) => {
      const r = await send(port, 'mixed_chain');
      assertEq(r.status, 200, 'status 200');
      assertEq(via(r).served_by, 'qwen3-test',
        'opensource-only filter swapped Claude→OS via fallback chain');
      assertEq(os_stub.requests.length, 1, 'os stub got request after filter swap');
      assertEq(claude_stub.requests.length, 0, 'claude stub NOT touched (filtered out)');
    });

    // ── Test 5: opensource-only hard_fail when chain has no OS ─────────────
    console.log('\n5. opensource-only: all-Claude chain → 502 hard_fail');
    claude_stub.requests.length = 0; os_stub.requests.length = 0;
    await withProxy({
      configPath, profile: '128gb', mode: 'opensource-only',
      env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
    }, async ({ port }) => {
      // all_claude.disconnect_model = claude-sonnet-test (Claude). opensource-only
      // resolves to that, filter rejects it, walks chain (all Claude), returns null.
      const r = await send(port, 'all_claude');
      assertEq(r.status, 502, 'hard_fail status 502');
      const msg = r.json?.error?.message || '';
      assert(msg.includes('opensource-only'), `error mentions mode (got ${JSON.stringify(msg)})`);
      assert(msg.includes('all_claude'), `error mentions capability (got ${JSON.stringify(msg)})`);
      assertEq(claude_stub.requests.length, 0, 'no upstream call (filter rejected)');
      assertEq(os_stub.requests.length, 0, 'no upstream call');
    });

    // ── Test 6: claude-only hard_fail when chain has no Claude ─────────────
    console.log('\n6. claude-only: all-OS chain → 502 hard_fail');
    claude_stub.requests.length = 0; os_stub.requests.length = 0;
    // Build config with all-OS capability for claude-only test
    const allOSConfig = {
      backends: config.backends,
      model_routes: config.model_routes,
      llm_profiles: {
        '128gb': {
          all_os: {
            connected_model:  'qwen3-test',
            disconnect_model: 'qwen3-test',
          },
        },
      },
      fallback_chains: {
        '128gb': {
          all_os: [
            { model: 'qwen3-test', quality_score: 80 },
            { model: 'gemma-test', quality_score: 70 },
          ],
        },
      },
    };
    const allOSConfigPath = writeConfig(tmpDir, allOSConfig);
    await withProxy({
      configPath: allOSConfigPath, profile: '128gb', mode: 'claude-only',
      env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
    }, async ({ port }) => {
      const r = await send(port, 'all_os');
      assertEq(r.status, 502, 'hard_fail status 502');
      const msg = r.json?.error?.message || '';
      assert(msg.includes('claude-only'), `error mentions claude-only mode`);
      assertEq(claude_stub.requests.length, 0, 'no upstream call');
      assertEq(os_stub.requests.length, 0, 'no upstream call');
    });

  } finally {
    await claude_stub.close().catch(() => {});
    await os_stub.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
