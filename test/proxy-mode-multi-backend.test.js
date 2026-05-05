#!/usr/bin/env node
'use strict';
// Multi-backend e2e: verifies that within a single session, capability-aware
// modes (cloud-judge-only, semi-offload) actually fire requests against
// DIFFERENT backends per capability — not just unit-tested resolution, but
// real on-the-wire HTTP traffic to two distinct stub backends.
//
// Closes the gap left by proxy-form-factor.test.js, which verifies routing
// resolution but uses a single stub for everything.
//
// Run: node test/proxy-mode-multi-backend.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');

const { assert, summary, writeConfig, withProxy, httpJson } = require('./helpers');

console.log('proxy mode multi-backend e2e tests\n');

// ── Two-backend stub: separate HTTP servers for "cloud" and "local" ────────
// Each captures its hits so we can assert which capabilities went where.

function startStubBackend(label) {
  return new Promise((resolve, reject) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        hits.push({ url: req.url, model: parsed?.model || null });
        // Minimal Anthropic Messages API response
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_' + label + '_' + hits.length,
          type: 'message',
          role: 'assistant',
          model: parsed?.model || 'unknown',
          content: [{ type: 'text', text: `${label} response` }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        label,
        port,
        url: `http://127.0.0.1:${port}`,
        hits: () => hits,
        close: () => new Promise(done => server.close(done)),
      });
    });
    server.on('error', reject);
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-mmb-'));
  const cloud = await startStubBackend('cloud');
  const local = await startStubBackend('local');

  try {
    // Config: judge → cloud in best-cloud, → local in best-local-oss; workhorse always local.
    const config = {
      backends: {
        cloud_be: { kind: 'anthropic', url: `http://127.0.0.1:${cloud.port}` },
        local_be: { kind: 'anthropic', url: `http://127.0.0.1:${local.port}` },
      },
      model_routes: {
        'cloud-judge':  'cloud_be',
        'local-judge':  'local_be',
        'local-worker': 'local_be',
      },
      llm_profiles: {
        judge: {
          'best-cloud':     { '128gb': 'cloud-judge'  },
          'best-local-oss': { '128gb': 'local-judge'  },
          'best-cloud-oss': { '128gb': 'cloud-judge'  },
        },
        workhorse: {
          'best-cloud':     { '128gb': 'local-worker' },
          'best-local-oss': { '128gb': 'local-worker' },
          'best-cloud-oss': { '128gb': 'local-worker' },
        },
      },
    };
    const configPath = writeConfig(tmpDir, config);

    const messageBody = {
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    };

    // ── Test 1: best-cloud — judge → cloud, workhorse → local ────────────────
    console.log('1. best-cloud mode: judge hits cloud, workhorse hits local');
    await withProxy(
      { configPath, profile: '128gb', mode: 'best-cloud' },
      async ({ port }) => {
        const rJudge = await httpJson(port, 'POST', '/v1/messages',
          Object.assign({ model: 'judge' }, messageBody));
        assert(rJudge.status === 200, `judge request 200 (got ${rJudge.status})`);
        const judgeVia = JSON.parse(rJudge.headers['x-c-thru-resolved-via'] || '{}');
        assert(judgeVia.served_by === 'cloud-judge',
          `judge resolved to cloud-judge in best-cloud (got ${JSON.stringify(judgeVia.served_by)})`);

        const rWork = await httpJson(port, 'POST', '/v1/messages',
          Object.assign({ model: 'workhorse' }, messageBody));
        assert(rWork.status === 200, `workhorse request 200 (got ${rWork.status})`);
        const workVia = JSON.parse(rWork.headers['x-c-thru-resolved-via'] || '{}');
        assert(workVia.served_by === 'local-worker',
          `workhorse resolved to local-worker (got ${JSON.stringify(workVia.served_by)})`);

        const cloudHits = cloud.hits();
        const localHits = local.hits();
        assert(cloudHits.some(h => h.model === 'cloud-judge'),
          `cloud backend received judge request (cloud hits: ${JSON.stringify(cloudHits.map(h => h.model))})`);
        assert(localHits.some(h => h.model === 'local-worker'),
          `local backend received workhorse request (local hits: ${JSON.stringify(localHits.map(h => h.model))})`);
      }
    );

    // Reset hits between tests
    cloud.hits().length = 0;
    local.hits().length = 0;

    // ── Test 2: best-local-oss — judge → local, cloud never touched ──────────
    console.log('\n2. best-local-oss mode: both hit local, cloud is never touched');
    await withProxy(
      { configPath, profile: '128gb', mode: 'best-local-oss' },
      async ({ port }) => {
        await httpJson(port, 'POST', '/v1/messages',
          Object.assign({ model: 'judge' }, messageBody));
        await httpJson(port, 'POST', '/v1/messages',
          Object.assign({ model: 'workhorse' }, messageBody));

        const cloudHits = cloud.hits();
        const localHits = local.hits();
        assert(cloudHits.length === 0,
          `cloud backend NOT touched in best-local-oss mode (got ${cloudHits.length} hits)`);
        assert(localHits.length === 2,
          `local backend received both requests (got ${localHits.length})`);
      }
    );

    cloud.hits().length = 0;
    local.hits().length = 0;

    // ── Test 3: best-cloud-oss — judge → cloud, workhorse → local ───────────
    console.log('\n3. best-cloud-oss mode: judge → cloud, workhorse → local');
    await withProxy(
      { configPath, profile: '128gb', mode: 'best-cloud-oss' },
      async ({ port }) => {
        await httpJson(port, 'POST', '/v1/messages',
          Object.assign({ model: 'judge' }, messageBody));
        await httpJson(port, 'POST', '/v1/messages',
          Object.assign({ model: 'workhorse' }, messageBody));

        const cloudHits = cloud.hits();
        const localHits = local.hits();
        assert(cloudHits.length === 1 && cloudHits[0].model === 'cloud-judge',
          `cloud backend got judge request in best-cloud-oss (got ${JSON.stringify(cloudHits)})`);
        assert(localHits.length === 1 && localHits[0].model === 'local-worker',
          `local backend got workhorse request in best-cloud-oss (got ${JSON.stringify(localHits)})`);
      }
    );

  } finally {
    await cloud.close().catch(() => {});
    await local.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
