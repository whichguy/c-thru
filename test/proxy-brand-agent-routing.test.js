#!/usr/bin/env node
'use strict';
// Brand / leaf agents: agent name → agent_to_capability (model: pin or capability)
// → model_routes → concrete model + endpoint format → correct forwarder path.
//
// Simulates the PreToolUse hook handshake:
//   body.model = "sonnet"  (Claude Code enum-safe alias)
//   messages[0] starts with a session-HMAC-authenticated agent sentinel
// Proxy must override model with the agent name, resolve the pin, and hit the
// right stub with the concrete upstream model id (not the agent alias).
//
// Run: node test/proxy-brand-agent-routing.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');

const {
  assert, assertEq, summary,
  stubBackend, writeConfig,
  httpJson, withProxy,
} = require('./helpers');
const { formatAgentSentinel } = require('../tools/agent-sentinel.js');

console.log('proxy brand-agent routing (agent name → correct API)\n');

const MSG = { max_tokens: 8, stream: false };
const SENTINEL_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SUBAGENT_HEADERS = { 'x-claude-code-agent-id': 'brand-agent-test-id' };

function anthropicOk(model) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function responsesOk(model) {
  return {
    id: 'resp_test',
    status: 'completed',
    model,
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok' }],
    }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

// Gemini AI Studio generateContent response (minimal).
function geminiOk() {
  return {
    candidates: [{
      content: { role: 'model', parts: [{ text: 'ok' }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  };
}

async function geminiStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      requests.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body,
        model_used: null, // set below from path
      });
      // Path shape: /v1beta/models/<model>:generateContent
      const m = (req.url || '').match(/\/models\/([^/:]+):/);
      if (m) requests[requests.length - 1].model_used = decodeURIComponent(m[1]);
      res.writeHead(200, { 'content-type': 'application/json' });
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
    lastRequest: () => requests[requests.length - 1] || null,
    close: () => new Promise(r => server.close(r)),
  };
}

function bodyWithAgent(agentName) {
  return Object.assign({}, MSG, {
    // Hook injects a Claude-Code-valid alias; proxy must ignore it when sentinel present.
    model: 'sonnet',
    messages: [{ role: 'user', content: `${formatAgentSentinel(agentName, SENTINEL_SECRET)}\nping` }],
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-brand-'));

  // ── 1. Mixed-format brands (xAI Responses, Ollama Messages) ─────────────
  console.log('1. brand agents reach their concrete model and wire translator');
  {
    const xai = await stubBackend({ response: responsesOk('grok-4.5') });
    const ollamaCloud = await stubBackend({ response: anthropicOk('deepseek-v4-pro:cloud') });
    const ollamaLocal = await stubBackend({ response: anthropicOk('qwen3.6:35b') });
    const anthropic = await stubBackend({ responseBody: anthropicOk('claude-sonnet-5') });

    const config = {
      endpoints: {
        xai: {
          url: `http://127.0.0.1:${xai.port}`,
          format: 'openai',
          auth: { header: 'Authorization', scheme: 'Bearer', env: 'XAI_API_KEY' },
        },
        ollama_cloud: {
          url: `http://127.0.0.1:${ollamaCloud.port}`,
          format: 'anthropic',
          auth: 'none',
          prep_policy: 'skip',
        },
        ollama_local: {
          url: `http://127.0.0.1:${ollamaLocal.port}`,
          format: 'anthropic',
          auth: 'none',
        },
        anthropic: {
          url: `http://127.0.0.1:${anthropic.port}`,
          format: 'anthropic',
          auth: 'none',
        },
      },
      model_routes: {
        // Mirror shipped brand pins
        grok: { endpoint: 'xai', name: 'grok-4.5' },
        'grok-4.5': 'xai',
        'deepseek-v4-pro:cloud': 'ollama_cloud',
        'kimi-k3:cloud': 'ollama_cloud',
        'qwen3.6:35b': 'ollama_local',
        // sonnet would go anthropic if sentinel lost
        sonnet: { endpoint: 'anthropic', name: 'claude-sonnet-5' },
      },
      agent_to_capability: {
        // Mirror shipped pins: agent name → model:<concrete>
        grok: 'model:grok-4.5',
        deepseek: 'model:deepseek-v4-pro:cloud',
        kimi: 'model:kimi-k3:cloud',
        qwen: 'model:qwen3.6:35b',
      },
      llm_profiles: {},
      llm_mode: 'best-cloud-oss',
    };
    const configPath = writeConfig(tmpDir, config);

    const cases = [
      { agent: 'grok',     stub: xai,         wantModel: 'grok-4.5',               wantPath: '/v1/responses' },
      { agent: 'deepseek', stub: ollamaCloud, wantModel: 'deepseek-v4-pro:cloud',  wantPath: '/v1/messages' },
      { agent: 'kimi',     stub: ollamaCloud, wantModel: 'kimi-k3:cloud',          wantPath: '/v1/messages' },
      { agent: 'qwen',     stub: ollamaLocal, wantModel: 'qwen3.6:35b',            wantPath: '/v1/messages' },
    ];

    await withProxy(
      {
        configPath,
        profile: '64gb',
        mode: 'best-cloud-oss',
        env: {
          XAI_API_KEY: 'xai-test-key',
          C_THRU_AGENT_SENTINEL_SECRET: SENTINEL_SECRET,
        },
      },
      async ({ port }) => {
        for (const c of cases) {
          const before = c.stub.requests.length;
          const res = await httpJson(
            port,
            'POST',
            '/v1/messages',
            bodyWithAgent(c.agent),
            SUBAGENT_HEADERS,
          );
          assertEq(res.status, 200, `${c.agent}: proxy 200`);
          assertEq(res.headers['x-c-thru-served-by'], c.wantModel,
            `${c.agent}: x-c-thru-served-by === ${c.wantModel}`);
          assertEq(res.headers['x-c-thru-agent-identity'], 'sentinel',
            `${c.agent}: agent-identity=sentinel`);
          assert(c.stub.requests.length === before + 1,
            `${c.agent}: exactly one hit on target stub (got ${c.stub.requests.length - before})`);
          const req = c.stub.lastRequest();
          assertEq(req && req.model_used, c.wantModel,
            `${c.agent}: upstream model field`);
          assert(
            req && (req.path === c.wantPath || req.path === c.wantPath + '?'),
            `${c.agent}: upstream path ${c.wantPath} (got ${req && req.path})`
          );
          // Sentinel stripped so upstream never sees routing metadata
          assert(req && req.body && !JSON.stringify(req.body).includes('[[c-thru-agent:'),
            `${c.agent}: sentinel stripped from upstream body`);
        }

        // Negative control: without a sentinel, sonnet must route to the
        // configured Anthropic endpoint and leave every brand stub untouched.
        const xaiBefore = xai.requests.length;
        const ollamaCloudBefore = ollamaCloud.requests.length;
        const ollamaLocalBefore = ollamaLocal.requests.length;
        const anthropicBefore = anthropic.requests.length;
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'sonnet',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'no agent' }],
        });
        assertEq(r.status, 200, 'no-sentinel sonnet: Anthropic stub returns 200');
        assertEq(r.headers['x-c-thru-served-by'], 'claude-sonnet-5',
          'no-sentinel sonnet: served by concrete Anthropic model');
        assertEq(r.headers['x-c-thru-agent-identity'], 'none',
          'no-sentinel sonnet: no agent identity inferred');
        assertEq(anthropic.requests.length, anthropicBefore + 1,
          'no-sentinel sonnet: Anthropic stub hit exactly once');
        const req = anthropic.lastRequest();
        assertEq(req && req.model_used, 'claude-sonnet-5',
          'no-sentinel sonnet: concrete model forwarded upstream');
        assertEq(xai.requests.length, xaiBefore, 'no-sentinel sonnet: xai untouched');
        assertEq(ollamaCloud.requests.length, ollamaCloudBefore,
          'no-sentinel sonnet: Ollama cloud untouched');
        assertEq(ollamaLocal.requests.length, ollamaLocalBefore,
          'no-sentinel sonnet: Ollama local untouched');
      }
    );

    await xai.close();
    await ollamaCloud.close();
    await ollamaLocal.close();
    await anthropic.close();
  }

  // ── 2. Gemini brand agent → generateContent, not Anthropic /v1/messages ─
  console.log('\n2. gemini brand agent → Gemini generateContent path');
  {
    const gem = await geminiStub();
    const config = {
      endpoints: {
        gemini_ai: {
          url: `http://127.0.0.1:${gem.port}`,
          format: 'gemini',
          auth: { header: 'x-goog-api-key', env: 'GOOGLE_API_KEY' },
        },
        anthropic: {
          url: 'http://127.0.0.1:9',
          format: 'anthropic',
        },
      },
      model_routes: {
        'gemini-pro': { endpoint: 'gemini_ai', name: 'gemini-pro-latest' },
        'gemini-pro-latest': 'gemini_ai',
        sonnet: { endpoint: 'anthropic', name: 'claude-sonnet-5' },
      },
      agent_to_capability: {
        gemini: 'model:gemini-pro',
      },
      llm_profiles: {},
      llm_mode: 'best-cloud',
    };
    const configPath = writeConfig(tmpDir, config);

    await withProxy(
      {
        configPath,
        profile: '64gb',
        mode: 'best-cloud',
        env: {
          GOOGLE_API_KEY: 'goog-test-key',
          C_THRU_AGENT_SENTINEL_SECRET: SENTINEL_SECRET,
        },
      },
      async ({ port }) => {
        const res = await httpJson(
          port,
          'POST',
          '/v1/messages',
          bodyWithAgent('gemini'),
          SUBAGENT_HEADERS,
        );
        assertEq(res.status, 200, 'gemini: proxy 200');
        assertEq(res.headers['x-c-thru-served-by'], 'gemini-pro-latest',
          'gemini: served-by gemini-pro-latest');
        assertEq(res.headers['x-c-thru-agent-identity'], 'sentinel', 'gemini: sentinel identity');
        assert(gem.requests.length === 1, 'gemini: one upstream request');
        const req = gem.lastRequest();
        assertEq(req && req.model_used, 'gemini-pro-latest', 'gemini: model in generateContent path');
        assert(
          req && /\/v1beta\/models\/gemini-pro-latest:generateContent/.test(req.path || ''),
          `gemini: path is generateContent (got ${req && req.path})`
        );
        assert(req && req.method === 'POST', 'gemini: POST');
      }
    );

    await gem.close();
  }

  // ── 3. Direct agent-name body.model (frontmatter model: identity) ───────
  console.log('\n3. body.model === agent name (no sentinel) still resolves');
  {
    const xai = await stubBackend({ response: responsesOk('grok-4.5') });
    const config = {
      endpoints: {
        xai: {
          url: `http://127.0.0.1:${xai.port}`,
          format: 'openai',
          auth: { header: 'Authorization', scheme: 'Bearer', env: 'XAI_API_KEY' },
        },
      },
      model_routes: {
        grok: { endpoint: 'xai', name: 'grok-4.5' },
        'grok-4.5': 'xai',
      },
      agent_to_capability: { grok: 'model:grok-4.5' },
      llm_profiles: {},
      llm_mode: 'best-cloud-oss',
    };
    const configPath = writeConfig(tmpDir, config);
    await withProxy(
      { configPath, profile: '64gb', mode: 'best-cloud-oss', env: { XAI_API_KEY: 'xai-test-key' } },
      async ({ port }) => {
        const res = await httpJson(port, 'POST', '/v1/messages', {
          model: 'grok',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }],
        });
        assertEq(res.status, 200, 'direct grok model: 200');
        assertEq(res.headers['x-c-thru-served-by'], 'grok-4.5', 'direct grok → grok-4.5');
        const req = xai.lastRequest();
        assertEq(req && req.model_used, 'grok-4.5', 'direct: upstream model');
        assert(req && String(req.path).startsWith('/v1/responses'), 'direct: /v1/responses');
      }
    );
    await xai.close();
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
