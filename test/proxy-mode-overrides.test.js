#!/usr/bin/env node
'use strict';
// Consolidated tests for the 3 new Phase-1 modes:
//   local-only      — alias for offline; same resolution but distinct mode label in headers
//   cloud-thinking  — only modes['cloud-thinking']-tagged caps go cloud; others local
//   local-review    — only modes['local-review']-tagged caps go local; others cloud
//
// All assertions verify x-c-thru-resolved-via.served_by matches the expected concrete model
// (canonical validation that the proxy chose the right model for the mode).
//
// Run: node test/proxy-mode-overrides.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, stubBackend,
} = require('./helpers');

const CTHRU = path.join(__dirname, '..', 'tools', 'c-thru');

console.log('proxy mode overrides tests (local-only, cloud-thinking, local-review)\n');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-mode-ovr-'));
  const cloud = await stubBackend();
  const local = await stubBackend();

  try {
    // Fixture: 4 capabilities split between cloud-thinking and local-review classes.
    // judge:       cloud-thinking override → cloud
    // reviewer:    local-review override   → local
    // workhorse:   no overrides            → falls through
    // coder:       no overrides            → falls through
    const config = {
      backends: {
        cloud_be: { kind: 'anthropic', url: cloud.url || `http://127.0.0.1:${cloud.port}` },
        local_be: { kind: 'anthropic', url: local.url || `http://127.0.0.1:${local.port}` },
      },
      model_routes: {
        'cloud-judge':  'cloud_be',
        'local-judge':  'local_be',
        'cloud-rev':    'cloud_be',
        'local-rev':    'local_be',
        'cloud-coder':  'cloud_be',
        'local-coder':  'local_be',
        'cloud-wh':     'cloud_be',
        'local-wh':     'local_be',
      },
      llm_profiles: {
        '128gb': {
          judge: {
            connected_model:  'cloud-judge',
            disconnect_model: 'local-judge',
            modes: {
              'cloud-thinking': 'cloud-judge',  // judge goes cloud in cloud-thinking
              // no local-review override → falls through to connected_model (cloud)
            },
          },
          reviewer: {
            connected_model:  'cloud-rev',
            disconnect_model: 'local-rev',
            modes: {
              'local-review': 'local-rev',  // reviewer goes local in local-review
              // no cloud-thinking override → falls through to disconnect_model (local)
            },
          },
          workhorse: {
            connected_model:  'cloud-wh',
            disconnect_model: 'local-wh',
            // no overrides at all
          },
          coder: {
            connected_model:  'cloud-coder',
            disconnect_model: 'local-coder',
            // no overrides at all
          },
        },
      },
    };
    const configPath = writeConfig(tmpDir, config);

    const send = async (port, model) => httpJson(port, 'POST', '/v1/messages', {
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    }, {}, 5000);

    const via = r => JSON.parse(r.headers['x-c-thru-resolved-via'] || '{}');

    // ───────────────────────── local-only section ─────────────────────────
    console.log('── local-only (alias for offline) ──');
    cloud.requests.length = 0; local.requests.length = 0;
    await withProxy({ configPath, profile: '128gb', mode: 'local-only' }, async ({ port }) => {
      const r1 = await send(port, 'judge');
      assertEq(via(r1).served_by, 'local-judge', 'judge in local-only → local model');
      const r2 = await send(port, 'coder');
      assertEq(via(r2).served_by, 'local-coder', 'coder in local-only → local model');
      assertEq(via(r1).mode, 'local-only', 'header mode = local-only');
      assertEq(cloud.requests.length, 0, 'cloud backend NOT touched in local-only');
      assert(local.requests.length === 2, `local backend got both requests (got ${local.requests.length})`);
    });

    // Same fixture in offline → identical concrete models, distinct mode label
    cloud.requests.length = 0; local.requests.length = 0;
    await withProxy({ configPath, profile: '128gb', mode: 'offline' }, async ({ port }) => {
      const r = await send(port, 'judge');
      assertEq(via(r).served_by, 'local-judge', 'offline resolves to same model as local-only');
      assertEq(via(r).mode, 'offline', 'header mode = offline (not local-only)');
    });

    // ───────────────────────── cloud-thinking section ─────────────────────
    console.log('\n── cloud-thinking ──');
    cloud.requests.length = 0; local.requests.length = 0;
    await withProxy({ configPath, profile: '128gb', mode: 'cloud-thinking' }, async ({ port }) => {
      const rJudge = await send(port, 'judge');
      assertEq(via(rJudge).served_by, 'cloud-judge',
        'judge in cloud-thinking → cloud model via modes[cloud-thinking]');
      const rCoder = await send(port, 'coder');
      assertEq(via(rCoder).served_by, 'local-coder',
        'coder in cloud-thinking (no override) → falls through to disconnect_model');
      const rWh = await send(port, 'workhorse');
      assertEq(via(rWh).served_by, 'local-wh',
        'workhorse in cloud-thinking (no override) → falls through to disconnect_model');
      assertEq(via(rJudge).mode, 'cloud-thinking', 'header mode = cloud-thinking');
      assertEq(cloud.requests.length, 1, 'cloud backend got exactly 1 request (judge)');
      assertEq(local.requests.length, 2, 'local backend got 2 requests (coder + workhorse)');
    });

    // ───────────────────────── local-review section ───────────────────────
    console.log('\n── local-review ──');
    cloud.requests.length = 0; local.requests.length = 0;
    await withProxy({ configPath, profile: '128gb', mode: 'local-review' }, async ({ port }) => {
      const rRev = await send(port, 'reviewer');
      assertEq(via(rRev).served_by, 'local-rev',
        'reviewer in local-review → local model via modes[local-review]');
      const rJudge = await send(port, 'judge');
      assertEq(via(rJudge).served_by, 'cloud-judge',
        'judge in local-review (no override) → falls through to connected_model (cloud)');
      const rCoder = await send(port, 'coder');
      assertEq(via(rCoder).served_by, 'cloud-coder',
        'coder in local-review (no override) → falls through to connected_model (cloud)');
      assertEq(via(rRev).mode, 'local-review', 'header mode = local-review');
      assertEq(cloud.requests.length, 2, 'cloud backend got 2 requests (judge + coder)');
      assertEq(local.requests.length, 1, 'local backend got 1 request (reviewer)');
    });

    // Note: ENUM validity is enforced by:
    //   1. resolveLlmMode() in model-map-resolve.js — invalid env var → stderr warning + fallback to connected
    //   2. c-thru-contract-check.sh Check 11 — keeps LLM_MODE_ENUM and LLM_MODES in sync
    // Both are covered by other tests; no negative test needed here.

  } finally {
    await cloud.close().catch(() => {});
    await local.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
