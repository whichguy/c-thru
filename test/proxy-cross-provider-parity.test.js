#!/usr/bin/env node
'use strict';
// Cross-provider parity smoke test: same prompt + same tool definition routed
// to Anthropic, Gemini AI Studio, and OpenRouter. Asserts all three return
// some tool_use block. Catches drift in our request translators when an
// upstream provider's schema evolves.
//
// Gated by C_THRU_LIVE_PARITY=1 AND ANTHROPIC_API_KEY + GOOGLE_API_KEY +
// OPENROUTER_API_KEY all set; otherwise exit 0 (skip).
//
// Run:
//   C_THRU_LIVE_PARITY=1 ANTHROPIC_API_KEY=... GOOGLE_API_KEY=... \
//     OPENROUTER_API_KEY=... node test/proxy-cross-provider-parity.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { writeConfig, httpJson, withProxy, assert, summary } = require('./helpers');

if (process.env.C_THRU_LIVE_PARITY !== '1') {
  console.log('SKIP: C_THRU_LIVE_PARITY not set');
  process.exit(0);
}
const required = ['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.log(`SKIP: missing env vars: ${missing.join(', ')}`);
  process.exit(0);
}

const ANTHROPIC_MODEL = process.env.PARITY_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const GEMINI_MODEL    = process.env.PARITY_GEMINI_MODEL    || 'gemini-3.1-flash-lite';
const OPENROUTER_MODEL = process.env.PARITY_OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct';

const TOOL = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};
const PROMPT = "What's the weather in Tokyo? Use the get_weather tool.";

async function callAndCheck(label, port, model) {
  const r = await httpJson(port, 'POST', '/v1/messages', {
    model,
    max_tokens: 200,
    tools: [TOOL],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: PROMPT }],
    stream: false,
  }, {}, 30000);
  assert(r.status === 200, `${label} status 200 (got ${r.status}: ${r.bodyText?.slice(0, 200)})`);
  const tu = (r.json?.content || []).find(b => b.type === 'tool_use');
  assert(!!tu, `${label} returned a tool_use block (content: ${JSON.stringify(r.json?.content || [])})`);
  if (tu) assert(tu.name === 'get_weather', `${label} tool name = get_weather (got ${tu.name})`);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-parity-'));
  const cfgPath = writeConfig(tmpDir, {
    endpoints: {
      anthropic:  { format: 'anthropic', url: 'https://api.anthropic.com', auth_env: 'ANTHROPIC_API_KEY' },
      gemini_ai:  { format: 'gemini',    url: 'https://generativelanguage.googleapis.com', auth_env: 'GOOGLE_API_KEY' },
      openrouter: { format: 'anthropic', url: 'https://openrouter.ai/api', auth_env: 'OPENROUTER_API_KEY' },
    },
    model_routes: {
      [ANTHROPIC_MODEL]:  'anthropic',
      [GEMINI_MODEL]:     'gemini_ai',
      [OPENROUTER_MODEL]: 'openrouter',
    },
  });

  const env = {
    CLAUDE_LLM_MODE: 'best-cloud',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };

  console.log('\nP1. Anthropic'); await withProxy({ configPath: cfgPath, profile: '16gb', env }, async ({ port }) => callAndCheck('Anthropic', port, ANTHROPIC_MODEL));
  console.log('\nP2. Gemini');    await withProxy({ configPath: cfgPath, profile: '16gb', env }, async ({ port }) => callAndCheck('Gemini',    port, GEMINI_MODEL));
  console.log('\nP3. OpenRouter');await withProxy({ configPath: cfgPath, profile: '16gb', env }, async ({ port }) => callAndCheck('OpenRouter',port, OPENROUTER_MODEL));

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(summary());
}

main().catch(err => { console.error(err); process.exit(1); });
