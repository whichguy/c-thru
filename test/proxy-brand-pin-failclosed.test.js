#!/usr/bin/env node
'use strict';
// Brand / model: pin fail-closed (Stream E / advisors P0a–P0c):
//   - Signed agent model: pins must NOT cascade to routes.default on upstream 403
//   - Ordinary capability requests still cascade on the same shared proxy
//   - Concurrent brand hard-fail + capability cascade must not leak policy
//
// Run: node test/proxy-brand-pin-failclosed.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  stubBackend, writeConfig,
  httpJson, withProxy,
} = require('./helpers');
const { formatAgentSentinel } = require('../tools/agent-sentinel.js');

console.log('proxy brand model: pin fail-closed\n');

const SENTINEL_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SUBAGENT_HEADERS = { 'x-claude-code-agent-id': 'brand-failclosed-test' };

function anthropicOk(model, text = 'ok') {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function bodyWithAgent(agentName) {
  return {
    model: 'sonnet',
    max_tokens: 16,
    stream: false,
    messages: [{
      role: 'user',
      content: `${formatAgentSentinel(agentName, SENTINEL_SECRET)}\nReply as the brand leaf.`,
    }],
  };
}

function buildConfig(xaiPort, generalistPort, opts = {}) {
  return {
    endpoints: {
      xai: {
        url: `http://127.0.0.1:${xaiPort}`,
        format: 'anthropic',
        auth: { header: 'Authorization', scheme: 'Bearer', env: 'XAI_API_KEY' },
      },
      generalist_ep: {
        url: `http://127.0.0.1:${generalistPort}`,
        format: 'anthropic',
        auth: 'none',
      },
      anthropic: {
        url: 'http://127.0.0.1:9',
        format: 'anthropic',
        auth: 'none',
      },
    },
    model_routes: {
      'grok-4.5': 'xai',
      'glm-fake:cloud': 'generalist_ep',
      sonnet: { endpoint: 'anthropic', name: 'claude-sonnet-5' },
    },
    agent_to_capability: {
      grok: 'model:grok-4.5',
    },
    routes: {
      default: 'generalist',
    },
    llm_profiles: {
      generalist: {
        'best-cloud-oss': { '64gb': 'glm-fake:cloud' },
        on_failure: 'cascade',
      },
      workhorse: {
        'best-cloud-oss': { '64gb': 'glm-fake:cloud' },
        on_failure: 'cascade',
      },
    },
    llm_mode: 'best-cloud-oss',
    ...(opts.extra || {}),
  };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-brand-failclosed-'));

  try {
    // ── 1. Brand pin 403 must not cascade to generalist ───────────────────
    console.log('1. brand model: pin 403 → hard_fail (no routes.default / generalist)');
    {
      const xai = await stubBackend({ failWith: 403 });
      const gen = await stubBackend({ responseBody: anthropicOk('glm-fake:cloud', 'I am Grok') });
      try {
        const configPath = writeConfig(tmpDir, buildConfig(xai.port, gen.port));
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
            const res = await httpJson(
              port,
              'POST',
              '/v1/messages',
              bodyWithAgent('grok'),
              SUBAGENT_HEADERS,
            );
            assert(res.status >= 400, `brand 403: non-2xx (got ${res.status})`);
            assertEq(res.status, 403, 'brand 403: surface upstream status (not laundered 200)');
            assertEq(xai.requests.length, 1, 'brand 403: xAI tried exactly once');
            assertEq(gen.requests.length, 0, 'brand 403: generalist NEVER hit (cascade suppressed)');
            const bodyText = JSON.stringify(res.json || {});
            assert(!/I am Grok/i.test(bodyText),
              'brand 403: response body must not carry laundered brand prose');
            // Fallback header must not claim a successful substitute path
            assert(
              !res.headers['x-c-thru-fallback-from'] || res.headers['x-c-thru-fallback-from'] === '',
              'brand 403: no fallback-from success path'
            );
            assertEq(res.headers['x-c-thru-fallback-suppressed'], 'true',
              'brand 403: x-c-thru-fallback-suppressed header');
            assertEq(res.headers['x-c-thru-on-failure'], 'hard_fail',
              'brand 403: x-c-thru-on-failure=hard_fail');
            assertEq(res.headers['x-c-thru-agent'], 'grok',
              'brand 403: x-c-thru-agent=grok');

            const recent = await httpJson(port, 'GET', '/c-thru/recent?n=5', null, {});
            assertEq(recent.status, 200, 'brand 403: /c-thru/recent 200');
            const entry = (recent.json && recent.json.requests && recent.json.requests[0]) || {};
            assertEq(entry.agent, 'grok', 'recent: agent=grok');
            assertEq(entry.on_failure, 'hard_fail', 'recent: on_failure=hard_fail');
            assertEq(entry.fallback_suppressed, true, 'recent: fallback_suppressed');
            assertEq(entry.ok, false, 'recent: ok=false');
            assertEq(entry.status, 403, 'recent: status=403');
          },
        );
      } finally {
        await xai.close();
        await gen.close();
      }
    }

    // ── 2. Capability cascade still works (control) ───────────────────────
    console.log('\n2. ordinary capability still cascades (control)');
    {
      const primary = await stubBackend({ failWith: 502 });
      const secondary = await stubBackend({ responseBody: anthropicOk('glm-fake:cloud', 'cascade-ok') });
      try {
        const cfg = {
          endpoints: {
            primary_ep: {
              url: `http://127.0.0.1:${primary.port}`,
              format: 'anthropic',
              auth: 'none',
              fallback_to: 'workhorse-secondary',
            },
            secondary_ep: {
              url: `http://127.0.0.1:${secondary.port}`,
              format: 'anthropic',
              auth: 'none',
            },
          },
          model_routes: {
            'workhorse-primary': 'primary_ep',
            'workhorse-secondary': 'secondary_ep',
          },
          llm_profiles: {
            workhorse: {
              'best-cloud-oss': { '64gb': 'workhorse-primary' },
              on_failure: 'cascade',
            },
          },
          llm_mode: 'best-cloud-oss',
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy(
          { configPath, profile: '64gb', mode: 'best-cloud-oss' },
          async ({ port }) => {
            const res = await httpJson(port, 'POST', '/v1/messages', {
              model: 'workhorse',
              max_tokens: 16,
              messages: [{ role: 'user', content: 'hi' }],
            });
            assertEq(res.status, 200, 'capability cascade: 200');
            assertEq(primary.requests.length, 1, 'capability cascade: primary tried');
            assertEq(secondary.requests.length, 1, 'capability cascade: secondary served');
            assertEq(res.headers['x-c-thru-fallback-from'], 'primary_ep',
              'capability cascade: fallback-from set');
          },
        );
      } finally {
        await primary.close();
        await secondary.close();
      }
    }

    // ── 3. Concurrent brand hard-fail ∥ capability cascade on one proxy ───
    console.log('\n3. concurrency: brand hard-fail ∥ capability cascade (shared proxy)');
    {
      const xai = await stubBackend({ failWith: 403 });
      const gen = await stubBackend({ responseBody: anthropicOk('glm-fake:cloud', 'cascade-ok') });
      const primary = await stubBackend({ failWith: 502 });
      try {
        const cfg = {
          endpoints: {
            xai: {
              url: `http://127.0.0.1:${xai.port}`,
              format: 'anthropic',
              auth: { header: 'Authorization', scheme: 'Bearer', env: 'XAI_API_KEY' },
            },
            primary_ep: {
              url: `http://127.0.0.1:${primary.port}`,
              format: 'anthropic',
              auth: 'none',
              fallback_to: 'glm-fake:cloud',
            },
            generalist_ep: {
              url: `http://127.0.0.1:${gen.port}`,
              format: 'anthropic',
              auth: 'none',
            },
            anthropic: {
              url: 'http://127.0.0.1:9',
              format: 'anthropic',
              auth: 'none',
            },
          },
          model_routes: {
            'grok-4.5': 'xai',
            'workhorse-primary': 'primary_ep',
            'glm-fake:cloud': 'generalist_ep',
            sonnet: { endpoint: 'anthropic', name: 'claude-sonnet-5' },
          },
          agent_to_capability: {
            grok: 'model:grok-4.5',
          },
          routes: { default: 'generalist' },
          llm_profiles: {
            generalist: {
              'best-cloud-oss': { '64gb': 'glm-fake:cloud' },
              on_failure: 'cascade',
            },
            workhorse: {
              'best-cloud-oss': { '64gb': 'workhorse-primary' },
              on_failure: 'cascade',
            },
          },
          llm_mode: 'best-cloud-oss',
        };
        const configPath = writeConfig(tmpDir, cfg);
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
            const brandPromise = httpJson(
              port,
              'POST',
              '/v1/messages',
              bodyWithAgent('grok'),
              SUBAGENT_HEADERS,
            );
            const capPromise = httpJson(port, 'POST', '/v1/messages', {
              model: 'workhorse',
              max_tokens: 16,
              messages: [{ role: 'user', content: 'capability path' }],
            });
            const [brandRes, capRes] = await Promise.all([brandPromise, capPromise]);

            assert(brandRes.status >= 400, `concurrent brand: non-2xx (got ${brandRes.status})`);
            assertEq(brandRes.status, 403, 'concurrent brand: 403');
            assertEq(capRes.status, 200, 'concurrent capability: 200 via cascade');
            assertEq(xai.requests.length, 1, 'concurrent: xAI hit once (brand)');
            assertEq(primary.requests.length, 1, 'concurrent: workhorse primary tried');
            // generalist_ep serves capability cascade only — brand must not add a hit
            assertEq(gen.requests.length, 1,
              'concurrent: generalist hit once (capability only), not brand+capability');
            assertEq(capRes.headers['x-c-thru-served-by'], 'glm-fake:cloud',
              'concurrent capability: served by cascade target');
          },
        );
      } finally {
        await xai.close();
        await gen.close();
        await primary.close();
      }
    }

    // ── 4. Explicit llm_profiles hard_fail still works (regression) ───────
    console.log('\n4. profile on_failure hard_fail still gates capability');
    {
      const primary = await stubBackend({ failWith: 502 });
      const secondary = await stubBackend({ responseBody: anthropicOk('secondary') });
      try {
        const cfg = {
          endpoints: {
            primary_ep: {
              url: `http://127.0.0.1:${primary.port}`,
              format: 'anthropic',
              auth: 'none',
              fallback_to: 'secondary-model',
            },
            secondary_ep: {
              url: `http://127.0.0.1:${secondary.port}`,
              format: 'anthropic',
              auth: 'none',
            },
          },
          model_routes: {
            'primary-model': 'primary_ep',
            'secondary-model': 'secondary_ep',
          },
          llm_profiles: {
            hard_fail_cap: {
              'best-cloud-oss': { '64gb': 'primary-model' },
              on_failure: 'hard_fail',
            },
          },
          llm_mode: 'best-cloud-oss',
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy(
          { configPath, profile: '64gb', mode: 'best-cloud-oss' },
          async ({ port }) => {
            const res = await httpJson(port, 'POST', '/v1/messages', {
              model: 'hard_fail_cap',
              max_tokens: 8,
              messages: [{ role: 'user', content: 'x' }],
            });
            assertEq(res.status, 502, 'profile hard_fail: 502');
            assertEq(primary.requests.length, 1, 'profile hard_fail: primary tried');
            assertEq(secondary.requests.length, 0, 'profile hard_fail: secondary skipped');
          },
        );
      } finally {
        await primary.close();
        await secondary.close();
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  process.exit(summary() ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
