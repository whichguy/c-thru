#!/usr/bin/env node
'use strict';
// Regression test for the Ollama → /v1/messages pass-through path.
//
// Background: commits 261f28c + 348fec5 (Apr 2026) introduced
// flattenMessagesForOllama() in the proxy's forwardOllama path, which stripped
// every content block whose type !== 'text' when translating Anthropic format
// to Ollama's native /api/chat shape. Multi-turn tool conversations through
// the proxy returned empty assistant responses because tool_result blocks
// became empty user messages.
//
// The fix routes kind:"ollama" backends through forwardAnthropic by default
// (Ollama 0.4+ serves /v1/messages natively), preserving tool_use and
// tool_result blocks verbatim. Backends that opt into the legacy path with
// `legacy_ollama_chat: true` continue using the translation layer.
//
// This test would have caught the original regression: it stubs an Ollama-kind
// backend on /v1/messages and asserts the request body reaches the upstream
// with tool_use and tool_result blocks intact.
//
// Run: node test/proxy-ollama-passthrough.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');

const { assert, assertEq, summary, writeConfig, withProxy, httpJson } = require('./helpers');

console.log('proxy ollama-passthrough tests\n');

// Stub backend that records every request and returns a canned Anthropic
// response. Mimics what Ollama's /v1/messages adapter emits.
function ollamaStubBackend() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({
        method: req.method,
        path: req.url,
        authorization: req.headers['authorization'] || null,
        xApiKey: req.headers['x-api-key'] || null,
        body,
      });
      const lastMsg = body?.messages?.[body.messages.length - 1];
      const hasToolResult = Array.isArray(lastMsg?.content) &&
        lastMsg.content.some(b => b?.type === 'tool_result');
      const response = hasToolResult ? {
        id: 'msg_final', type: 'message', role: 'assistant',
        model: body?.model || 'stub', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: 'The directory has 3 files.' }],
        usage: { input_tokens: 20, output_tokens: 7 },
      } : {
        id: 'msg_tool', type: 'message', role: 'assistant',
        model: body?.model || 'stub', stop_reason: 'tool_use', stop_sequence: null,
        content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, requests, close: () => new Promise(r => server.close(r)) });
    });
  });
}

function buildOllamaConfig(stubPort, opts = {}) {
  const stub = { kind: 'ollama', url: `http://127.0.0.1:${stubPort}` };
  if (opts.legacy) stub.legacy_ollama_chat = true;
  return {
    backends: { stub },
    model_routes: { 'tool-model': 'stub' },
    llm_profiles: {
      '128gb': { workhorse: { connected_model: 'tool-model', disconnect_model: 'tool-model' } },
    },
  };
}

const TOOLS_DECL = [{
  name: 'bash',
  description: 'Run a bash command',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
}];

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-ollama-pass-'));

  try {
    // ── Test 1: tool_result block survives to Ollama backend (the bug repro) ──
    // This is the test that would have caught 261f28c. With kind: "ollama" and
    // no legacy flag, the request must hit the stub with all 3 messages and
    // the tool_result block intact — no flattening to empty content.
    console.log('1. tool_result blocks reach Ollama backend intact (no flattening)');
    {
      const stub = await ollamaStubBackend();
      try {
        const configPath = writeConfig(tmpDir, buildOllamaConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse',
            tools: TOOLS_DECL,
            messages: [
              { role: 'user', content: 'Run ls' },
              { role: 'assistant', content: [
                { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
              ]},
              { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'tu_1', content: 'a.txt\nb.txt\nc.txt' },
              ]},
            ],
            max_tokens: 100,
          });
          assertEq(r.status, 200, 'status 200');
          const lastReq = stub.requests[stub.requests.length - 1];
          const fwdMessages = lastReq?.body?.messages || [];
          assertEq(fwdMessages.length, 3, '3 messages forwarded (no flattening)');
          const lastFwd = fwdMessages[fwdMessages.length - 1];
          const tr = (lastFwd?.content || []).find(b => b.type === 'tool_result');
          assert(tr, `tool_result block preserved on Ollama backend (got: ${JSON.stringify(lastFwd?.content)})`);
          assertEq(tr?.tool_use_id, 'tu_1', 'tool_result.tool_use_id preserved');
          assertEq(tr?.content, 'a.txt\nb.txt\nc.txt', 'tool_result.content preserved verbatim');
          // tool_use block in turn 2 also survives
          const turn2 = fwdMessages[1];
          const tu = (turn2?.content || []).find(b => b.type === 'tool_use');
          assert(tu, 'tool_use block in turn 2 preserved');
          assertEq(tu?.id, 'tu_1', 'tool_use.id preserved');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 2: Authorization is hardcoded to Bearer ollama, x-api-key absent ─
    console.log('\n2. Ollama backend receives Authorization: Bearer ollama, no x-api-key');
    {
      const stub = await ollamaStubBackend();
      try {
        const configPath = writeConfig(tmpDir, buildOllamaConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,
          });
          const lastReq = stub.requests[stub.requests.length - 1];
          assertEq(lastReq?.authorization, 'Bearer ollama', 'Authorization hardcoded to Bearer ollama');
          assertEq(lastReq?.xApiKey, null, 'x-api-key NOT set on Ollama backend');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 3: target path is /v1/messages (Anthropic), not /api/chat ───────
    console.log('\n3. proxy POSTs to /v1/messages on Ollama backend (not /api/chat)');
    {
      const stub = await ollamaStubBackend();
      try {
        const configPath = writeConfig(tmpDir, buildOllamaConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,
          });
          const lastReq = stub.requests[stub.requests.length - 1];
          assert(lastReq?.path?.startsWith('/v1/messages'),
            `target path is /v1/messages (got: ${lastReq?.path})`);
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 4: legacy_ollama_chat: true routes to /api/chat ─────────────────
    // Backends with legacy_ollama_chat must continue using the old translation
    // path. We don't assert tool block preservation here — the legacy path is
    // documented as lossy for tool conversations.
    console.log('\n4. legacy_ollama_chat: true routes to /api/chat (translation path)');
    {
      const stub = await ollamaStubBackend();
      try {
        const configPath = writeConfig(tmpDir, buildOllamaConfig(stub.port, { legacy: true }));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          // /api/chat returns NDJSON not Anthropic JSON; the legacy path expects
          // a 200 with NDJSON content. Our stub returns Anthropic JSON which the
          // legacy path will fail to parse — but the request will still reach
          // the stub with /api/chat in the path before the parser fails.
          // We only care about the path that was hit.
          try {
            await httpJson(port, 'POST', '/v1/messages', {
              model: 'workhorse',
              messages: [{ role: 'user', content: 'hi' }],
              max_tokens: 5,
            });
          } catch { /* expected — legacy path can't parse our anthropic stub */ }
          const lastReq = stub.requests[stub.requests.length - 1];
          assert(lastReq?.path?.startsWith('/api/chat'),
            `legacy path is /api/chat (got: ${lastReq?.path})`);
        });
      } finally { await stub.close().catch(() => {}); }
    }

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  process.exit(summary());
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
