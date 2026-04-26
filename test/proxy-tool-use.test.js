#!/usr/bin/env node
'use strict';
// Tool-use round-trip tests through the proxy.
// Verifies: tools array preserved, tool_use blocks reach client,
// tool_result blocks forwarded, multi-turn conversations work.
//
// Run: node test/proxy-tool-use.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');

const { assert, assertEq, summary, writeConfig, withProxy, httpJson } = require('./helpers');

console.log('proxy tool-use round-trip tests\n');

// Custom stub that returns a tool_use response when a tool is offered.
function toolStubBackend() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({ method: req.method, body });
      const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
      const lastMsg = body?.messages?.[body.messages.length - 1];
      const hasToolResult = Array.isArray(lastMsg?.content) &&
        lastMsg.content.some(b => b?.type === 'tool_result');

      let response;
      if (hasTools && !hasToolResult) {
        response = {
          id: 'msg_tool', type: 'message', role: 'assistant',
          model: body.model, stop_reason: 'tool_use', stop_sequence: null,
          content: [
            { type: 'text', text: 'I will check the weather.' },
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'SF' } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      } else {
        response = {
          id: 'msg_final', type: 'message', role: 'assistant',
          model: body?.model || 'stub', stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', text: 'It is sunny in SF.' }],
          usage: { input_tokens: 20, output_tokens: 7 },
        };
      }
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

function buildConfig(stubPort) {
  return {
    backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` } },
    model_routes: { 'tool-model': 'stub' },
    llm_profiles: {
      '128gb': { workhorse: { connected_model: 'tool-model', disconnect_model: 'tool-model' } },
    },
  };
}

const TOOLS_DECL = [{
  name: 'get_weather',
  description: 'Get the current weather for a city',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
}];

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-tooluse-'));

  try {
    // ── Test 1: tools array preserved to backend ────────────────────────────
    console.log('1. request tools array reaches backend intact');
    {
      const stub = await toolStubBackend();
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse',
            tools: TOOLS_DECL,
            messages: [{ role: 'user', content: 'Weather in SF?' }],
            max_tokens: 100,
          });
          assertEq(r.status, 200, 'status 200');
          const lastReq = stub.requests[stub.requests.length - 1];
          assert(Array.isArray(lastReq?.body?.tools), 'tools array forwarded');
          assertEq(lastReq.body.tools[0].name, 'get_weather', 'tool name preserved');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 2: tool_use response reaches client ────────────────────────────
    console.log('\n2. backend tool_use block returned to client');
    {
      const stub = await toolStubBackend();
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse',
            tools: TOOLS_DECL,
            messages: [{ role: 'user', content: 'Weather in SF?' }],
            max_tokens: 100,
          });
          assertEq(r.json?.stop_reason, 'tool_use', 'stop_reason=tool_use');
          const blocks = r.json?.content || [];
          const toolUse = blocks.find(b => b.type === 'tool_use');
          assert(toolUse, `tool_use block present (got types: ${JSON.stringify(blocks.map(b => b.type))})`);
          assertEq(toolUse?.name, 'get_weather', 'tool_use.name');
          assertEq(toolUse?.id, 'tu_1', 'tool_use.id');
          assertEq(toolUse?.input?.city, 'SF', 'tool_use.input.city');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 3: tool_result block forwarded on second turn ──────────────────
    console.log('\n3. tool_result block forwarded to backend on follow-up');
    {
      const stub = await toolStubBackend();
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          // Second turn: client sends tool_result
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse',
            tools: TOOLS_DECL,
            messages: [
              { role: 'user', content: 'Weather in SF?' },
              { role: 'assistant', content: [
                { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'SF' } },
              ]},
              { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'tu_1', content: '72°F sunny' },
              ]},
            ],
            max_tokens: 100,
          });
          assertEq(r.status, 200, 'status 200');
          const lastReq = stub.requests[stub.requests.length - 1];
          const fwdMessages = lastReq?.body?.messages || [];
          assertEq(fwdMessages.length, 3, '3 messages forwarded');
          const lastFwd = fwdMessages[fwdMessages.length - 1];
          const tr = (lastFwd?.content || []).find(b => b.type === 'tool_result');
          assert(tr, `tool_result preserved (got: ${JSON.stringify(lastFwd?.content)})`);
          assertEq(tr?.tool_use_id, 'tu_1', 'tool_result.tool_use_id preserved');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 4: full round-trip — tool_use → tool_result → final answer ─────
    console.log('\n4. full round-trip: tool_use → tool_result → final assistant text');
    {
      const stub = await toolStubBackend();
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          // Turn 1: ask, get tool_use
          const r1 = await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse', tools: TOOLS_DECL,
            messages: [{ role: 'user', content: 'Weather?' }],
            max_tokens: 100,
          });
          const toolUse = r1.json?.content?.find(b => b.type === 'tool_use');
          assert(toolUse?.id === 'tu_1', 'turn 1 returns tool_use');

          // Turn 2: send tool_result, get final answer
          const r2 = await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse', tools: TOOLS_DECL,
            messages: [
              { role: 'user', content: 'Weather?' },
              { role: 'assistant', content: r1.json.content },
              { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'tu_1', content: 'sunny' },
              ]},
            ],
            max_tokens: 100,
          });
          assertEq(r2.json?.stop_reason, 'end_turn', 'turn 2 stop_reason=end_turn');
          const text = (r2.json?.content || []).find(b => b.type === 'text')?.text || '';
          assert(text.toLowerCase().includes('sunny'),
            `final answer references the tool result (got ${JSON.stringify(text)})`);
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 5: tool_choice forwarded ───────────────────────────────────────
    console.log('\n5. tool_choice field forwarded to backend');
    {
      const stub = await toolStubBackend();
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse',
            tools: TOOLS_DECL,
            tool_choice: { type: 'tool', name: 'get_weather' },
            messages: [{ role: 'user', content: 'Weather in SF?' }],
            max_tokens: 100,
          });
          const lastReq = stub.requests[stub.requests.length - 1];
          assert(lastReq?.body?.tool_choice, `tool_choice forwarded (got ${JSON.stringify(lastReq?.body?.tool_choice)})`);
          assertEq(lastReq?.body?.tool_choice?.name, 'get_weather', 'tool_choice.name');
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
