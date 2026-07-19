#!/usr/bin/env node
'use strict';
// Live Responses-API shape validation. Gated by C_THRU_LIVE_OPENAI=1 and OPENAI_API_KEY.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeConfig, httpJson, httpStream, withProxy, assert, assertEq, skip, summary } = require('./helpers');

if (process.env.C_THRU_LIVE_OPENAI !== '1') {
  console.log('SKIP: C_THRU_LIVE_OPENAI not set');
  process.exit(0);
}
if (!process.env.OPENAI_API_KEY) {
  console.log('SKIP: OPENAI_API_KEY not set');
  process.exit(0);
}

const MODEL = process.env.C_THRU_LIVE_OPENAI_MODEL || 'gpt-4.1-mini';
const request = body => Object.assign({ model: MODEL }, body);

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-openai-live-'));
  const configPath = writeConfig(tmpDir, {
    endpoints: { openai: { format: 'openai', call_style: 'openai', url: 'https://api.openai.com', auth_env: 'OPENAI_API_KEY' } },
    model_routes: { [MODEL]: 'openai' },
  });
  try {
    // S1. Non-stream text ---------------------------------------------------
    console.log('\nS1. non-streaming text completion');
    await withProxy({ configPath, profile: '16gb', env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', request({ max_tokens: 32, messages: [{ role: 'user', content: 'Reply PONG only.' }], stream: false }), {}, 30000);
      assertEq(r.status, 200, 'S1 status');
      assert(typeof r.json?.content?.[0]?.text === 'string' && r.json.content[0].text.length > 0, 'S1 Anthropic content[].text');
    });

    // S2. Streaming lifecycle ----------------------------------------------
    console.log('\nS2. streaming lifecycle');
    await withProxy({ configPath, profile: '16gb', env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY } }, async ({ port }) => {
      const s = await httpStream(port, 'POST', '/v1/messages', request({ max_tokens: 32, messages: [{ role: 'user', content: 'Say hi.' }], stream: true }), {}, 30000);
      const names = s.events.map(e => e.event);
      assert(names[0] === 'message_start' && names.includes('content_block_start') && names.includes('content_block_delta') && names.includes('message_delta') && names[names.length - 1] === 'message_stop', 'S2 Anthropic SSE lifecycle');
      assert(!s.rawBody.includes('response.output_text.delta'), 'S2 no raw OpenAI event names');
    });

    // S3. count_tokens stays proxy-side ------------------------------------
    console.log('\nS3. count_tokens proxy-side estimate');
    await withProxy({ configPath, profile: '16gb', env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages/count_tokens', request({ messages: [{ role: 'user', content: 'count me' }] }), {}, 30000);
      assertEq(r.status, 200, 'S3 status');
      assert((r.json?.input_tokens || 0) > 0 && r.headers['x-c-thru-count-tokens'] === 'estimate', 'S3 estimate never calls /v1/responses');
    });

    // S4. One tool call ------------------------------------------------------
    console.log('\nS4. single tool call');
    await withProxy({ configPath, profile: '16gb', env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', request({
        max_tokens: 64,
        tools: [{ name: 'get_weather', description: 'Get weather.', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
        tool_choice: { type: 'tool', name: 'get_weather' },
        messages: [{ role: 'user', content: 'Get the weather in Tokyo.' }], stream: false,
      }), {}, 30000);
      assertEq(r.status, 200, 'S4 status');
      assert(r.json?.stop_reason === 'tool_use' && (r.json?.content || []).some(b => b.type === 'tool_use'), 'S4 Anthropic tool_use response');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  process.exit(summary());
}

main().catch(e => { console.error(e.stack || e); process.exit(1); });
