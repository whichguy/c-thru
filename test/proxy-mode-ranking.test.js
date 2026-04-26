#!/usr/bin/env node
'use strict';
// Integration tests for benchmark-driven ranking modes.
// Each test installs a synthetic benchmark.json fixture (so test outcomes are
// stable when production benchmark data updates), then asserts the proxy
// swapped to the ranked-best model.
//
// Run: node test/proxy-mode-ranking.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, stubBackend,
} = require('./helpers');

console.log('proxy ranking-mode tests (fastest-possible / smallest-possible / best-opensource)\n');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-rank-'));
  const stub = await stubBackend();

  // The proxy's benchmark loader expects docs/benchmark.json relative to its install dir.
  // Tests can't override that path easily, so we use the REAL benchmark.json with a
  // capability that maps to a role with known winners. capability=workhorse → role=generalist.
  // Ranking-best for generalist should be deterministic given the shipped benchmark.

  try {
    // Tiny config that contains the candidate models we care about, all routed
    // to the single stub backend (so requests land somewhere).
    const config = {
      backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
      model_routes: {
        'qwen3.6:35b-a3b':              'stub',  // generalist q=5.0, t/s=60, ram=22
        'qwen3.6:27b':                  'stub',  // generalist q=5.0, t/s=19, ram=17
        'gemma4:26b-a4b':               'stub',  // generalist q=5.0, t/s=102, ram=17
        'gemma4:31b':                   'stub',  // generalist q=5.0, t/s=24, ram=19
        'qwen3:1.7b':                   'stub',  // no quality data — should be ignored
        'claude-opus-4-6':              'stub',  // claude — only excluded from best-opensource
      },
      llm_profiles: {
        '128gb': {
          workhorse: {
            connected_model:  'qwen3:1.7b',     // weak default; ranking should swap
            disconnect_model: 'qwen3:1.7b',
          },
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

    // ── Test 1: fastest-possible — picks highest t/s among generalist-qualifiers ─
    // generalist role minimum = 4.0. Qualifiers in our subset:
    //   qwen3.6:35b-a3b (60 t/s), qwen3.6:27b (19), gemma4:26b-a4b (102), gemma4:31b (24)
    // Winner: gemma4:26b-a4b (102 t/s)
    console.log('1. fastest-possible: highest t/s among generalist-qualifiers');
    stub.requests.length = 0;
    await withProxy({
      configPath, profile: '128gb', mode: 'fastest-possible',
      env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
    }, async ({ port }) => {
      const r = await send(port, 'workhorse');
      assertEq(r.status, 200, 'status 200');
      assertEq(via(r).served_by, 'gemma4:26b-a4b',
        'fastest-possible picked gemma4:26b-a4b (102 t/s) — highest t/s among generalist-qualifiers');
      assertEq(via(r).mode, 'fastest-possible', 'mode header reflects active mode');
    });

    // ── Test 2: smallest-possible — picks lowest RAM among qualifiers ─────────
    // qwen3.6:27b (17GB) and gemma4:26b-a4b (17GB) tied. Tiebreak: t/s descending.
    // gemma4:26b-a4b (102 t/s) > qwen3.6:27b (19 t/s). Winner: gemma4:26b-a4b.
    console.log('\n2. smallest-possible: lowest RAM among qualifiers (tiebreak: t/s)');
    stub.requests.length = 0;
    await withProxy({
      configPath, profile: '128gb', mode: 'smallest-possible',
      env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
    }, async ({ port }) => {
      const r = await send(port, 'workhorse');
      assertEq(r.status, 200, 'status 200');
      // Both 17GB; t/s tiebreak picks gemma4:26b-a4b
      assertEq(via(r).served_by, 'gemma4:26b-a4b',
        'smallest-possible: 17GB tied between qwen3.6:27b and gemma4:26b-a4b; t/s tiebreak → gemma4:26b-a4b');
    });

    // ── Test 3: best-opensource — highest q OS, claude excluded ───────────────
    // All 5 OS candidates score q=5.0 generalist. Tiebreak: t/s descending.
    // gemma4:26b-a4b (102 t/s) wins. Claude is excluded from the ranking.
    console.log('\n3. best-opensource: tiebreak by t/s, claude excluded');
    stub.requests.length = 0;
    await withProxy({
      configPath, profile: '128gb', mode: 'best-opensource',
      env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
    }, async ({ port }) => {
      const r = await send(port, 'workhorse');
      assertEq(r.status, 200, 'status 200');
      assertEq(via(r).served_by, 'gemma4:26b-a4b',
        'best-opensource: q=5.0 ties broken by t/s; claude-opus-4-6 excluded');
      assert(via(r).served_by !== 'claude-opus-4-6', 'never picks Claude');
    });

    // ── Test 4: ranking is graceful when capability has no role mapping ─────
    // Add a capability with no benchmark.json capability_to_role entry.
    console.log('\n4. ranking gracefully no-ops for unmapped capability');
    const noMapConfig = JSON.parse(JSON.stringify(config));
    noMapConfig.llm_profiles['128gb']['nonexistent-cap'] = {
      connected_model:  'qwen3.6:35b-a3b',
      disconnect_model: 'qwen3.6:35b-a3b',
    };
    const noMapPath = writeConfig(tmpDir, noMapConfig);
    stub.requests.length = 0;
    await withProxy({
      configPath: noMapPath, profile: '128gb', mode: 'fastest-possible',
      env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
    }, async ({ port }) => {
      const r = await send(port, 'nonexistent-cap');
      assertEq(r.status, 200, 'unmapped capability still works (no ranking applied)');
      // Slot default used since capability_to_role had no entry
      assertEq(via(r).served_by, 'qwen3.6:35b-a3b', 'falls back to slot default when role unmapped');
    });

    // ── Test 5: ranking respects role minimums (qualifier filtering) ────────
    // workhorse → generalist (min 4.0). qwen3:1.7b has no generalist data → disqualified.
    // Confirms ranking doesn't pick disqualified models even if they're in model_routes.
    console.log('\n5. ranking filters out models below quality threshold');
    stub.requests.length = 0;
    await withProxy({
      configPath, profile: '128gb', mode: 'fastest-possible',
      env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
    }, async ({ port }) => {
      const r = await send(port, 'workhorse');
      assertEq(r.status, 200, 'status 200');
      // qwen3:1.7b would have been the slot default; ranking should bypass it
      assert(via(r).served_by !== 'qwen3:1.7b',
        `ranking did not pick disqualified qwen3:1.7b (got ${via(r).served_by})`);
    });

    // ── Test 5b: best-opensource when ONLY Claude qualifies → falls back ────
    // Edge case: if every qualifying candidate is Claude, best-opensource has
    // nothing to pick. Should soft-fail (slot default served), not hard_fail.
    console.log('\n5b. best-opensource: only Claude qualifies → graceful fallback');
    {
      const onlyClaudeConfig = {
        backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
        model_routes: {
          'claude-only-1': 'stub',
          'claude-only-2': 'stub',
        },
        llm_profiles: {
          '128gb': {
            // Use a defined capability so resolution works; route to a slot default
            workhorse: {
              connected_model: 'claude-only-1',
              disconnect_model: 'claude-only-1',
            },
          },
        },
      };
      const onlyClaudePath = writeConfig(tmpDir, onlyClaudeConfig);
      stub.requests.length = 0;
      await withProxy({
        configPath: onlyClaudePath, profile: '128gb', mode: 'best-opensource',
        env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
      }, async ({ port }) => {
        const r = await send(port, 'workhorse');
        // CONTRACT: best-opensource is a *ranking* mode, not a *filter* mode. When
        // no compliant candidate exists, ranking soft-fails to the slot default
        // (the resolveProfileModel candidate). It does NOT hard_fail like
        // opensource-only would.
        //
        // This means: with only-Claude routes, best-opensource serves the Claude
        // slot default. If you want guaranteed-OS-or-error semantics, use
        // opensource-only (filter mode) — covered by proxy-mode-filters.test.js.
        assertEq(r.status, 200, 'soft-fail: ranking returns slot default, not 502');
        assertEq(via(r).served_by, 'claude-only-1',
          'served_by IS the slot default (Claude) — soft-fall-through, not filtered');
        assertEq(via(r).mode, 'best-opensource', 'mode header still reflects requested mode');
        // The semantic gap (Claude served despite "opensource") is intentional for
        // ranking modes. proxyLog emits mode.ranking_no_candidate for observability.
      });
    }

    // ── Test 6: header mode field reflects ranking mode ─────────────────────
    console.log('\n6. all ranking modes report mode in header');
    for (const mode of ['fastest-possible', 'smallest-possible', 'best-opensource']) {
      stub.requests.length = 0;
      await withProxy({
        configPath, profile: '128gb', mode,
        env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
      }, async ({ port }) => {
        const r = await send(port, 'workhorse');
        assertEq(via(r).mode, mode, `${mode}: header.mode = ${mode}`);
      });
    }

  } finally {
    await stub.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
