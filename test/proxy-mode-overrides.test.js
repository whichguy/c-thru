#!/usr/bin/env node
'use strict';
// Per-mode model selection: verifies that within a single proxy session,
// different modes route the same capability to different concrete models.
// Tests the 5 current canonical modes using the [cap][mode][tier] schema.
//
// All assertions verify x-c-thru-resolved-via.served_by matches the expected
// concrete model (canonical validation that the proxy chose the right model).
//
// Run: node test/proxy-mode-overrides.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, stubBackend,
} = require('./helpers');

console.log('proxy mode overrides tests (per-mode model selection)\n');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-mode-ovr-'));
  const cloud = await stubBackend();
  const local = await stubBackend();

  try {
    // Fixture: 2 capabilities (judge, coder), each with distinct models per mode.
    // cloud_be serves cloud models; local_be serves local models.
    const config = {
      backends: {
        cloud_be: { kind: 'anthropic', url: `http://127.0.0.1:${cloud.port}` },
        local_be: { kind: 'anthropic', url: `http://127.0.0.1:${local.port}` },
      },
      model_routes: {
        'cloud-judge':     'cloud_be',
        'local-judge':     'local_be',
        'oss-judge':       'cloud_be',
        'gov-judge':       'cloud_be',
        'lgov-judge':      'local_be',
        'cloud-coder':     'cloud_be',
        'local-coder':     'local_be',
        'oss-coder':       'cloud_be',
        'gov-coder':       'cloud_be',
        'lgov-coder':      'local_be',
      },
      llm_profiles: {
        judge: {
          'best-cloud':     { '128gb': 'cloud-judge'  },
          'best-local-oss': { '128gb': 'local-judge'  },
          'best-cloud-oss': { '128gb': 'oss-judge'    },
          'best-cloud-gov': { '128gb': 'gov-judge'    },
          'best-local-gov': { '128gb': 'lgov-judge'   },
        },
        coder: {
          'best-cloud':     { '128gb': 'cloud-coder'  },
          'best-local-oss': { '128gb': 'local-coder'  },
          'best-cloud-oss': { '128gb': 'oss-coder'    },
          'best-cloud-gov': { '128gb': 'gov-coder'    },
          'best-local-gov': { '128gb': 'lgov-coder'   },
        },
      },
    };
    const configPath = writeConfig(tmpDir, config);

    const send = async (port, model) => httpJson(port, 'POST', '/v1/messages', {
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    }, {});

    const via = r => JSON.parse(r.headers['x-c-thru-resolved-via'] || '{}');

    // ── best-cloud section ────────────────────────────────────────────────────
    console.log('── best-cloud ──');
    cloud.requests.length = 0; local.requests.length = 0;
    await withProxy({ configPath, profile: '128gb', mode: 'best-cloud' }, async ({ port }) => {
      const r1 = await send(port, 'judge');
      assertEq(via(r1).served_by, 'cloud-judge', 'judge in best-cloud → cloud-judge');
      const r2 = await send(port, 'coder');
      assertEq(via(r2).served_by, 'cloud-coder', 'coder in best-cloud → cloud-coder');
      assertEq(via(r1).mode, 'best-cloud', 'header mode = best-cloud');
      assertEq(cloud.requests.length, 2, 'cloud backend got both requests');
      assertEq(local.requests.length, 0, 'local backend NOT touched in best-cloud');
    });

    // ── best-local-oss section ────────────────────────────────────────────────
    console.log('\n── best-local-oss ──');
    cloud.requests.length = 0; local.requests.length = 0;
    await withProxy({ configPath, profile: '128gb', mode: 'best-local-oss' }, async ({ port }) => {
      const r1 = await send(port, 'judge');
      assertEq(via(r1).served_by, 'local-judge', 'judge in best-local-oss → local-judge');
      const r2 = await send(port, 'coder');
      assertEq(via(r2).served_by, 'local-coder', 'coder in best-local-oss → local-coder');
      assertEq(via(r1).mode, 'best-local-oss', 'header mode = best-local-oss');
      assertEq(cloud.requests.length, 0, 'cloud backend NOT touched in best-local-oss');
      assertEq(local.requests.length, 2, 'local backend got both requests');
    });

    // ── best-cloud-oss section ────────────────────────────────────────────────
    console.log('\n── best-cloud-oss ──');
    cloud.requests.length = 0; local.requests.length = 0;
    await withProxy({ configPath, profile: '128gb', mode: 'best-cloud-oss' }, async ({ port }) => {
      const r1 = await send(port, 'judge');
      assertEq(via(r1).served_by, 'oss-judge', 'judge in best-cloud-oss → oss-judge');
      const r2 = await send(port, 'coder');
      assertEq(via(r2).served_by, 'oss-coder', 'coder in best-cloud-oss → oss-coder');
      assertEq(via(r1).mode, 'best-cloud-oss', 'header mode = best-cloud-oss');
    });

    // ── best-cloud-gov section ────────────────────────────────────────────────
    console.log('\n── best-cloud-gov ──');
    cloud.requests.length = 0; local.requests.length = 0;
    await withProxy({ configPath, profile: '128gb', mode: 'best-cloud-gov' }, async ({ port }) => {
      const r1 = await send(port, 'judge');
      assertEq(via(r1).served_by, 'gov-judge', 'judge in best-cloud-gov → gov-judge');
      const r2 = await send(port, 'coder');
      assertEq(via(r2).served_by, 'gov-coder', 'coder in best-cloud-gov → gov-coder');
      assertEq(via(r1).mode, 'best-cloud-gov', 'header mode = best-cloud-gov');
    });

    // ── best-local-gov section ────────────────────────────────────────────────
    console.log('\n── best-local-gov ──');
    cloud.requests.length = 0; local.requests.length = 0;
    await withProxy({ configPath, profile: '128gb', mode: 'best-local-gov' }, async ({ port }) => {
      const r1 = await send(port, 'judge');
      assertEq(via(r1).served_by, 'lgov-judge', 'judge in best-local-gov → lgov-judge');
      const r2 = await send(port, 'coder');
      assertEq(via(r2).served_by, 'lgov-coder', 'coder in best-local-gov → lgov-coder');
      assertEq(via(r1).mode, 'best-local-gov', 'header mode = best-local-gov');
      assertEq(local.requests.length, 2, 'local backend got both requests in best-local-gov');
    });

  } finally {
    await cloud.close().catch(() => {});
    await local.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
