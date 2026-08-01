#!/usr/bin/env node
'use strict';
// Integration tests for custom_modes POSITIVE routing end-to-end.
//
// custom_modes is a shipped feature (config/model-map.json ships
// custom_modes.deepseek-hybrid{base:best-cloud-oss}). At request time the proxy
// resolves a custom mode via baseModeFor()/resolveProfileModel's baseMode arg:
//   - a capability the custom mode OVERRIDES (llm_profiles[cap][<customMode>])
//     resolves to the override model;
//   - a capability the custom mode does NOT override resolves under the mode's
//     `base` built-in (resolveProfileModel's baseMode fallback).
// The ONLY current spawned custom_modes test (proxy-config-reload C48) checks
// orphan-degrade on reload, NOT active routing — so positive routing and the
// gov-BASED custom-mode runtime filter have no spawned-proxy coverage today.
//
// Each test asserts x-c-thru-resolved-via.served_by is the expected concrete
// model and that the request hit the expected stub backend.
//
// Run: node test/proxy-custom-mode-routing.test.js
//      (proxy-spawn suites flake under full-run load — standalone is the bar.)

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, stubBackend,
} = require('./helpers');

console.log('proxy custom_modes routing tests (positive end-to-end + gov-based filter)\n');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-custom-mode-'));

  const send = (port, model) => httpJson(port, 'POST', '/v1/messages', {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 5,
  }, {});
  const via = r => JSON.parse(r.headers['x-c-thru-resolved-via'] || '{}');

  // ── Part A: non-gov custom mode — override vs. base-mode routing ───────────
  // custom_modes.mymode{base:best-cloud-oss}. `coder` is OVERRIDDEN under mymode
  // (→ override backend); `judge` is NOT overridden (→ resolves under base
  // best-cloud-oss → base backend). Distinct stub backends prove the split.
  {
    const base = await stubBackend();  // best-cloud-oss base models
    const ovr  = await stubBackend();  // custom-mode override model
    try {
      const config = {
        backends: {
          base_be: { kind: 'anthropic', url: `http://127.0.0.1:${base.port}` },
          ovr_be:  { kind: 'anthropic', url: `http://127.0.0.1:${ovr.port}` },
        },
        model_routes: {
          'base-oss-coder': 'base_be',
          'base-oss-judge': 'base_be',
          'mymode-coder':   'ovr_be',
        },
        custom_modes: {
          mymode: { base: 'best-cloud-oss', description: 'test custom mode' },
        },
        llm_profiles: {
          // coder: explicit per-mode override under the custom mode "mymode".
          coder: {
            'best-cloud-oss': { '128gb': 'base-oss-coder' },
            'mymode':         { '128gb': 'mymode-coder'   },
          },
          // judge: NO custom-mode override → must resolve under base best-cloud-oss.
          judge: {
            'best-cloud-oss': { '128gb': 'base-oss-judge' },
          },
        },
      };
      const configPath = writeConfig(tmpDir, config);

      console.log('1. custom mode "mymode" (base best-cloud-oss): override vs. base routing');
      base.requests.length = 0; ovr.requests.length = 0;
      await withProxy({ configPath, profile: '128gb', env: { CLAUDE_LLM_MODE: 'mymode' } }, async ({ port }) => {
        // Overridden capability → custom-mode override model + override backend.
        const r1 = await send(port, 'coder');
        assertEq(r1.status, 200, 'coder status 200');
        assertEq(via(r1).served_by, 'mymode-coder', 'overridden coder → custom-mode model mymode-coder');
        assertEq(via(r1).mode, 'mymode', 'header mode = custom mode name "mymode"');

        // Non-overridden capability → resolves under base best-cloud-oss.
        const r2 = await send(port, 'judge');
        assertEq(r2.status, 200, 'judge status 200');
        assertEq(via(r2).served_by, 'base-oss-judge', 'non-overridden judge → base-mode model base-oss-judge');
        assertEq(via(r2).mode, 'mymode', 'header mode still = "mymode" for base-resolved cap');

        // Backends hit exactly as expected.
        assertEq(ovr.requests.length, 1, 'override backend got exactly the overridden cap');
        assertEq(base.requests.length, 1, 'base backend got exactly the non-overridden cap');
      });
    } finally {
      await base.close().catch(() => {});
      await ovr.close().catch(() => {});
    }
  }

  // ── Part B: gov-BASED custom mode — runtime Chinese-origin filter ──────────
  // custom_modes.secure{base:best-cloud-gov}. isGovMode('secure', config) must
  // engage the gov filter at REQUEST time (the reason isGovMode takes config) —
  // even though the mode is not literally named best-*-gov.
  //   - mixed_cap: secure-resolved (via base) primary is Chinese (qwen3) with a
  //     non-Chinese fallback_chains alternative → filter swaps to the non-Chinese
  //     model; the Chinese stub is never touched.
  //   - all_cn_cap: all-Chinese chain → 502, no backend touched.
  {
    const allowed = await stubBackend();  // non-Chinese (allowed) models
    const blocked = await stubBackend();  // Chinese-origin (blocked) models
    try {
      const config = {
        backends: {
          allowed_be: { kind: 'anthropic', url: `http://127.0.0.1:${allowed.port}` },
          blocked_be: { kind: 'anthropic', url: `http://127.0.0.1:${blocked.port}` },
        },
        model_routes: {
          'claude-secure':   'allowed_be',
          'qwen3-secure':    'blocked_be',
          'deepseek-secure': 'blocked_be',
        },
        custom_modes: {
          secure: { base: 'best-cloud-gov', description: 'gov-based custom mode' },
        },
        llm_profiles: {
          // Primary resolves (via base best-cloud-gov) to a Chinese model; the
          // chain offers a non-Chinese alternative the gov filter walks to.
          mixed_cap:  { 'best-cloud-gov': { '128gb': 'qwen3-secure' } },
          // All-Chinese chain — the gov filter must reject every candidate → 502.
          all_cn_cap: { 'best-cloud-gov': { '128gb': 'qwen3-secure' } },
        },
        fallback_chains: {
          '128gb': {
            mixed_cap: [
              { model: 'qwen3-secure',  quality_score: 80 },
              { model: 'claude-secure', quality_score: 90 },  // non-Chinese alt
            ],
            all_cn_cap: [
              { model: 'qwen3-secure',    quality_score: 80 },
              { model: 'deepseek-secure', quality_score: 75 },  // both Chinese
            ],
          },
        },
      };
      const configPath = writeConfig(tmpDir, config);

      console.log('\n2. gov-based custom mode "secure" (base best-cloud-gov): Chinese primary filtered to non-Chinese fallback');
      allowed.requests.length = 0; blocked.requests.length = 0;
      await withProxy({ configPath, profile: '128gb', env: { CLAUDE_LLM_MODE: 'secure' } }, async ({ port }) => {
        const r = await send(port, 'mixed_cap');
        assertEq(r.status, 200, 'mixed_cap status 200');
        assertEq(via(r).served_by, 'claude-secure',
          'gov filter (isGovMode custom mode) blocked qwen3-secure, walked to claude-secure');
        assertEq(via(r).mode, 'secure', 'header mode = custom mode name "secure"');
        assertEq(allowed.requests.length, 1, 'allowed (non-Chinese) stub got the request');
        assertEq(blocked.requests.length, 0, 'Chinese stub NEVER touched (filter engaged at request time)');
      });

      console.log('\n3. gov-based custom mode "secure": all-Chinese chain → 502 (filter rejects all)');
      allowed.requests.length = 0; blocked.requests.length = 0;
      await withProxy({ configPath, profile: '128gb', env: { CLAUDE_LLM_MODE: 'secure' } }, async ({ port }) => {
        const r = await send(port, 'all_cn_cap');
        assertEq(r.status, 502, 'all-Chinese chain under gov-based custom mode → 502');
        const msg = (r.json && r.json.error && r.json.error.message) || '';
        assert(
          msg.toLowerCase().includes('secure') || msg.toLowerCase().includes('filter') || msg.toLowerCase().includes('model'),
          `error message mentions filter context (got ${JSON.stringify(msg)})`
        );
        assertEq(allowed.requests.length, 0, 'no upstream call (filter rejected all candidates)');
        assertEq(blocked.requests.length, 0, 'Chinese stub NOT touched');
      });
    } finally {
      await allowed.close().catch(() => {});
      await blocked.close().catch(() => {});
    }
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
