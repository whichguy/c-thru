#!/usr/bin/env node
'use strict';
// Live behavioral smoke test for Gemini thinking + observability features
// against real Gemini 3 Pro. Validates that the synthetic mock-based assertions
// in proxy-gemini-translation.test.js (cases 17-24) hold against the real API.
//
// Gated by C_THRU_LIVE_GEMINI=1 AND GOOGLE_API_KEY set; otherwise SKIP.
//
// Costs ~5-10 small requests against gemini-pro-latest (Gemini 3 Pro) per run.
// Default model can be overridden with C_THRU_LIVE_GEMINI_MODEL.
//
// Run:
//   C_THRU_LIVE_GEMINI=1 GOOGLE_API_KEY=$KEY \
//     node test/proxy-gemini-live-thinking.test.js

const fs   = require('fs');
const http = require('http');
const os   = require('os');
const path = require('path');
const { writeConfig, httpJson, withProxy, assert, skip, summary } = require('./helpers');

if (process.env.C_THRU_LIVE_GEMINI !== '1') {
  console.log('SKIP: C_THRU_LIVE_GEMINI not set');
  process.exit(0);
}
if (!process.env.GOOGLE_API_KEY) {
  console.log('SKIP: GOOGLE_API_KEY not set');
  process.exit(0);
}

const MODEL = process.env.C_THRU_LIVE_GEMINI_MODEL || 'gemini-pro-latest';

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-live-think-'));
  const cfgPath = writeConfig(tmpDir, {
    endpoints: {
      gemini_ai: { format: 'gemini', url: 'https://generativelanguage.googleapis.com', auth_env: 'GOOGLE_API_KEY' },
    },
    model_routes: {
      [MODEL]: 'gemini_ai',
      'gemini-pro-latest': 'gemini_ai',
      're:^gemini-.*': 'gemini_ai',
    },
  });
  const env = { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: process.env.GOOGLE_API_KEY };

  // ── L1. Auto-enable thinking on Gemini 3 Pro ─────────────────────────────
  // Asserts: header surfaces auto-enable + budget-added + thinking-level. The
  // exact thinking_tokens count varies per request; we just check it's > 0.
  console.log('\nL1. Live: Gemini 3 Pro auto-enables thinking on default request');
  await withProxy({ configPath: cfgPath, profile: '16gb', env }, async ({ port }) => {
    const r = await httpJson(port, 'POST', '/v1/messages', {
      model: MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: 'In one sentence, why is the sky blue?' }],
      stream: false,
    }, {}, 60000);
    assert(r.status === 200, `L1 status 200 (got ${r.status}: ${r.bodyText?.slice(0, 300)})`);
    if (r.headers?.['x-c-thru-thinking-auto-enabled'] === '1') {
      assert(true, 'L1 auto-enable header present');
      assert(typeof r.headers?.['x-c-thru-thinking-level'] === 'string',
        `L1 thinking-level header set (got '${r.headers?.['x-c-thru-thinking-level']}')`);
      const added = Number(r.headers?.['x-c-thru-thinking-budget-added']);
      assert(added > 0, `L1 budget-added > 0 (got ${added})`);
      // output_tokens parity: should include thinking. If thinking-tokens header
      // is set, output_tokens must be >= candidates + thoughts.
      const thinkTokens = Number(r.headers?.['x-c-thru-thinking-tokens'] || 0);
      const outTokens = r.json?.usage?.output_tokens || 0;
      assert(outTokens >= thinkTokens,
        `L1 output_tokens(${outTokens}) >= thinking_tokens(${thinkTokens})`);
    } else {
      // If Google rolled back auto-thinking on the model in use, surface the
      // skip rather than failing — the model behavior is upstream-controlled.
      skip(`L1 auto-enable did not fire on ${MODEL} (header absent — possibly downgraded variant)`);
    }
    // Visible text must be substantive — i.e. the budget-arithmetic fix actually
    // gave the response room. The pre-fix bug truncated at ~10 visible tokens.
    const text = (r.json?.content || []).find(b => b.type === 'text')?.text || '';
    assert(text.length > 30,
      `L1 visible answer is substantive (length=${text.length}, got '${text.slice(0, 80)}')`);
  });

  // ── L2. Explicit thinking:{type:'disabled'} opts out ─────────────────────
  console.log('\nL2. Live: thinking:{type:"disabled"} suppresses auto-enable');
  await withProxy({ configPath: cfgPath, profile: '16gb', env }, async ({ port }) => {
    const r = await httpJson(port, 'POST', '/v1/messages', {
      model: MODEL,
      max_tokens: 100,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'Say hi.' }],
      stream: false,
    }, {}, 60000);
    assert(r.status === 200, `L2 status 200 (got ${r.status}: ${r.bodyText?.slice(0, 300)})`);
    assert(r.headers?.['x-c-thru-thinking-auto-enabled'] === undefined,
      `L2 no auto-enable header on opt-out (got '${r.headers?.['x-c-thru-thinking-auto-enabled']}')`);
  });

  // ── L3. Streaming: c-thru-thinking-tokens custom event ───────────────────
  // Validates Task #8 — when thinking happens on a stream, the custom event
  // fires before message_delta. Anthropic's usage object stays spec-compliant.
  console.log('\nL3. Live streaming: c-thru-thinking-tokens custom event');
  await withProxy({ configPath: cfgPath, profile: '16gb', env }, async ({ port }) => {
    const sse = await new Promise((resolve, reject) => {
      const req = http.request({
        port, method: 'POST', path: '/v1/messages',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let buf = '';
        res.on('data', d => { buf += d.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
        res.on('error', reject);
      });
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('L3 stream timeout')); });
      req.write(JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: 'In one sentence: why does ice float?' }],
        stream: true,
      }));
      req.end();
    });
    assert(sse.status === 200, `L3 status 200 (got ${sse.status})`);
    // message_delta.usage must be spec-clean (no thinking_output_tokens leak).
    const deltaMatch = sse.body.match(/event:\s*message_delta\s*\ndata:\s*(\{[^\n]+\})/);
    assert(deltaMatch != null, 'L3 message_delta present');
    let delta = null;
    try { delta = JSON.parse(deltaMatch[1]); } catch {}
    assert(delta?.usage?.thinking_output_tokens === undefined,
      `L3 message_delta.usage spec-compliant (got '${delta?.usage?.thinking_output_tokens}')`);
    // If auto-enable fired, the custom event should be present.
    const autoEnabled = sse.headers['x-c-thru-thinking-auto-enabled'] === '1';
    if (autoEnabled) {
      const cthruMatch = sse.body.match(/event:\s*c-thru-thinking-tokens\s*\ndata:\s*(\{[^\n]+\})/);
      if (cthruMatch) {
        let evt = null;
        try { evt = JSON.parse(cthruMatch[1]); } catch {}
        assert(typeof evt?.thinking_tokens === 'number' && evt.thinking_tokens > 0,
          `L3 custom event carries thinking_tokens > 0 (got ${evt?.thinking_tokens})`);
      } else {
        // Gemini sometimes returns 0 thoughts even when thinking is requested
        // ("LOW thinking bug" — see test 20c). Surface as skip, not fail.
        skip('L3 c-thru-thinking-tokens event absent (upstream returned 0 thoughts)');
      }
    } else {
      skip('L3 auto-enable did not fire — skipping custom-event assertion');
    }
  });

  // ── L4. Multi-turn tool_use thoughtSignature roundtrip ───────────────────
  // The big one: send a turn-2 request that echoes a turn-1 tool_use. Without
  // the GEMINI_THOUGHT_SIG_CACHE working end-to-end, real Gemini 3 returns
  // 400 "Function call is missing a thought_signature". This test catches
  // sig-cache regressions that the mock tests can't.
  console.log('\nL4. Live: multi-turn tool_use roundtrip preserves thoughtSignature');
  await withProxy({ configPath: cfgPath, profile: '16gb', env }, async ({ port }) => {
    const tools = [{
      name: 'add',
      description: 'Add two integers and return the sum.',
      input_schema: {
        type: 'object',
        properties: { a: { type: 'integer' }, b: { type: 'integer' } },
        required: ['a', 'b'],
      },
    }];
    const turn1 = await httpJson(port, 'POST', '/v1/messages', {
      model: MODEL,
      max_tokens: 200,
      tools,
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: 'What is 7 + 11? Use the add tool.' }],
      stream: false,
    }, {}, 60000);
    assert(turn1.status === 200, `L4 turn1 status 200 (got ${turn1.status}: ${turn1.bodyText?.slice(0, 300)})`);
    const toolUse = (turn1.json?.content || []).find(b => b.type === 'tool_use');
    if (!toolUse) {
      skip(`L4 turn1 produced no tool_use — model declined to call (content: ${JSON.stringify(turn1.json?.content || []).slice(0, 200)})`);
      return;
    }
    assert(toolUse.name === 'add', `L4 turn1 tool name=add (got ${toolUse.name})`);

    // Turn 2: echo turn-1 history + tool_result. Proxy must inject the
    // cached thoughtSignature on the outbound functionCall, otherwise real
    // Gemini 3 will return 400 "Function call is missing a thought_signature".
    const assistantContent = (turn1.json?.content || []).filter(b =>
      b.type === 'text' || b.type === 'tool_use' || b.type === 'thinking',
    );
    const turn2 = await httpJson(port, 'POST', '/v1/messages', {
      model: MODEL,
      max_tokens: 200,
      tools,
      messages: [
        { role: 'user', content: 'What is 7 + 11? Use the add tool.' },
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '18' }] },
      ],
      stream: false,
    }, {}, 60000);
    assert(turn2.status === 200,
      `L4 turn2 status 200 — sig roundtrip held (got ${turn2.status}: ${turn2.bodyText?.slice(0, 300)})`);
    const finalText = (turn2.json?.content || []).find(b => b.type === 'text')?.text || '';
    assert(/18/.test(finalText),
      `L4 turn2 final answer mentions 18 (got '${finalText.slice(0, 100)}')`);
  });

  summary();
}

main().catch(e => { console.error(e); process.exit(1); });
