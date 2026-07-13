#!/usr/bin/env node
// Optional live smoke against api.x.ai (Anthropic Messages compat path) and
// optional c-thru proxy path with model "grok".
//
// Skips unless both C_THRU_LIVE_XAI=1 and XAI_API_KEY are set.
//
// Run (key from env / ~/.zshrc):
//   C_THRU_LIVE_XAI=1 node test/proxy-xai-live.test.js
//   # or after: source ~/.zshrc
//   C_THRU_LIVE_XAI=1 node test/proxy-xai-live.test.js
//
// Checks:
//   C1  non-stream /v1/messages
//   C2  stream + C2a Anthropic SSE vocabulary
//   C3  tools multi-turn
//   C4  identity: "what model / who made you" → answer must claim Grok / xAI
//       (deterministic regex judge — no second LLM required)
//   C5  c-thru proxy with model:"grok" → same identity (optional; needs free port)
//   control OpenAI chat/completions
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const live = process.env.C_THRU_LIVE_XAI === '1';
const key = process.env.XAI_API_KEY || '';
const ROOT = path.join(__dirname, '..');
const PROXY = path.join(ROOT, 'tools', 'claude-proxy');

if (!live || !key) {
  console.log('proxy-xai-live: SKIP (set C_THRU_LIVE_XAI=1 and XAI_API_KEY to run)');
  process.exit(0);
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

function postMessages(body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.x.ai',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        authorization: 'Bearer ' + key,
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
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log('proxy-xai-live: Anthropic Messages against api.x.ai\n');

  // C1 non-stream text
  const r1 = await postMessages({
    model: 'grok-4.5',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
  });
  ok(r1.status === 200, 'C1 non-stream HTTP 200 (got ' + r1.status + ')');
  let j1 = null;
  try { j1 = JSON.parse(r1.body); } catch (_) {}
  ok(j1 && (j1.type === 'message' || j1.content || j1.role === 'assistant'),
    'C1 body looks Anthropic-shaped (type/content): ' + (j1 && j1.type));
  if (r1.status !== 200) {
    console.error('     body slice:', r1.body.slice(0, 400));
  }

  // C2 stream — check for Anthropic event vocabulary vs OpenAI [DONE]
  const r2 = await new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'grok-4.5',
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'Say hi' }],
    });
    const req = https.request({
      hostname: 'api.x.ai',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        authorization: 'Bearer ' + key,
        'anthropic-version': '2023-06-01',
        accept: 'text/event-stream',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
  ok(r2.status === 200, 'C2 stream HTTP 200 (got ' + r2.status + ')');
  const hasAnthropicEvents = /event:\s*message_start|event:\s*content_block_/.test(r2.body);
  const hasOpenAiDone = /data:\s*\[DONE\]/.test(r2.body) && !hasAnthropicEvents;
  ok(hasAnthropicEvents, 'C2a stream uses Anthropic SSE events (message_start/content_block_*)');
  if (hasOpenAiDone) {
    console.error('  NOTE C2a: stream looks OpenAI-shaped ([DONE]) — Anthropic bridge insufficient; need translator');
  }
  if (!hasAnthropicEvents) {
    console.error('     stream head:', r2.body.slice(0, 500));
  }

  // C3 tools multi-turn (tool_use → tool_result → text)
  const toolDef = {
    name: 'get_weather',
    description: 'Get weather for a city',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  };
  const t1 = await postMessages({
    model: 'grok-4.5',
    max_tokens: 256,
    tools: [toolDef],
    tool_choice: { type: 'tool', name: 'get_weather' },
    messages: [{ role: 'user', content: 'What is the weather in Austin?' }],
  });
  ok(t1.status === 200, 'C3 turn1 HTTP 200 (got ' + t1.status + ')');
  let jt1 = null;
  try { jt1 = JSON.parse(t1.body); } catch (_) {}
  const toolUse = jt1 && Array.isArray(jt1.content)
    ? jt1.content.find(b => b && b.type === 'tool_use')
    : null;
  ok(!!toolUse, 'C3 turn1 returns tool_use block');
  if (toolUse) {
    const t2 = await postMessages({
      model: 'grok-4.5',
      max_tokens: 128,
      tools: [toolDef],
      messages: [
        { role: 'user', content: 'What is the weather in Austin?' },
        { role: 'assistant', content: jt1.content },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '72F and sunny' }],
        },
      ],
    });
    ok(t2.status === 200, 'C3 turn2 HTTP 200 (got ' + t2.status + ')');
    let jt2 = null;
    try { jt2 = JSON.parse(t2.body); } catch (_) {}
    const text = (jt2 && Array.isArray(jt2.content) ? jt2.content : [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join(' ');
    ok(/72|sunny|Austin/i.test(text), 'C3 turn2 incorporates tool_result: ' + text.slice(0, 120));
  }

  // Control: OpenAI chat completions (proves key if Anthropic path fails)
  const r3 = await new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'grok-4.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    });
    const req = https.request({
      hostname: 'api.x.ai',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        authorization: 'Bearer ' + key,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
  ok(r3.status === 200, 'control OpenAI chat/completions 200 (got ' + r3.status + ')');

  // C4 identity — direct xAI (no proxy)
  console.log('\nC4 identity (direct api.x.ai, model grok-4.5)');
  const id1 = await postMessages({
    model: 'grok-4.5',
    max_tokens: 128,
    messages: [{ role: 'user', content: IDENTITY_PROMPT }],
  });
  ok(id1.status === 200, 'C4 direct HTTP 200 (got ' + id1.status + ')');
  const idText = textFromAnthropicBody(id1.body);
  const idScore = scoreGrokIdentity(idText);
  console.log('     reply:', idScore.sample.replace(/\s+/g, ' '));
  ok(idScore.claimsGrok || idScore.claimsXai,
    'C4 reply mentions Grok and/or xAI (got grok=' + idScore.claimsGrok + ' xai=' + idScore.claimsXai + ')');
  ok(!idScore.claimsClaudeSelf, 'C4 reply does not claim to be Claude/Anthropic/GPT as self');
  ok(idScore.pass, 'C4 identity judge PASS (deterministic regex)');

  // C5 identity via c-thru proxy with logical model "grok"
  console.log('\nC5 identity via claude-proxy (model: "grok" → grok-4.5 @ xai)');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-xai-live-'));
  const cfgPath = path.join(tmpDir, 'model-map.json');
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'model-map.json'), 'utf8'));
  // Minimal map: only xai + grok routes (real api.x.ai, real key from env)
  const liveCfg = {
    endpoints: {
      xai: shipped.endpoints.xai,
      anthropic: shipped.endpoints.anthropic,
    },
    model_routes: {
      grok: shipped.model_routes.grok,
      'grok-4.5': shipped.model_routes['grok-4.5'],
    },
    agent_to_capability: { grok: 'model:grok' },
    llm_profiles: {},
    llm_mode: 'best-cloud',
  };
  fs.writeFileSync(cfgPath, JSON.stringify(liveCfg, null, 2));

  let child = null;
  try {
    const proxyPort = await freePort();
    child = spawn(process.execPath, [PROXY, '--port', String(proxyPort), '--config', cfgPath], {
      env: { ...process.env, XAI_API_KEY: key, CLAUDE_MODEL_MAP_PATH: cfgPath },
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
      model: 'grok', // logical name — proxy must rewrite to grok-4.5 @ xai
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
  } catch (e) {
    ok(false, 'C5 proxy path error: ' + e.message);
  } finally {
    if (child) {
      try { child.kill('SIGTERM'); } catch (_) {}
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(failed
    ? `\nFAILED (${failed})`
    : '\nproxy-xai-live: all live checks passed (C1/C2/C2a/C3/C4-identity/C5-proxy-identity)');
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
