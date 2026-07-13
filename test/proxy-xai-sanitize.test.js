#!/usr/bin/env node
// Unit tests for sanitizeXaiAnthropicBody (xAI rejects role:system in messages[]).
// Run: node test/proxy-xai-sanitize.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROXY = path.join(ROOT, 'tools', 'claude-proxy');

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed++; }
}

// Extract pure functions from claude-proxy without starting the server.
function loadSanitize() {
  const src = fs.readFileSync(PROXY, 'utf8');
  const extract = (name) => {
    const start = src.indexOf('function ' + name);
    if (start < 0) throw new Error('not found: ' + name);
    let depth = 0;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
    }
    throw new Error('unbalanced: ' + name);
  };
  // backendHost is required by isXaiBackend
  const resolveSrc = fs.readFileSync(path.join(ROOT, 'tools', 'model-map-resolve.js'), 'utf8');
  const bhStart = resolveSrc.indexOf('function backendHost');
  let depth = 0;
  let bhFn = '';
  for (let j = resolveSrc.indexOf('{', bhStart); j < resolveSrc.length; j++) {
    if (resolveSrc[j] === '{') depth++;
    else if (resolveSrc[j] === '}' && --depth === 0) {
      bhFn = resolveSrc.slice(bhStart, j + 1);
      break;
    }
  }
  const code = [
    bhFn,
    extract('isXaiBackend'),
    extract('anthropicContentToText'),
    extract('sanitizeXaiAnthropicBody'),
    'return { isXaiBackend, sanitizeXaiAnthropicBody, anthropicContentToText };',
  ].join('\n');
  return new Function(code)();
}

console.log('1. pure sanitizeXaiAnthropicBody');
const { isXaiBackend, sanitizeXaiAnthropicBody } = loadSanitize();

ok(isXaiBackend({ id: 'xai', url: 'https://api.x.ai' }) === true, 'isXaiBackend id=xai');
ok(isXaiBackend({ id: 'x', url: 'https://api.x.ai' }) === true, 'isXaiBackend host api.x.ai');
ok(isXaiBackend({ id: 'anthropic', url: 'https://api.anthropic.com' }) === false, 'not anthropic');

{
  const inBody = {
    model: 'grok-4.5',
    max_tokens: 32,
    messages: [
      { role: 'system', content: 'You are the grok agent.' },
      { role: 'user', content: 'Who made you?' },
    ],
  };
  const out = sanitizeXaiAnthropicBody(inBody);
  ok(out !== inBody, 'returns new object when rewrite needed');
  ok(out.messages.length === 1 && out.messages[0].role === 'user', 'only user remains in messages');
  ok(out.system === 'You are the grok agent.', 'system folded to top-level: ' + JSON.stringify(out.system));
  ok(inBody.messages.length === 2, 'input not mutated');
}

{
  const inBody = {
    model: 'grok-4.5',
    system: 'Top-level system.',
    max_tokens: 32,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Agent prompt.' }] },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'developer', content: 'dev notes' },
    ],
  };
  const out = sanitizeXaiAnthropicBody(inBody);
  ok(out.messages.every(m => m.role === 'user' || m.role === 'assistant'), 'only user/assistant roles');
  ok(out.messages.length === 2, 'user+assistant kept');
  ok(/Top-level system/.test(out.system) && /Agent prompt/.test(out.system) && /dev notes/.test(out.system),
    'all system/developer text merged into system');
}

{
  const inBody = {
    model: 'grok-4.5',
    messages: [{ role: 'user', content: 'hi' }],
  };
  const out = sanitizeXaiAnthropicBody(inBody);
  ok(out === inBody, 'no-op when already clean');
}

{
  const inBody = {
    model: 'grok-4.5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      name: 'Bash',
      description: 'run',
      input_schema: { type: 'object', properties: { command: { type: 'string' } } },
    }],
  };
  const out = sanitizeXaiAnthropicBody(inBody);
  ok(out !== inBody, 'tools without required → rewrite');
  ok(Array.isArray(out.tools[0].input_schema.required) && out.tools[0].input_schema.required.length === 0,
    'required becomes [] not null/missing');
  ok(inBody.tools[0].input_schema.required === undefined, 'input not mutated');
}

{
  const inBody = {
    model: 'grok-4.5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      name: 'Bash',
      description: 'run',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: null,
      },
    }],
  };
  const out = sanitizeXaiAnthropicBody(inBody);
  ok(Array.isArray(out.tools[0].input_schema.required), 'required:null → []');
}

// ── 2. Proxy e2e: stub receives folded body ──────────────────────────────────
console.log('\n2. proxy e2e: role:system folded before upstream');

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

async function runProxyE2e() {
  const stubPort = await freePort();
  let seenBody = null;
  const stub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { seenBody = null; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'I am Grok by xAI.' }],
        model: 'grok-4.5', stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    });
  });
  await new Promise(r => stub.listen(stubPort, '127.0.0.1', r));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-xai-san-'));
  const cfgPath = path.join(tmpDir, 'model-map.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    endpoints: {
      xai: {
        url: `http://127.0.0.1:${stubPort}`,
        format: 'anthropic',
        auth: { header: 'Authorization', scheme: 'Bearer', env: 'XAI_API_KEY' },
      },
    },
    model_routes: { grok: { endpoint: 'xai', name: 'grok-4.5' }, 'grok-4.5': 'xai' },
    agent_to_capability: { grok: 'model:grok' },
    llm_profiles: {},
    llm_mode: 'best-cloud',
  }));

  const proxyPort = await freePort();
  process.env.XAI_API_KEY = process.env.XAI_API_KEY || 'xai-test-key';
  const child = spawn(process.execPath, [PROXY, '--port', String(proxyPort), '--config', cfgPath], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', d => { log += d; });
  child.stdout.on('data', d => { log += d; });

  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      http.get(`http://127.0.0.1:${proxyPort}/ping`, res => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - t0 > 8000) reject(new Error('proxy start fail\n' + log));
          else setTimeout(tick, 50);
        });
    };
    tick();
  });

  try {
    const payload = JSON.stringify({
      model: 'grok',
      max_tokens: 64,
      messages: [
        { role: 'system', content: 'You are the grok agent for c-thru.' },
        { role: 'user', content: 'What is your model name and who made you?' },
      ],
    });
    const resp = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-api-key': 'sk-ant-fake',
        },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    ok(resp.status === 200, 'proxy returns 200 for system-in-messages request');
    ok(seenBody && seenBody.model === 'grok-4.5', 'upstream model rewritten');
    ok(seenBody && Array.isArray(seenBody.messages)
      && seenBody.messages.every(m => m.role === 'user' || m.role === 'assistant'),
      'upstream messages have no system role: ' + JSON.stringify(seenBody && seenBody.messages));
    ok(seenBody && /grok agent/i.test(String(seenBody.system || '')),
      'upstream system field has folded agent prompt: ' + JSON.stringify(seenBody && seenBody.system));
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => stub.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runProxyE2e().then(() => {
  console.log(failed ? `\nFAILED (${failed})` : '\nAll proxy-xai-sanitize tests passed');
  process.exit(failed ? 1 : 0);
}).catch(e => {
  console.error(e);
  process.exit(1);
});
