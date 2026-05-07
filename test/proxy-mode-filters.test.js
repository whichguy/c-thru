#!/usr/bin/env node
'use strict';
// Integration tests for the gov-mode Chinese-origin filter (best-cloud-gov / best-local-gov).
//
// The filter (applyModeFilter in model-map-resolve.js) blocks Chinese-origin models
// (qwen, deepseek, kimi, moonshot, glm) and walks the fallback chain to find a
// compliant alternative. If no compliant candidate exists, proxy returns 502.
//
// Each test asserts:
//   - x-c-thru-resolved-via.served_by matches the expected (post-filter) model
//   - the correct stub received the request
//   - all-blocked chain returns 502 with a clear error message
//
// Run: node test/proxy-mode-filters.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, stubBackend,
} = require('./helpers');
const { LLM_MODE_ENUM } = require('../tools/model-map-resolve.js');

console.log('proxy gov-mode filter tests (best-cloud-gov / best-local-gov)\n');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-mfilt-'));
  const allowed_stub = await stubBackend();    // simulates non-Chinese (allowed) models
  const blocked_stub = await stubBackend();    // simulates Chinese-origin (blocked) models

  try {
    const config = {
      backends: {
        allowed_be: { kind: 'anthropic', url: `http://127.0.0.1:${allowed_stub.port}` },
        blocked_be: { kind: 'anthropic', url: `http://127.0.0.1:${blocked_stub.port}` },
      },
      model_routes: {
        // Non-Chinese (allowed in gov modes)
        'claude-sonnet-test': 'allowed_be',
        'phi4-local':         'allowed_be',
        // Chinese-origin (blocked in gov modes)
        'qwen3-test':         'blocked_be',
        'deepseek-test':      'blocked_be',
      },
      llm_profiles: {
        // Capability where best-cloud-gov primary is Chinese → filter swaps to claude
        mixed_cap: {
          'best-cloud':     { '128gb': 'qwen3-test'         },
          'best-cloud-gov': { '128gb': 'qwen3-test'         },
          'best-local-oss': { '128gb': 'qwen3-test'         },
          'best-local-gov': { '128gb': 'phi4-local'         },
        },
        // Capability where primary is already non-Chinese
        safe_cap: {
          'best-cloud':     { '128gb': 'claude-sonnet-test' },
          'best-cloud-gov': { '128gb': 'claude-sonnet-test' },
          'best-local-gov': { '128gb': 'phi4-local'         },
        },
        // Capability with all-Chinese chain — gov filter must 502
        all_blocked: {
          'best-cloud':     { '128gb': 'qwen3-test'         },
          'best-cloud-gov': { '128gb': 'qwen3-test'         },
          'best-local-gov': { '128gb': 'qwen3-test'         },
        },
      },
      fallback_chains: {
        '128gb': {
          mixed_cap: [
            { model: 'qwen3-test',         quality_score: 80 },
            { model: 'claude-sonnet-test',  quality_score: 90 },  // non-Chinese fallback
          ],
          safe_cap: [
            { model: 'claude-sonnet-test',  quality_score: 95 },
          ],
          all_blocked: [
            { model: 'qwen3-test',          quality_score: 80 },
            { model: 'deepseek-test',       quality_score: 75 },  // both Chinese
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

    // ── Test 1: best-cloud-gov with Chinese primary → filter swaps to non-Chinese ─
    console.log('1. best-cloud-gov: Chinese primary blocked, claude-sonnet-test from chain');
    allowed_stub.requests.length = 0; blocked_stub.requests.length = 0;
    await withProxy({ configPath, profile: '128gb', mode: 'best-cloud-gov' }, async ({ port }) => {
      const r = await send(port, 'mixed_cap');
      assertEq(r.status, 200, 'status 200');
      assertEq(via(r).served_by, 'claude-sonnet-test',
        'gov filter blocked qwen3-test, walked to claude-sonnet-test');
      assertEq(via(r).mode, 'best-cloud-gov', 'header mode = best-cloud-gov');
      assertEq(via(r).capability, 'mixed_cap', 'capability preserved across filter swap');
      assertEq(allowed_stub.requests.length, 1, 'allowed stub got request');
      assertEq(blocked_stub.requests.length, 0, 'blocked stub NOT touched after filter');
    });

    // ── Test 2: best-cloud-gov with non-Chinese primary → passes unchanged ────
    console.log('\n2. best-cloud-gov: non-Chinese primary passes filter unchanged');
    allowed_stub.requests.length = 0; blocked_stub.requests.length = 0;
    await withProxy({ configPath, profile: '128gb', mode: 'best-cloud-gov' }, async ({ port }) => {
      const r = await send(port, 'safe_cap');
      assertEq(r.status, 200, 'status 200');
      assertEq(via(r).served_by, 'claude-sonnet-test', 'safe_cap served unchanged (claude primary)');
      assertEq(allowed_stub.requests.length, 1, 'allowed stub got request');
      assertEq(blocked_stub.requests.length, 0, 'blocked stub NOT touched');
    });

    // ── Test 3: best-cloud (non-gov) with Chinese primary → allowed (no filter) ─
    console.log('\n3. best-cloud (non-gov): Chinese primary is allowed (no filter applied)');
    allowed_stub.requests.length = 0; blocked_stub.requests.length = 0;
    await withProxy({ configPath, profile: '128gb', mode: 'best-cloud' }, async ({ port }) => {
      const r = await send(port, 'mixed_cap');
      assertEq(r.status, 200, 'status 200');
      assertEq(via(r).served_by, 'qwen3-test', 'best-cloud allows Chinese primary (no gov filter)');
      assertEq(blocked_stub.requests.length, 1, 'blocked stub got the Chinese model request');
      assertEq(allowed_stub.requests.length, 0, 'allowed stub NOT touched (qwen3 routed directly)');
    });

    // ── Tests 4+6: both gov modes with all-Chinese chain → 502 ──────────────
    const GOV_MODES = [...LLM_MODE_ENUM].filter(m => m.endsWith('-gov'));
    let testNum = 4;
    for (const govMode of GOV_MODES) {
      console.log(`\n${testNum++}. ${govMode}: all-Chinese chain → 502 error`);
      allowed_stub.requests.length = 0; blocked_stub.requests.length = 0;
      await withProxy({ configPath, profile: '128gb', mode: govMode }, async ({ port }) => {
        const r = await send(port, 'all_blocked');
        assertEq(r.status, 502, `${govMode} all-Chinese chain → 502`);
        const msg = r.json?.error?.message || '';
        assert(
          msg.toLowerCase().includes(govMode) || msg.toLowerCase().includes('filter') || msg.toLowerCase().includes('model'),
          `error message mentions filter context (got ${JSON.stringify(msg)})`
        );
        assertEq(allowed_stub.requests.length, 0, 'no upstream call (filter rejected all)');
        assertEq(blocked_stub.requests.length, 0, 'blocked stub NOT touched');
      });
    }

    // ── Test 5 (renumbered 6): best-local-gov with local allowed model → passes
    console.log(`\n${testNum++}. best-local-gov: non-Chinese local model passes filter`);
    allowed_stub.requests.length = 0; blocked_stub.requests.length = 0;
    await withProxy({ configPath, profile: '128gb', mode: 'best-local-gov' }, async ({ port }) => {
      const r = await send(port, 'mixed_cap');
      assertEq(r.status, 200, 'status 200');
      assertEq(via(r).served_by, 'phi4-local', 'best-local-gov uses phi4-local (non-Chinese)');
      assertEq(via(r).mode, 'best-local-gov', 'header mode = best-local-gov');
    });

  } finally {
    await allowed_stub.close().catch(() => {});
    await blocked_stub.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
