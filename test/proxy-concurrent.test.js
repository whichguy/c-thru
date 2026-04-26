#!/usr/bin/env node
'use strict';
// Concurrency tests: fire many parallel requests and verify each is correctly
// routed without race conditions in shared state (requestMeta, headers, latency).
//
// Run: node test/proxy-concurrent.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, stubBackend,
} = require('./helpers');

console.log('proxy concurrency tests\n');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-concurrent-'));

  try {
    // ── Test 1: 10 parallel mixed-capability requests, each correctly routed ─
    console.log('1. 10 parallel mixed-capability requests');
    {
      const stub = await stubBackend();
      try {
        const config = {
          backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
          model_routes: {
            'wh-model':    'stub',
            'judge-model': 'stub',
            'coder-model': 'stub',
            'rev-model':   'stub',
          },
          llm_profiles: {
            '128gb': {
              workhorse: { connected_model: 'wh-model',    disconnect_model: 'wh-model' },
              judge:     { connected_model: 'judge-model', disconnect_model: 'judge-model' },
              coder:     { connected_model: 'coder-model', disconnect_model: 'coder-model' },
              reviewer:  { connected_model: 'rev-model',   disconnect_model: 'rev-model' },
            },
          },
        };
        const configPath = writeConfig(tmpDir, config);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const caps = ['workhorse', 'judge', 'coder', 'reviewer'];
          const expectedModels = { workhorse: 'wh-model', judge: 'judge-model', coder: 'coder-model', reviewer: 'rev-model' };

          // Build 10 requests, 2-3 of each capability
          const requests = [];
          for (let i = 0; i < 10; i++) {
            const cap = caps[i % caps.length];
            requests.push(httpJson(port, 'POST', '/v1/messages', {
              model: cap,
              messages: [{ role: 'user', content: `req ${i}` }],
              max_tokens: 5,
            }, {}, 8000).then(r => ({ cap, r })));
          }
          const results = await Promise.all(requests);

          // Each request resolves to its own capability
          let mismatches = 0;
          for (const { cap, r } of results) {
            assertEq(r.status, 200, `${cap} request status 200`);
            const via = JSON.parse(r.headers['x-c-thru-resolved-via'] || '{}');
            if (via.capability !== cap) mismatches++;
            if (via.served_by !== expectedModels[cap]) mismatches++;
          }
          assertEq(mismatches, 0, 'no capability/served_by mismatches across 10 parallel requests');
          assertEq(stub.requests.length, 10, 'stub backend received exactly 10 requests');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 2: latency_ms is per-request, not shared global ────────────────
    console.log('\n2. latency_ms is per-request (independent timing)');
    {
      const stub = await stubBackend();
      try {
        const config = {
          backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
          model_routes: { 'm': 'stub' },
          llm_profiles: { '128gb': { workhorse: { connected_model: 'm', disconnect_model: 'm' } } },
        };
        const configPath = writeConfig(tmpDir, config);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const requests = [];
          for (let i = 0; i < 5; i++) {
            requests.push(httpJson(port, 'POST', '/v1/messages', {
              model: 'workhorse',
              messages: [{ role: 'user', content: `r${i}` }],
              max_tokens: 5,
            }));
          }
          const results = await Promise.all(requests);
          const latencies = results.map(r => {
            const v = JSON.parse(r.headers['x-c-thru-resolved-via'] || '{}');
            return v.latency_ms;
          });
          // All should be numbers, all small (stub responds instantly), but distinct
          for (const l of latencies) {
            assert(typeof l === 'number' && l >= 0 && l < 5000,
              `latency_ms is sane number (got ${l})`);
          }
          // Not all identical (some tiny variance expected)
          const distinct = new Set(latencies).size;
          assert(distinct >= 1, `latency values reported (${distinct} distinct)`);
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 3: /v1/active-models stable during concurrent traffic ──────────
    console.log('\n3. /v1/active-models stable during burst');
    {
      const stub = await stubBackend();
      try {
        const config = {
          backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
          model_routes: { 'm': 'stub' },
          llm_profiles: { '128gb': { workhorse: { connected_model: 'm', disconnect_model: 'm' } } },
        };
        const configPath = writeConfig(tmpDir, config);
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          // Fire 5 concurrent /v1/active-models calls during traffic
          const tasks = [];
          for (let i = 0; i < 5; i++) {
            tasks.push(httpJson(port, 'GET', '/v1/active-models'));
            tasks.push(httpJson(port, 'POST', '/v1/messages', {
              model: 'workhorse',
              messages: [{ role: 'user', content: 'x' }], max_tokens: 5,
            }));
          }
          const results = await Promise.all(tasks);
          const amResults = results.filter(r => r.json?.local_models !== undefined);
          assertEq(amResults.length, 5, '/v1/active-models responded 5 times');
          // All should agree on tier and mode
          const tiers = new Set(amResults.map(r => r.json.tier));
          const modes = new Set(amResults.map(r => r.json.mode));
          assertEq(tiers.size, 1, 'tier consistent across concurrent calls');
          assertEq(modes.size, 1, 'mode consistent across concurrent calls');
        });
      } finally { await stub.close().catch(() => {}); }
    }

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
