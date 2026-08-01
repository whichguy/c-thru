#!/usr/bin/env node
// Optional live smoke against xAI's Responses API and the c-thru Anthropic
// gateway translation with logical model "grok-build".
//
// Skips unless both C_THRU_LIVE_XAI=1 and XAI_API_KEY are set.
//
// Run (key from env / ~/.zshrc):
//   C_THRU_LIVE_XAI=1 node test/proxy-xai-live.test.js
//   # or after: source ~/.zshrc
//   C_THRU_LIVE_XAI=1 node test/proxy-xai-live.test.js
//
// Checks:
//   C1  non-stream /v1/responses
//   C2  native Responses SSE vocabulary
//   C3  stateless client-tool multi-turn
//   C4  identity: "what model / who made you" → answer must claim Grok / xAI
//       (deterministic regex judge — no second LLM required)
//   C5  c-thru proxy with model:"grok-build" → Anthropic-shaped identity reply
//   C6  c-thru proxy client-tool round trip (tool_use → tool_result → text)
//   C7  c-thru proxy translates live Responses SSE to Anthropic SSE
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  ensureModelTestSupervisor,
  modelTestTimeoutMs,
  modelTestProxyEnv,
  terminateAndReap,
} = require('./helpers');
if (require.main === module) ensureModelTestSupervisor();
const {
  classifyXaiBillingBlock,
  emitLiveOutcome,
} = require('./provider-live-prerequisites');

const live = process.env.C_THRU_LIVE_XAI === '1';
const key = process.env.XAI_API_KEY || '';
const LIVE_SUITE = 'proxy-xai-live';
const ROOT = path.join(__dirname, '..');
const PROXY = path.join(ROOT, 'tools', 'claude-proxy');

if (!live || !key) {
  console.log('proxy-xai-live: SKIP (set C_THRU_LIVE_XAI=1 and XAI_API_KEY to run)');
  emitLiveOutcome('xai', LIVE_SUITE, 'skipped', !live ? 'gate_not_enabled' : 'missing_XAI_API_KEY');
  process.exit(0);
}

let MODEL_TEST_TIMEOUT_MS;
try {
  MODEL_TEST_TIMEOUT_MS = modelTestTimeoutMs();
} catch (err) {
  console.error(err);
  emitLiveOutcome('xai', LIVE_SUITE, 'failed', err?.message || 'invalid_model_test_timeout');
  process.exit(1);
}

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed++; }
}

function textFromAnthropicBody(bodyStr) {
  let j;
  try { j = JSON.parse(bodyStr); } catch (_) { return ''; }
  if (!j || !Array.isArray(j.content)) return '';
  return j.content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
}

function anthropicSseEvents(bodyStr) {
  const events = [];
  let eventName = '';
  for (const rawLine of String(bodyStr || '').split(/\r?\n/)) {
    if (rawLine.startsWith('event:')) {
      eventName = rawLine.slice(6).trim();
    } else if (rawLine.startsWith('data:')) {
      try {
        events.push({ event: eventName, data: JSON.parse(rawLine.slice(5).trim()) });
      } catch (_) {}
      eventName = '';
    } else if (!rawLine.trim()) {
      eventName = '';
    }
  }
  return events;
}

function textFromResponsesBody(bodyStr) {
  let j;
  try { j = JSON.parse(bodyStr); } catch (_) { return ''; }
  return (Array.isArray(j?.output) ? j.output : [])
    .flatMap(item => Array.isArray(item?.content) ? item.content : [])
    .filter(part => part?.type === 'output_text')
    .map(part => part.text || '')
    .join('\n');
}

// Deterministic identity judge — no second LLM.
// Pass: claims Grok and/or xAI as maker; does not primarily claim Claude/Anthropic/GPT/Gemini.
function scoreGrokIdentity(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const claimsGrok = /\bgrok\b/i.test(t);
  const claimsXai = /\bxai\b|\bx\.ai\b|\bspace\s*x\s*ai\b|\belon\b/i.test(t);
  // Soft fail if it claims to BE Claude/Anthropic as self-identity (not mere comparison)
  const claimsClaudeSelf = /\bi('m| am)\s+(claude|an? anthropic)\b/i.test(t)
    || /\bmy name is claude\b/i.test(t)
    || /\bi('m| am)\s+gpt-?\d/i.test(t);
  const pass = (claimsGrok || claimsXai) && !claimsClaudeSelf;
  return { pass, claimsGrok, claimsXai, claimsClaudeSelf, lower, sample: t.slice(0, 240) };
}

const IDENTITY_PROMPT =
  'Answer briefly in 1-3 sentences: What is your model name (or family), and who made you / which company built you? ' +
  'State your own identity only — do not claim to be Claude, GPT, or Gemini.';

function postResponses(body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.x.ai',
      path: '/v1/responses',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        authorization: 'Bearer ' + key,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(MODEL_TEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`xAI model request timed out after ${MODEL_TEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

function postProxy(port, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        'x-api-key': 'sk-ant-MUST-NOT-LEAK',
        'anthropic-version': '2023-06-01',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(MODEL_TEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`proxied xAI model request timed out after ${MODEL_TEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log('proxy-xai-live: Responses API against api.x.ai + c-thru translation\n');

  // C1 non-stream text
  const r1 = await postResponses({
    model: 'grok-4.5',
    max_output_tokens: 32,
    input: 'Reply with exactly: pong',
    store: false,
  });
  const billingBlock = classifyXaiBillingBlock(r1);
  if (billingBlock) {
    console.log(`  SKIP  BLOCKED: provider billing/quota — ${billingBlock}; live contracts not exercised`);
    emitLiveOutcome('xai', LIVE_SUITE, 'blocked', billingBlock);
    process.exit(process.env.C_THRU_STRICT_LIVE_PROVIDERS === '1' ? 2 : 0);
  }
  ok(r1.status === 200, 'C1 non-stream HTTP 200 (got ' + r1.status + ')');
  let j1 = null;
  try { j1 = JSON.parse(r1.body); } catch (_) {}
  ok(j1?.status === 'completed' && Array.isArray(j1?.output),
    'C1 body is a completed Responses object');
  ok(/pong/i.test(textFromResponsesBody(r1.body)),
    'C1 Responses output contains pong');
  if (r1.status !== 200) {
    console.error('     body slice:', r1.body.slice(0, 400));
  }

  // C2 stream — xAI documents the OpenAI Responses event vocabulary.
  const r2 = await postResponses({
    model: 'grok-4.5',
    max_output_tokens: 32,
    input: 'Say hi',
    stream: true,
    store: false,
  });
  ok(r2.status === 200, 'C2 stream HTTP 200 (got ' + r2.status + ')');
  const hasResponsesDelta = /"type"\s*:\s*"response\.output_text\.delta"/.test(r2.body);
  const hasResponsesTerminal = /"type"\s*:\s*"response\.completed"/.test(r2.body);
  ok(hasResponsesDelta, 'C2 stream contains response.output_text.delta');
  ok(hasResponsesTerminal, 'C2 stream contains response.completed terminal event');
  if (!hasResponsesDelta || !hasResponsesTerminal) {
    console.error('     stream head:', r2.body.slice(0, 500));
  }

  // C3 stateless client tools (function_call → function_call_output → text).
  const toolDef = {
    type: 'function',
    name: 'get_weather',
    description: 'Get weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  };
  const initialInput = [{
    role: 'user',
    content: 'What is the weather in Austin? Use get_weather.',
  }];
  const t1 = await postResponses({
    model: 'grok-4.5',
    max_output_tokens: 256,
    tools: [toolDef],
    tool_choice: 'required',
    input: initialInput,
    store: false,
    include: ['reasoning.encrypted_content'],
  });
  ok(t1.status === 200, 'C3 turn1 HTTP 200 (got ' + t1.status + ')');
  let jt1 = null;
  try { jt1 = JSON.parse(t1.body); } catch (_) {}
  const functionCall = jt1 && Array.isArray(jt1.output)
    ? jt1.output.find(item => item?.type === 'function_call')
    : null;
  ok(!!functionCall?.call_id, 'C3 turn1 returns a function_call with call_id');
  if (functionCall?.call_id) {
    const t2 = await postResponses({
      model: 'grok-4.5',
      max_output_tokens: 128,
      tools: [toolDef],
      input: [
        ...initialInput,
        ...jt1.output,
        { type: 'function_call_output', call_id: functionCall.call_id, output: '72F and sunny' },
      ],
      store: false,
      include: ['reasoning.encrypted_content'],
    });
    ok(t2.status === 200, 'C3 turn2 HTTP 200 (got ' + t2.status + ')');
    const text = textFromResponsesBody(t2.body);
    ok(/72|sunny|Austin/i.test(text), 'C3 turn2 incorporates tool_result: ' + text.slice(0, 120));
  }

  // C4 identity — direct xAI (no proxy)
  console.log('\nC4 identity (direct api.x.ai, model grok-4.5)');
  const id1 = await postResponses({
    model: 'grok-4.5',
    max_output_tokens: 128,
    input: IDENTITY_PROMPT,
    store: false,
  });
  ok(id1.status === 200, 'C4 direct HTTP 200 (got ' + id1.status + ')');
  const idText = textFromResponsesBody(id1.body);
  const idScore = scoreGrokIdentity(idText);
  console.log('     reply:', idScore.sample.replace(/\s+/g, ' '));
  ok(idScore.claimsGrok || idScore.claimsXai,
    'C4 reply mentions Grok and/or xAI (got grok=' + idScore.claimsGrok + ' xai=' + idScore.claimsXai + ')');
  ok(!idScore.claimsClaudeSelf, 'C4 reply does not claim to be Claude/Anthropic/GPT as self');
  ok(idScore.pass, 'C4 identity judge PASS (deterministic regex)');

  // C5 identity via c-thru proxy with the explicit Grok Build API alias.
  console.log('\nC5 identity via claude-proxy (model: "grok-build" → grok-4.5 @ xai Responses)');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-xai-live-'));
  const cfgPath = path.join(tmpDir, 'model-map.json');
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'model-map.json'), 'utf8'));
  // Minimal map: xAI Responses plus the canonical and Grok Build aliases.
  const liveCfg = {
    endpoints: {
      xai: shipped.endpoints.xai,
      anthropic: shipped.endpoints.anthropic,
    },
    model_routes: {
      grok: shipped.model_routes.grok,
      'grok-4.5': shipped.model_routes['grok-4.5'],
      'grok-build': shipped.model_routes['grok-build'],
      'grok-build-latest': shipped.model_routes['grok-build-latest'],
    },
    agent_to_capability: { grok: 'model:grok-4.5' },
    llm_profiles: {},
    llm_mode: 'best-cloud',
  };
  fs.writeFileSync(cfgPath, JSON.stringify(liveCfg, null, 2));

  let child = null;
  try {
    const proxyPort = await freePort();
    child = spawn(process.execPath, [PROXY, '--port', String(proxyPort), '--config', cfgPath], {
      env: {
        ...process.env,
        ...modelTestProxyEnv(MODEL_TEST_TIMEOUT_MS),
        XAI_API_KEY: key,
        CLAUDE_MODEL_MAP_PATH: cfgPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let proxyLog = '';
    child.stderr.on('data', d => { proxyLog += d; });
    child.stdout.on('data', d => { proxyLog += d; });

    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        http.get(`http://127.0.0.1:${proxyPort}/ping`, res => {
          res.resume();
          resolve();
        }).on('error', () => {
          if (Date.now() - t0 > 10000) reject(new Error('proxy did not start\n' + proxyLog.slice(-800)));
          else setTimeout(tick, 50);
        });
      };
      tick();
    });

    const proxied = await postProxy(proxyPort, {
      model: 'grok-build', // logical alias — proxy must rewrite to grok-4.5 @ xAI Responses
      metadata: { user_id: 'c-thru-xai-live-canary' },
      max_tokens: 128,
      messages: [{ role: 'user', content: IDENTITY_PROMPT }],
    });
    ok(proxied.status === 200, 'C5 proxy HTTP 200 (got ' + proxied.status + ')');
    const served = proxied.headers['x-c-thru-served-by'] || proxied.headers['x-claude-proxy-served-by'] || '';
    ok(/grok/i.test(String(served)), 'C5 x-c-thru-served-by mentions grok (got ' + JSON.stringify(served) + ')');
    const pText = textFromAnthropicBody(proxied.body);
    const pScore = scoreGrokIdentity(pText);
    console.log('     proxy reply:', pScore.sample.replace(/\s+/g, ' '));
    ok(pScore.pass, 'C5 proxy identity judge PASS (Grok/xAI, not Claude-as-self)');

    // C6 proves the two protocol adapters compose against the live model. The
    // first request must return an Anthropic tool_use block; the second echoes
    // that block and a tool_result so c-thru can reconstruct the Responses
    // function_call / function_call_output history.
    console.log('\nC6 client-tool round trip via claude-proxy');
    const weatherTool = {
      name: 'get_weather',
      description: 'Return the current weather for a city',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    };
    const toolTurn1 = await postProxy(proxyPort, {
      model: 'grok-build',
      metadata: { user_id: 'c-thru-xai-live-canary' },
      max_tokens: 256,
      tools: [weatherTool],
      tool_choice: { type: 'tool', name: 'get_weather' },
      messages: [{ role: 'user', content: 'Use get_weather for Austin.' }],
    });
    let toolTurn1Json = null;
    try { toolTurn1Json = JSON.parse(toolTurn1.body); } catch (_) {}
    const toolUse = Array.isArray(toolTurn1Json?.content)
      ? toolTurn1Json.content.find(block => block?.type === 'tool_use')
      : null;
    ok(toolTurn1.status === 200 && !!toolUse?.id,
      'C6 turn1 returns an Anthropic tool_use block with an id');
    if (toolUse?.id) {
      const toolTurn2 = await postProxy(proxyPort, {
        model: 'grok-build',
        metadata: { user_id: 'c-thru-xai-live-canary' },
        max_tokens: 128,
        tools: [weatherTool],
        messages: [
          { role: 'user', content: 'Use get_weather for Austin.' },
          { role: 'assistant', content: [toolUse] },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: '72F and sunny',
            }],
          },
        ],
      });
      const toolTurn2Text = textFromAnthropicBody(toolTurn2.body);
      ok(toolTurn2.status === 200 && /72|sunny|Austin/i.test(toolTurn2Text),
        'C6 turn2 incorporates the Claude Code tool_result');
    }

    // C7 exercises the live upstream event dialect through c-thru. Hermetic
    // tests verify chunk timing and xAI's whole-function-call variant; this
    // canary verifies that an actual xAI stream terminates in Anthropic order.
    console.log('\nC7 live Responses SSE translated by claude-proxy');
    const streamed = await postProxy(proxyPort, {
      model: 'grok-build',
      metadata: { user_id: 'c-thru-xai-live-canary' },
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'Reply briefly with: stream-ok' }],
    });
    const streamEvents = anthropicSseEvents(streamed.body);
    const streamNames = streamEvents.map(event => event.event);
    const streamText = streamEvents
      .filter(event => event.event === 'content_block_delta' &&
        event.data?.delta?.type === 'text_delta')
      .map(event => event.data.delta.text || '')
      .join('');
    ok(streamed.status === 200 &&
      streamNames[0] === 'message_start' &&
      streamNames.includes('content_block_delta') &&
      streamNames.at(-1) === 'message_stop',
    'C7 emits a complete Anthropic SSE lifecycle');
    ok(/stream-ok/i.test(streamText),
      'C7 translated SSE contains the requested text');
  } catch (e) {
    ok(false, 'C5-C7 proxy path error: ' + e.message);
  } finally {
    if (child) {
      try {
        await terminateAndReap(child);
      } catch (cleanupError) {
        ok(false, 'C5-C7 proxy teardown error: ' + cleanupError.message);
      }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(failed
    ? `\nFAILED (${failed})`
    : '\nproxy-xai-live: all live checks passed (Responses non-stream/stream/tools/identity + proxy identity/tool/SSE)');
  emitLiveOutcome(
    'xai',
    LIVE_SUITE,
    failed ? 'failed' : 'passed',
    failed ? `${failed}_assertions_failed` : 'all_mandatory_contracts_exercised'
  );
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  emitLiveOutcome('xai', LIVE_SUITE, 'failed', e?.code || e?.message || 'uncaught_error');
  process.exit(1);
});
