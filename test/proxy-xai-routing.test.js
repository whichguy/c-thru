#!/usr/bin/env node
// Hermetic tests for xAI / brand-agent routing and auth (no live XAI_API_KEY required).
// Run: node test/proxy-xai-routing.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  httpJson,
  makeIsolatedTmpDir,
  startStubServer,
  withProxy,
  writeConfig,
} = require('./helpers');

const ROOT = path.join(__dirname, '..');
const MAP = path.join(ROOT, 'config', 'model-map.json');

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed++; }
}

// ── 1. Config / resolve ─────────────────────────────────────────────────────
console.log('1. model-map xai + brand pins');
const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
ok(map.endpoints.xai && map.endpoints.xai.url === 'https://api.x.ai', 'endpoints.xai url is origin without /v1');
ok(map.endpoints.xai.format === 'openai', 'endpoints.xai uses the Responses API translator');
ok(map.endpoints.xai.auth && map.endpoints.xai.auth.env === 'XAI_API_KEY', 'endpoints.xai auth env XAI_API_KEY');
ok(map.model_routes.grok && map.model_routes.grok.endpoint === 'xai', 'model_routes.grok → xai');
ok(map.model_routes.grok.name === 'grok-4.5', 'model_routes.grok name grok-4.5');
ok(map.model_routes['grok-build']?.endpoint === 'xai'
  && map.model_routes['grok-build']?.name === 'grok-4.5',
  'model_routes.grok-build → grok-4.5 @ xai');
ok(map.model_routes['grok-build-latest']?.endpoint === 'xai'
  && map.model_routes['grok-build-latest']?.name === 'grok-4.5',
  'model_routes.grok-build-latest → grok-4.5 @ xai');
// Brand leaves pin public shorthands; latest_models expands to concrete ids.
ok(map.agent_to_capability.grok === 'model:grok', 'agent_to_capability.grok pin');
ok(map.latest_models?.grok === 'grok-4.5', 'latest_models.grok → grok-4.5');
ok(map.agent_to_capability.deepseek === 'model:deepseek', 'deepseek pin');
ok(map.latest_models?.deepseek === 'deepseek-v4-pro:cloud', 'latest_models.deepseek');
ok(map.agent_to_capability.qwen === 'model:qwen', 'qwen pin');
ok(map.latest_models?.qwen === 'qwen3.6:35b', 'latest_models.qwen');
ok(map.agent_to_capability.kimi === 'model:kimi', 'kimi pin');
ok(map.latest_models?.kimi === 'kimi-k3:cloud', 'latest_models.kimi');
ok(map.agent_to_capability.gemini === 'model:gemini', 'gemini pin');
ok(map.latest_models?.gemini === 'gemini-pro-latest' || map.latest_models?.gemini === 'gemini-pro',
  'latest_models.gemini concrete id');

// best-cloud-gov: generalist/writer use Grok at 32gb+; 16gb stays small local
const genGov = map.llm_profiles.generalist['best-cloud-gov'];
const writerGov = map.llm_profiles.writer['best-cloud-gov'];
ok(genGov && genGov['16gb'] === 'phi4-mini:3.8b', 'generalist gov 16gb stays phi4-mini');
ok(genGov && genGov['64gb'] === 'grok-4.5', 'generalist gov 64gb → grok-4.5');
ok(writerGov && writerGov['16gb'] === 'phi4-mini:3.8b', 'writer gov 16gb stays phi4-mini');
ok(writerGov && writerGov['32gb'] === 'grok-4.5', 'writer gov 32gb → grok-4.5');

const { isChineseOrigin } = require(path.join(ROOT, 'tools', 'model-map-resolve.js'));
ok(isChineseOrigin('grok-4.5') === false, 'grok-4.5 is not Chinese-origin');
ok(isChineseOrigin('deepseek-v4-pro:cloud') === true, 'deepseek pin is Chinese-origin (gov filter)');
ok(isChineseOrigin('qwen3.6:35b') === true, 'qwen pin is Chinese-origin');
ok(isChineseOrigin('kimi-k3:cloud') === true || isChineseOrigin('moonshotai/kimi') === true,
  'kimi family Chinese-origin via vendor or name');

// Kimi may or may not match isChineseOrigin depending on family tokens — document actual:
console.log('     isChineseOrigin(kimi-k3:cloud)=', isChineseOrigin('kimi-k3:cloud'));

// ── 2. explain resolve (child node) ─────────────────────────────────────────
console.log('\n2. resolveBackend via explain-style require');
const explainResult = spawnSync(process.execPath, [
  path.join(ROOT, 'tools', 'c-thru-explain.js'),
  '--model', 'grok-build',
  '--mode', 'best-cloud',
  '--tier', '64gb',
], { encoding: 'utf8', env: { ...process.env, CLAUDE_MODEL_MAP_PATH: MAP } });
const explained = (explainResult.stdout || '') + (explainResult.stderr || '');
ok(!explainResult.error && explainResult.status === 0,
  'explain --model grok-build exits 0');
ok(
  /model=grok-build/.test(explained)
    && /grok-4\.5/.test(explained)
    && /endpoint\s+xai/.test(explained)
    && /served_by\s+grok-4\.5/.test(explained)
    && /openai/.test(explained),
  'explain resolves exactly grok-build → grok-4.5 @ xai using openai format',
);

// ── 3. Proxy path + auth e2e with stub ──────────────────────────────────────
console.log('\n3. proxy path + auth (stub xAI)');

async function runProxyE2e() {
  const tmpDir = makeIsolatedTmpDir('c-thru-xai-');
  let stub = null;
  try {
    stub = await startStubServer({
      '*': {
        id: 'resp_test',
        status: 'completed',
        model: 'grok-4.5',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'pong' }],
        }],
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    });

    // Point xAI at a local Responses stub; keep url as an origin so the shared
    // Responses forwarder appends /v1/responses exactly once.
    const cfgPath = writeConfig(tmpDir, {
      endpoints: {
        xai: {
          url: stub.url,
          format: 'openai',
          auth: { header: 'Authorization', scheme: 'Bearer', env: 'XAI_API_KEY' },
        },
        anthropic: { url: 'https://api.anthropic.com', format: 'anthropic' },
      },
      model_routes: {
        grok: { endpoint: 'xai', name: 'grok-4.5' },
        'grok-4.5': 'xai',
        'grok-build': { endpoint: 'xai', name: 'grok-4.5' },
        'grok-build-latest': { endpoint: 'xai', name: 'grok-4.5' },
      },
      agent_to_capability: { grok: 'model:grok-4.5' },
      llm_profiles: {},
      llm_mode: 'best-cloud',
    });

    await withProxy({
      configPath: cfgPath,
      env: { XAI_API_KEY: 'xai-live-test-key' },
    }, async ({ port }) => {
      const resp = await httpJson(port, 'POST', '/v1/messages', {
        model: 'grok-build',
        max_tokens: 16,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: 'ping' }],
        tools: [{
          name: 'lookup',
          description: 'Look up a value',
          input_schema: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
          },
          strict: true,
        }],
        tool_choice: {
          type: 'tool',
          name: 'lookup',
          disable_parallel_tool_use: true,
        },
      }, {
        'x-api-key': 'sk-ant-MUST-NOT-LEAK',
        'anthropic-version': '2023-06-01',
        'x-claude-code-session-id': 'session-xai-canary',
        'x-claude-code-agent-id': 'agent-xai-canary',
        'x-claude-code-parent-agent-id': 'parent-xai-canary',
      });

      const seen = stub.requests.at(-1) || {};
      ok(resp.status === 200, 'proxy /v1/messages → 200 via xAI Responses stub');
      ok(seen.url === '/v1/responses' || seen.url === '/v1/responses?',
        'stub path is /v1/responses (not /v1/v1/responses): ' + seen.url);
      ok(!/\/v1\/v1\//.test(seen.url || ''), 'no double /v1 in path');
      const auth = seen.headers && (seen.headers.authorization || seen.headers.Authorization);
      ok(auth === 'Bearer xai-live-test-key', 'outbound Authorization is XAI key: ' + auth);
      ok(!seen.headers?.['x-api-key'] || seen.headers['x-api-key'] !== 'sk-ant-MUST-NOT-LEAK',
        'inbound Anthropic x-api-key not forwarded');
      for (const name of [
        'x-claude-code-session-id',
        'x-claude-code-agent-id',
        'x-claude-code-parent-agent-id',
      ]) {
        ok(!Object.prototype.hasOwnProperty.call(seen.headers || {}, name),
          `xAI upstream does not receive ${name}`);
      }
      const parsedBody = seen.body;
      ok(parsedBody && parsedBody.model === 'grok-4.5',
        'grok-build alias rewritten to grok-4.5: ' + (parsedBody && parsedBody.model));
      ok(parsedBody && parsedBody.store === false
        && parsedBody.input?.[0]?.type === 'message'
        && parsedBody.input?.[0]?.content?.[0]?.type === 'input_text',
        'Anthropic request is translated to stateless typed Responses input');
      ok(parsedBody?.reasoning?.effort === 'low'
        && parsedBody.reasoning.summary === undefined,
      'xAI disabled thinking request uses the nearest low-effort approximation');
      ok((resp.headers['x-c-thru-translation-gap'] || '')
        .split(',')
        .includes('thinking.type:disabled'),
      'xAI disabled thinking mismatch is explicitly traceable');
      ok(parsedBody?.tools?.[0]?.type === 'function'
        && parsedBody.tools[0].name === 'lookup'
        && parsedBody.tools[0].strict === undefined,
      'xAI Responses tool stays flat and relies on implicit strict mode');
      const strictTrueGaps =
        (resp.headers['x-c-thru-translation-gap'] || '').split(',');
      ok(!strictTrueGaps.includes('tool.strict')
        && !strictTrueGaps.includes('tool.strict:false'),
      'xAI strict:true uses implicit strict mode without a false gap');
      ok(JSON.stringify(parsedBody?.tool_choice) === JSON.stringify({
        type: 'function',
        function: { name: 'lookup' },
      }), 'xAI named tool_choice uses documented nested function selector');
      ok(parsedBody?.parallel_tool_calls === false,
        'xAI route preserves Anthropic disable_parallel_tool_use');
      ok(resp.json?.content?.[0]?.type === 'text'
        && resp.json?.content?.[0]?.text === 'pong',
        'Responses output is translated back to Anthropic content');

      const supportedEffort = await httpJson(port, 'POST', '/v1/messages', {
        model: 'grok-build',
        max_tokens: 16,
        output_config: { effort: 'medium' },
        messages: [{ role: 'user', content: 'supported effort' }],
        tools: [{
          name: 'lookup',
          description: 'Look up a value',
          input_schema: { type: 'object', properties: {} },
          strict: true,
        }],
      });
      const supportedEffortBody = stub.requests.at(-1)?.body;
      const supportedEffortGaps =
        (supportedEffort.headers['x-c-thru-translation-gap'] || '').split(',');
      ok(supportedEffortBody?.reasoning?.effort === 'medium',
        'xAI preserves a supported medium effort value');
      ok(!supportedEffortGaps.includes('output_config.effort')
        && !supportedEffortGaps.includes('tool.strict')
        && !supportedEffortGaps.includes('tool.strict:false'),
      'xAI supported effort and strict:true produce no false semantic gaps');

      const omittedStrict = await httpJson(port, 'POST', '/v1/messages', {
        model: 'grok-build',
        max_tokens: 16,
        output_config: { effort: 'xhigh' },
        messages: [{ role: 'user', content: 'implicit strict' }],
        tools: [{
          name: 'lookup',
          description: 'Look up a value',
          input_schema: { type: 'object', properties: {} },
        }],
      });
      const omittedStrictBody = stub.requests.at(-1)?.body;
      const omittedStrictGaps =
        (omittedStrict.headers['x-c-thru-translation-gap'] || '').split(',');
      ok(omittedStrictBody?.tools?.[0]?.strict === undefined,
        'xAI omits strict on the wire when Anthropic strict is omitted');
      ok(omittedStrictGaps.includes('tool.strict'),
        'xAI implicit strict mismatch is traced for an omitted Anthropic strict');
      ok(omittedStrictBody?.reasoning?.effort === 'high'
        && omittedStrictGaps.includes('output_config.effort'),
      'xAI clamps unsupported xhigh effort to high and traces the mismatch');

      const falseStrict = await httpJson(port, 'POST', '/v1/messages', {
        model: 'grok-build',
        max_tokens: 16,
        output_config: { effort: 'max' },
        messages: [{ role: 'user', content: 'explicit non-strict' }],
        tools: [{
          name: 'lookup',
          description: 'Look up a value',
          input_schema: { type: 'object', properties: {} },
          strict: false,
        }],
      });
      const falseStrictBody = stub.requests.at(-1)?.body;
      const falseStrictGaps =
        (falseStrict.headers['x-c-thru-translation-gap'] || '').split(',');
      ok(falseStrictBody?.tools?.[0]?.strict === undefined,
        'xAI omits explicit strict:false from its Responses request');
      ok(falseStrictGaps.includes('tool.strict:false'),
        'xAI explicit strict:false mismatch is traceable');
      ok(falseStrictBody?.reasoning?.effort === 'high'
        && falseStrictGaps.includes('output_config.effort'),
      'xAI clamps unsupported max effort to high and traces the mismatch');
    });
  } finally {
    if (stub) await stub.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runProxyE2e().then(() => {
  console.log(failed ? `\nFAILED (${failed})` : '\nAll proxy-xai-routing tests passed');
  process.exit(failed ? 1 : 0);
}).catch(e => {
  console.error(e);
  process.exit(1);
});
