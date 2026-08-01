#!/usr/bin/env node
'use strict';
// P0: x-c-thru-resolved-via + fallback-from on Gemini and OpenAI/xAI paths
// (buildCthruResponseHeaders parity with forwardAnthropic).
//
// Run: node test/proxy-routing-headers-parity.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson,
  stubBackend, startStubServer,
} = require('./helpers');

console.log('proxy routing headers parity (Gemini + OpenAI/xAI)\n');

function parseVia(headers) {
  const raw = headers && headers['x-c-thru-resolved-via'];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return { _parse_error: true, raw }; }
}

function geminiOk() {
  return {
    candidates: [{
      content: { role: 'model', parts: [{ text: 'ok-gemini' }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 },
  };
}

function responsesOk(model) {
  return {
    id: 'resp_hdr',
    status: 'completed',
    model,
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok-xai' }],
    }],
    usage: { input_tokens: 2, output_tokens: 2 },
  };
}

async function geminiStubServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(geminiOk()));
    });
  });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  return {
    port: server.address().port,
    requests,
    close: () => new Promise(r => server.close(r)),
  };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-hdr-parity-'));

  try {
    // ── 1. Gemini capability request stamps resolved-via ─────────────────
    console.log('1. Gemini capability → x-c-thru-resolved-via');
    {
      const gem = await geminiStubServer();
      try {
        const cfg = {
          endpoints: {
            gemini_ai: {
              url: `http://127.0.0.1:${gem.port}`,
              format: 'gemini',
              auth: { literal: 'fake-gemini-key' },
            },
          },
          model_routes: {
            'gemini-pro-latest': 'gemini_ai',
          },
          llm_profiles: {
            workhorse: {
              'best-cloud': { '16gb': 'gemini-pro-latest' },
              on_failure: 'cascade',
            },
          },
          llm_mode: 'best-cloud',
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy(
          { configPath, profile: '16gb', mode: 'best-cloud', env: { GOOGLE_API_KEY: 'fake' } },
          async ({ port }) => {
            const r = await httpJson(port, 'POST', '/v1/messages', {
              model: 'workhorse',
              max_tokens: 16,
              messages: [{ role: 'user', content: 'hi' }],
            });
            assertEq(r.status, 200, 'gemini capability: 200');
            assert(r.headers['x-c-thru-served-by'], 'gemini capability: served-by present');
            const via = parseVia(r.headers);
            assert(via && !via._parse_error, 'gemini capability: resolved-via present + JSON');
            assertEq(via.capability, 'workhorse', 'gemini capability: via.capability=workhorse');
            assertEq(via.served_by, 'gemini-pro-latest', 'gemini capability: via.served_by');
            assert(via.mode != null, 'gemini capability: via.mode set');
            assert(via.tier != null, 'gemini capability: via.tier set');
            assert(typeof via.local_terminal_appended === 'boolean',
              'gemini capability: via.local_terminal_appended boolean');
          },
        );
      } finally {
        await gem.close();
      }
    }

    // ── 2. OpenAI/xAI capability request stamps resolved-via ─────────────
    console.log('\n2. OpenAI/xAI capability → x-c-thru-resolved-via');
    {
      const stub = await startStubServer({
        '*': responsesOk('grok-4.5'),
      });
      try {
        const cfg = {
          endpoints: {
            xai: {
              url: stub.url,
              format: 'openai',
              auth: { header: 'Authorization', scheme: 'Bearer', env: 'XAI_API_KEY' },
            },
          },
          model_routes: {
            'grok-4.5': 'xai',
          },
          llm_profiles: {
            workhorse: {
              'best-cloud': { '16gb': 'grok-4.5' },
              on_failure: 'cascade',
            },
          },
          llm_mode: 'best-cloud',
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy(
          { configPath, profile: '16gb', mode: 'best-cloud', env: { XAI_API_KEY: 'xai-test' } },
          async ({ port }) => {
            const r = await httpJson(port, 'POST', '/v1/messages', {
              model: 'workhorse',
              max_tokens: 16,
              messages: [{ role: 'user', content: 'hi' }],
            });
            assertEq(r.status, 200, 'xai capability: 200');
            assert(r.headers['x-c-thru-served-by'], 'xai capability: served-by');
            const via = parseVia(r.headers);
            assert(via && !via._parse_error, 'xai capability: resolved-via present + JSON');
            assertEq(via.capability, 'workhorse', 'xai capability: via.capability');
            assertEq(via.served_by, 'grok-4.5', 'xai capability: via.served_by');
          },
        );
      } finally {
        await stub.close();
      }
    }

    // ── 3. Fallback-from on xAI success after Anthropic primary fail ─────
    console.log('\n3. cascade primary→xAI stamps x-c-thru-fallback-from');
    {
      const primary = await stubBackend({ failWith: 502 });
      const xaiStub = await startStubServer({
        '*': responsesOk('grok-4.5'),
      });
      try {
        const cfg = {
          endpoints: {
            primary_ep: {
              url: `http://127.0.0.1:${primary.port}`,
              format: 'anthropic',
              auth: 'none',
              fallback_to: 'grok-4.5',
            },
            xai: {
              url: xaiStub.url,
              format: 'openai',
              auth: { header: 'Authorization', scheme: 'Bearer', env: 'XAI_API_KEY' },
            },
          },
          model_routes: {
            'primary-model': 'primary_ep',
            'grok-4.5': 'xai',
          },
          llm_profiles: {
            workhorse: {
              'best-cloud': { '16gb': 'primary-model' },
              on_failure: 'cascade',
            },
          },
          llm_mode: 'best-cloud',
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy(
          { configPath, profile: '16gb', mode: 'best-cloud', env: { XAI_API_KEY: 'xai-test' } },
          async ({ port }) => {
            const r = await httpJson(port, 'POST', '/v1/messages', {
              model: 'workhorse',
              max_tokens: 16,
              messages: [{ role: 'user', content: 'hi' }],
            });
            assertEq(r.status, 200, 'cascade xai: 200');
            assertEq(r.headers['x-c-thru-served-by'], 'grok-4.5', 'cascade xai: served-by grok');
            assertEq(r.headers['x-c-thru-fallback-from'], 'primary_ep',
              'cascade xai: fallback-from primary_ep');
            assertEq(r.headers['x-claude-proxy-fallback-from'], 'primary_ep',
              'cascade xai: legacy fallback-from alias');
            const via = parseVia(r.headers);
            assert(via && via.capability === 'workhorse',
              'cascade xai: resolved-via still present on fallback success');
          },
        );
      } finally {
        await primary.close();
        await xaiStub.close();
      }
    }

    // ── 4. Fallback-from when secondary is Gemini ────────────────────────
    console.log('\n4. cascade primary→Gemini stamps x-c-thru-fallback-from');
    {
      const primary = await stubBackend({ failWith: 502 });
      const gem = await geminiStubServer();
      try {
        const cfg = {
          endpoints: {
            primary_ep: {
              url: `http://127.0.0.1:${primary.port}`,
              format: 'anthropic',
              auth: 'none',
              fallback_to: 'gemini-pro-latest',
            },
            gemini_ai: {
              url: `http://127.0.0.1:${gem.port}`,
              format: 'gemini',
              auth: { literal: 'fake-gemini-key' },
            },
          },
          model_routes: {
            'primary-model': 'primary_ep',
            'gemini-pro-latest': 'gemini_ai',
          },
          llm_profiles: {
            workhorse: {
              'best-cloud': { '16gb': 'primary-model' },
              on_failure: 'cascade',
            },
          },
          llm_mode: 'best-cloud',
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy(
          { configPath, profile: '16gb', mode: 'best-cloud', env: { GOOGLE_API_KEY: 'fake' } },
          async ({ port }) => {
            const r = await httpJson(port, 'POST', '/v1/messages', {
              model: 'workhorse',
              max_tokens: 16,
              messages: [{ role: 'user', content: 'hi' }],
            });
            assertEq(r.status, 200, 'cascade gemini: 200');
            assertEq(r.headers['x-c-thru-served-by'], 'gemini-pro-latest',
              'cascade gemini: served-by gemini');
            assertEq(r.headers['x-c-thru-fallback-from'], 'primary_ep',
              'cascade gemini: fallback-from primary_ep');
            const via = parseVia(r.headers);
            assert(via && via.capability === 'workhorse',
              'cascade gemini: resolved-via still present');
          },
        );
      } finally {
        await primary.close();
        await gem.close();
      }
    }

    // ── 5. Direct Gemini model (no capability) → no resolved-via ─────────
    console.log('\n5. direct Gemini model → resolved-via absent');
    {
      const gem = await geminiStubServer();
      try {
        const cfg = {
          endpoints: {
            gemini_ai: {
              url: `http://127.0.0.1:${gem.port}`,
              format: 'gemini',
              auth: { literal: 'fake-gemini-key' },
            },
          },
          model_routes: {
            'gemini-pro-latest': 'gemini_ai',
          },
          llm_mode: 'best-cloud',
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy(
          { configPath, profile: '16gb', mode: 'best-cloud', env: { GOOGLE_API_KEY: 'fake' } },
          async ({ port }) => {
            const r = await httpJson(port, 'POST', '/v1/messages', {
              model: 'gemini-pro-latest',
              max_tokens: 16,
              messages: [{ role: 'user', content: 'hi' }],
            });
            assertEq(r.status, 200, 'direct gemini: 200');
            assert(r.headers['x-c-thru-served-by'], 'direct gemini: served-by present');
            assert(r.headers['x-c-thru-resolved-via'] == null,
              'direct gemini: resolved-via absent (no capability)');
          },
        );
      } finally {
        await gem.close();
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  process.exit(summary() ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
