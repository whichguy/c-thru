#!/usr/bin/env node
'use strict';
// Routing coverage for the real Anthropic-to-OpenAI Responses dispatch path.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stubBackend, writeConfig, httpJson, withProxy } = require('./helpers');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}
const OPENAI_MODEL = 'gpt-routing-test';
const PRIMARY_MODEL = 'primary-routing-test';

function buildConfig(stubPort) {
  return {
    endpoints: {
      openai_endpoint: {
        url: `http://127.0.0.1:${stubPort}`,
        format: 'openai', call_style: 'openai',
        auth: { header: 'Authorization', scheme: 'Bearer', env: 'OPENAI_TEST_KEY' },
      },
      failing_primary: {
        url: 'http://127.0.0.1:1', format: 'anthropic', call_style: 'anthropic',
        auth: 'none', fallback_to: OPENAI_MODEL,
      },
    },
    model_routes: {
      [OPENAI_MODEL]: 'openai_endpoint',
      [PRIMARY_MODEL]: 'failing_primary',
    },
  };
}

function request(body, model = OPENAI_MODEL) {
  return Object.assign({ model }, body);
}
function handler(captured, response) {
  return (req, res) => {
    let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
      captured.value = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    }); return true;
  };
}

async function main() {
  console.log('proxy-openai-routing tests\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-openai-routing-'));
  const stub = await stubBackend();
  try {
    const configPath = writeConfig(tmp, buildConfig(stub.port));
    await withProxy({ configPath, profile: '16gb', env: { OPENAI_TEST_KEY: 'routing-secret' } }, async ({ port }) => {
      // 1. Request mapper through dispatchOpenAIBackend ----------------------
      console.log('1. Dispatcher forwards to mapper/forwarder with all request context');
      const captured = {};
      stub.setHandler(handler(captured, { id: 'resp_routing', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } }));
      const r = await httpJson(port, 'POST', '/v1/messages', request({
        system: [{ type: 'text', text: 'route system' }], temperature: 0.4, top_p: 0.8, max_tokens: 44,
        top_k: 10, stop_sequences: ['END'], thinking: { type: 'enabled', budget_tokens: 4096 },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'tool_result', tool_use_id: 'old', content: 'dropped' }] }],
        tools: [{ name: 'schema', description: 'keeps JSON schema', input_schema: { type: 'object', additionalProperties: false, anyOf: [{ type: 'object' }] } }],
        tool_choice: { type: 'tool', name: 'schema' }, stream: false,
      }));
      assert(r.status === 200 && r.json?.content?.[0]?.text === 'ok', 'dispatchOpenAIBackend reaches forwardOpenAI');
      assert(captured.value?.instructions === 'route system' && captured.value?.max_output_tokens === 44
        && captured.value?.temperature === 0.4 && captured.value?.top_p === 0.8, 'mapper sampling and system fields observed on wire');
      assert(captured.value?.reasoning?.effort === 'medium' && captured.value?.reasoning?.summary === 'auto', 'thinking maps to reasoning');
      assert(captured.value?.tool_choice?.type === 'function' && captured.value.tool_choice.name === 'schema', 'tool-specific choice uses Responses vocabulary');
      assert(captured.value?.tools?.[0]?.parameters?.additionalProperties === false && captured.value?.tools?.[0]?.parameters?.anyOf, 'scrubOpenAiSchema is a documented no-op passthrough');
      assert((r.headers['x-c-thru-translation-gap'] || '').includes('tool_result')
        && (r.headers['x-c-thru-translation-gap'] || '').includes('param:top_k')
        && (r.headers['x-c-thru-translation-gap'] || '').includes('param:stop_sequences'), 'translation gaps are surfaced');

      // 2. Response mapper/status mapper ------------------------------------
      console.log('\n2. Status and content mapping observed through real response');
      const toolCaptured = {};
      stub.setHandler(handler(toolCaptured, { id: 'resp_tool', status: 'completed',
        output: [{ type: 'function_call', call_id: 'call_route', name: 'schema', arguments: '{"v":1}' }], usage: { input_tokens: 2, output_tokens: 3 } }));
      const tool = await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'call it' }], stream: false }));
      assert(tool.json?.stop_reason === 'tool_use' && tool.json?.content?.[0]?.type === 'tool_use'
        && tool.json?.content?.[0]?.input?.v === 1, 'status mapper inspects function_call output');
      stub.setHandler((req, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad input', type: 'invalid_request_error' } })); return true; });
      const err = await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'bad' }], stream: false }));
      assert(err.status === 400 && err.json?.error?.type === 'invalid_request_error', 'extended anthropicErrorType handles OpenAI HTTP envelope');

      // 3. Endpoint-shaped auth ----------------------------------------------
      console.log('\n3. endpoints-shaped OpenAI auth uses Bearer token');
      const authCaptured = {};
      stub.setHandler(handler(authCaptured, { id: 'resp_auth', status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0 } }));
      await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'auth' }], stream: false }));
      assert(authCaptured.value?.store === false && authCaptured.value?.stream === false, 'Responses stateless request fields forwarded');
      assert(stub.lastRequest()?.headers?.authorization === 'Bearer routing-secret', 'Authorization: Bearer key applied');

      // 4. Fallback dispatch preserves the OpenAI call style ----------------
      console.log('\n4. Anthropic primary fallback re-dispatches to OpenAI Responses');
      const fallbackCaptured = {};
      stub.setHandler(handler(fallbackCaptured, { id: 'resp_fallback', status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'fallback ok' }] }],
        usage: { input_tokens: 1, output_tokens: 2 } }));
      const fallback = await httpJson(port, 'POST', '/v1/messages', request({
        messages: [{ role: 'user', content: 'use fallback' }], stream: false,
      }, PRIMARY_MODEL));
      assert(fallback.status === 200 && fallback.json?.content?.[0]?.text === 'fallback ok',
        'failed primary retries through OpenAI fallback with translated response');
      assert(stub.lastRequest()?.path === '/v1/responses' && fallbackCaptured.value?.input?.[0]?.content?.[0]?.text === 'use fallback',
        'fallback reaches Responses endpoint with translated Anthropic input');
    });
  } finally {
    await stub.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passed}/${passed + failed} passed${failed ? ` — ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e.stack || e); process.exit(1); });
