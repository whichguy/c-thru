#!/usr/bin/env node
'use strict';
// Regression coverage for the OpenAI Responses forwarder's dedicated socket
// timeout. Responses must neither hang forever nor inherit Gemini's timeout.
//
// Run: node test/proxy-responses-timeout.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  assert, summary,
  startStubServer, writeConfig, withProxy, httpJson,
} = require('./helpers');

console.log('proxy Responses upstream-timeout test\n');

const completedResponse = text => ({
  id: 'resp_timeout_test',
  status: 'completed',
  output: [{
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

async function closeStub(stub) {
  if (!stub) return;
  // A deliberately silent response may retain a socket if a regression leaves
  // the request alive. Force-close it so test cleanup remains bounded.
  try { stub.server.closeAllConnections?.(); } catch {}
  await stub.close().catch(() => {});
}

async function main() {
  console.log('0. Production Responses inactivity default stays inside the one-hour ceiling');
  const proxySource = fs.readFileSync(
    path.join(__dirname, '..', 'tools', 'claude-proxy'),
    'utf8',
  );
  assert(
    /const RESPONSES_UPSTREAM_TIMEOUT_MS = numberFromEnv\(\s*'CLAUDE_PROXY_RESPONSES_TIMEOUT_MS',\s*3300000,\s*\);/.test(
      proxySource,
    ),
    'Responses defaults to 55 minutes, reserving five minutes for teardown',
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-responses-timeout-'));
  let stalled;
  let fallback;
  let delayed;

  try {
    stalled = await startStubServer({
      'POST /v1/responses': () => {
        // Accept the request but never send headers or a body.
      },
    });
    fallback = await startStubServer({
      'POST /v1/responses': completedResponse('fallback after Responses timeout'),
    });
    delayed = await startStubServer({
      'POST /v1/responses': (_req, res) => {
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(completedResponse('delayed Responses success')));
        }, 300);
      },
    });

    const configPath = writeConfig(tmpDir, {
      endpoints: {
        stalled_responses: {
          url: stalled.url,
          format: 'openai',
          auth: 'none',
          fallback_to: 'fallback-responses-model',
        },
        fallback_responses: {
          url: fallback.url,
          format: 'openai',
          auth: 'none',
        },
        delayed_responses: {
          url: delayed.url,
          format: 'openai',
          auth: 'none',
        },
      },
      model_routes: {
        'stalled-responses-model': 'stalled_responses',
        'fallback-responses-model': 'fallback_responses',
        'delayed-responses-model': 'delayed_responses',
      },
    });

    await withProxy({
      configPath,
      readyTimeoutMs: 3000,
      env: {
        CLAUDE_PROXY_RESPONSES_TIMEOUT_MS: '700',
        CLAUDE_PROXY_GEMINI_TIMEOUT_MS: '80',
      },
    }, async ({ port }) => {
      console.log('1. Responses timeout terminates a silent upstream and dispatches fallback');
      const started = Date.now();
      const timedOut = await httpJson(port, 'POST', '/v1/messages', {
        model: 'stalled-responses-model',
        stream: false,
        messages: [{ role: 'user', content: 'trigger timeout' }],
        max_tokens: 8,
      }, {}, 3000);
      const elapsed = Date.now() - started;

      assert(timedOut.status === 200 &&
        timedOut.json?.content?.[0]?.text === 'fallback after Responses timeout',
      'silent Responses upstream reaches the normal fallback path');
      assert(elapsed >= 550 && elapsed < 2500,
        `fallback occurs after the 700ms Responses timeout without hanging (${elapsed}ms)`);
      assert(stalled.requests.length === 1 && fallback.requests.length === 1,
        'both stalled primary and healthy fallback received exactly one request');

      console.log('\n2. Gemini timeout does not govern Responses requests');
      const delayedStarted = Date.now();
      const succeeded = await httpJson(port, 'POST', '/v1/messages', {
        model: 'delayed-responses-model',
        stream: false,
        messages: [{ role: 'user', content: 'wait for the delayed reply' }],
        max_tokens: 8,
      }, {}, 3000);
      const delayedElapsed = Date.now() - delayedStarted;

      assert(succeeded.status === 200 &&
        succeeded.json?.content?.[0]?.text === 'delayed Responses success',
      '300ms Responses reply survives the unrelated 80ms Gemini timeout');
      assert(delayedElapsed >= 200 && delayedElapsed < 2000,
        `delayed reply completes inside the 700ms Responses timeout (${delayedElapsed}ms)`);
      assert(delayed.requests.length === 1,
        'delayed Responses stub received exactly one request');
    });
  } finally {
    await Promise.all([closeStub(stalled), closeStub(fallback), closeStub(delayed)]);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
