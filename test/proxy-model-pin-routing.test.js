#!/usr/bin/env node
'use strict';
// Proxy-level integration tests for model: pin routing in resolveBackend.
// Reproduces the false-cycle bug fixed in 6ccefde where resolveBackend's
// model: prefix handler pre-added pinnedModel to the seen set before
// recursing, causing every agent pin to be falsely rejected as a cycle.
//
// Run with: node test/proxy-model-pin-routing.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  stubBackend, writeConfig,
  httpJson, withProxy,
} = require('./helpers');
const { formatAgentSentinel } = require('../tools/agent-sentinel.js');

console.log('proxy-model-pin-routing integration tests\n');
const SENTINEL_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// Minimal Anthropic-format request body (non-streaming).
const MSG_BODY = {
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 1,
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-pin-test-'));

async function main() {
  try {
    // ── 1. model: pin resolves correctly (no false cycle) ─────────────────
    console.log('1. model: pin resolves to concrete model (no false cycle)');
    {
      const stub = await stubBackend();
      const config = {
        endpoints: {
          stub: { url: `http://127.0.0.1:${stub.port}`, format: 'anthropic', auth: 'none' },
        },
        model_routes: {
          'deepseek-v4-pro:cloud': 'stub',
        },
        llm_profiles: {
          '128gb': {
            workhorse: { connected_model: 'deepseek-v4-pro:cloud', disconnect_model: 'deepseek-v4-pro:cloud' },
          },
        },
        agent_to_capability: {
          'my-agent': 'model:deepseek-v4-pro:cloud',
        },
      };

      const configPath = writeConfig(tmpDir, config);

      await withProxy(
        { configPath, profile: '128gb' },
        async ({ port }) => {
          const body = Object.assign({ model: 'my-agent' }, MSG_BODY);
          const res = await httpJson(port, 'POST', '/v1/messages', body);

          // Should succeed — no false cycle detection.
          assertEq(res.status, 200, 'model: pin request returns 200');

          const req = stub.lastRequest();
          assert(
            req && req.model_used === 'deepseek-v4-pro:cloud',
            `resolved to correct concrete model (got ${req && req.model_used})`
          );
        }
      );

      stub.close();
    }

    // ── 2. model: pin chain (agent → model:X → model_routes → backend) ──
    console.log('\n2. model: pin chain resolves through model_routes');
    {
      const stub = await stubBackend();
      const config = {
        endpoints: {
          stub: { url: `http://127.0.0.1:${stub.port}`, format: 'anthropic', auth: 'none' },
        },
        model_routes: {
          'deepseek-v4-pro:cloud': 'stub',
        },
        agent_to_capability: {
          'my-agent': 'model:deepseek-v4-pro:cloud',
        },
      };

      const configPath = writeConfig(tmpDir, config);

      await withProxy(
        { configPath, profile: '128gb' },
        async ({ port }) => {
          const body = Object.assign({ model: 'my-agent' }, MSG_BODY);
          const res = await httpJson(port, 'POST', '/v1/messages', body);
          assertEq(res.status, 200, 'model: pin bypasses llm_profiles, uses model_routes directly');
          const req = stub.lastRequest();
          assert(
            req && req.model_used === 'deepseek-v4-pro:cloud',
            `model: pin → model_routes → stub (got ${req && req.model_used})`
          );
        }
      );

      stub.close();
    }

    // ── 3. advisor:<model-id> sentinel routes through runtime model pin ───
    console.log('\n3. advisor:<model-id> sentinel routes through runtime model pin');
    {
      const stub = await stubBackend();
      const config = {
        endpoints: {
          stub: { url: `http://127.0.0.1:${stub.port}`, format: 'anthropic', auth: 'none' },
        },
        model_routes: {
          'deepseek-v4-pro:cloud': 'stub',
        },
        agent_to_capability: {},
      };

      const configPath = writeConfig(tmpDir, config);

      await withProxy(
        {
          configPath,
          profile: '128gb',
          env: { C_THRU_AGENT_SENTINEL_SECRET: SENTINEL_SECRET },
        },
        async ({ port }) => {
          const body = Object.assign(
            { model: 'sonnet' },
            MSG_BODY,
            {
              messages: [{
                role: 'user',
                content: `${formatAgentSentinel('advisor:deepseek-v4-pro:cloud', SENTINEL_SECRET)}\nhi`,
              }],
            }
          );
          const res = await httpJson(port, 'POST', '/v1/messages', body, {
            'x-claude-code-agent-id': 'advisor-agent-test-id',
          });
          assertEq(res.status, 200, 'advisor runtime pin request returns 200');
          const req = stub.lastRequest();
          assert(
            req && req.model_used === 'deepseek-v4-pro:cloud',
            `advisor runtime pin → deepseek-v4-pro:cloud (got ${req && req.model_used})`
          );
        }
      );

      stub.close();
    }

    // ── 4. Genuine cycle in agent_to_capability IS detected ──────────────
    //      agent-a → model:node-x, node-x → model:agent-a
    //      Both keys must be in agent_to_capability so the recursive
    //      resolveBackend call re-enters the model: pin path.
    console.log('\n4. Genuine cycle in agent_to_capability is detected');
    {
      const stub = await stubBackend();
      const config = {
        endpoints: {
          stub: { url: `http://127.0.0.1:${stub.port}`, format: 'anthropic', auth: 'none' },
        },
        model_routes: {
          'deepseek-v4-pro:cloud': 'stub',
        },
        agent_to_capability: {
          'agent-a': 'model:node-x',
          'node-x':  'model:agent-a',
        },
      };

      const configPath = writeConfig(tmpDir, config);

      await withProxy(
        { configPath, profile: '128gb' },
        async ({ port }) => {
          const body = Object.assign({ model: 'agent-a' }, MSG_BODY);
          const res = await httpJson(port, 'POST', '/v1/messages', body);

          assert(
            res.status === 400,
            `genuine cycle returns 400 (got ${res.status})`
          );
          if (res.json && res.json.error) {
            assert(
              res.json.error.message.toLowerCase().includes('cycle'),
              `error message mentions cycle: "${res.json.error.message}"`
            );
          }
        }
      );

      stub.close();
    }

    // ── 5. model: prefix with empty model name returns 400 ──────────────
    console.log('\n5. model: prefix with empty model name returns clean error');
    {
      const stub = await stubBackend();
      const config = {
        endpoints: {
          stub: { url: `http://127.0.0.1:${stub.port}`, format: 'anthropic', auth: 'none' },
        },
        agent_to_capability: {
          'bad-agent': 'model:',
        },
      };

      const configPath = writeConfig(tmpDir, config);

      await withProxy(
        { configPath, profile: '128gb' },
        async ({ port }) => {
          const body = Object.assign({ model: 'bad-agent' }, MSG_BODY);
          const res = await httpJson(port, 'POST', '/v1/messages', body);

          assert(
            res.status === 400,
            `empty model: pin returns 400 (got ${res.status})`
          );
        }
      );

      stub.close();
    }

    // ── 6. Multiple agents pinned to same model all resolve ─────────────
    console.log('\n6. Multiple independent model: pins all resolve correctly');
    {
      const stub = await stubBackend();
      const config = {
        endpoints: {
          stub: { url: `http://127.0.0.1:${stub.port}`, format: 'anthropic', auth: 'none' },
        },
        model_routes: {
          'deepseek-v4-pro:cloud': 'stub',
        },
        agent_to_capability: {
          'agent-1': 'model:deepseek-v4-pro:cloud',
          'agent-2': 'model:deepseek-v4-pro:cloud',
          'agent-3': 'model:deepseek-v4-pro:cloud',
        },
      };

      const configPath = writeConfig(tmpDir, config);

      await withProxy(
        { configPath, profile: '128gb' },
        async ({ port }) => {
          for (const agent of ['agent-1', 'agent-2', 'agent-3']) {
            const body = Object.assign({ model: agent }, MSG_BODY);
            const res = await httpJson(port, 'POST', '/v1/messages', body);
            assertEq(res.status, 200, `${agent} resolves (200)`);
            const req = stub.lastRequest();
            assert(
              req && req.model_used === 'deepseek-v4-pro:cloud',
              `${agent} → deepseek-v4-pro:cloud (got ${req && req.model_used})`
            );
          }
        }
      );

      stub.close();
    }

    // ── 7. model: pin in route chain resolves correctly ────────────────
    //      Tests the seen set is clean per top-level resolveBackend call.
    console.log('\n7. Seen set does not persist across independent resolutions');
    {
      const stub = await stubBackend();
      const config = {
        endpoints: {
          stub: { url: `http://127.0.0.1:${stub.port}`, format: 'anthropic', auth: 'none' },
        },
        model_routes: {
          'deepseek-v4-pro:cloud': 'stub',
        },
        agent_to_capability: {
          'agent-x': 'model:deepseek-v4-pro:cloud',
        },
      };

      const configPath = writeConfig(tmpDir, config);

      await withProxy(
        { configPath, profile: '128gb' },
        async ({ port }) => {
          // First request — fresh seen set
          const r1 = await httpJson(port, 'POST', '/v1/messages',
            Object.assign({ model: 'agent-x' }, MSG_BODY));
          assertEq(r1.status, 200, 'first request resolves');

          // Second identical request — must also resolve (seen set not shared)
          const r2 = await httpJson(port, 'POST', '/v1/messages',
            Object.assign({ model: 'agent-x' }, MSG_BODY));
          assertEq(r2.status, 200, 'second identical request also resolves (fresh seen set)');
        }
      );

      stub.close();
    }

    // ── 8. Trusted sentinel model pin wins a colliding model route ─────────
    console.log('\n8. Trusted sentinel model pin preserves agent role across route-key collision');
    {
      const pinStub = await stubBackend();
      const routeStub = await stubBackend();
      const config = {
        endpoints: {
          pin_stub: {
            url: `http://127.0.0.1:${pinStub.port}`,
            format: 'anthropic',
            auth: 'none',
          },
          route_stub: {
            url: `http://127.0.0.1:${routeStub.port}`,
            format: 'anthropic',
            auth: 'none',
          },
        },
        model_routes: {
          grok: { endpoint: 'route_stub', name: 'grok-route-alias' },
          'grok-4.5': 'pin_stub',
        },
        agent_to_capability: {
          grok: 'model:grok-4.5',
        },
      };

      const configPath = writeConfig(tmpDir, config);
      const logPath = path.join(tmpDir, 'model-pin-collision-proxy.log');
      const signedGrokBody = model => Object.assign(
        { model },
        MSG_BODY,
        {
          messages: [{
            role: 'user',
            content: `${formatAgentSentinel('grok', SENTINEL_SECRET)}\nhi`,
          }],
        }
      );

      await withProxy(
        {
          configPath,
          profile: '128gb',
          env: {
            C_THRU_AGENT_SENTINEL_SECRET: SENTINEL_SECRET,
            CLAUDE_PROXY_LOG_FILE: logPath,
          },
        },
        async ({ port }) => {
          const trusted = await httpJson(
            port,
            'POST',
            '/v1/messages',
            signedGrokBody('session-default'),
            { 'x-claude-code-agent-id': 'grok-agent-test-id' },
          );
          assertEq(trusted.status, 200, 'trusted grok sentinel request returns 200');
          assertEq(
            pinStub.lastRequest()?.model_used,
            'grok-4.5',
            'trusted sentinel follows grok model pin to concrete model/backend',
          );
          assertEq(
            routeStub.requests.length,
            0,
            'trusted sentinel does not take colliding plain model route',
          );
          let trustedVia = null;
          try {
            trustedVia = JSON.parse(trusted.headers['x-c-thru-resolved-via'] || 'null');
          } catch {}
          assertEq(
            trustedVia?.capability,
            'grok',
            'trusted sentinel preserves grok as logical role',
          );
          assertEq(
            trustedVia?.agent,
            'grok',
            'trusted sentinel keeps agent identity separate from logical role',
          );
          const dispatchMarker = 'c-thru [dispatch] ';
          const dispatchLine = fs.readFileSync(logPath, 'utf8')
            .split('\n')
            .find(line => line.includes(dispatchMarker));
          let trustedDispatch = null;
          try {
            trustedDispatch = JSON.parse(
              dispatchLine.slice(dispatchLine.indexOf(dispatchMarker) + dispatchMarker.length)
            );
          } catch {}
          assertEq(
            trustedDispatch?.incoming_model,
            'grok',
            'trusted dispatch keeps incoming model as named agent',
          );
          assertEq(
            trustedDispatch?.logical_role,
            'grok',
            'trusted dispatch logs named agent logical_role',
          );
          assertEq(
            trustedDispatch?.backend_id,
            'pin_stub',
            'trusted dispatch logs concrete pinned backend',
          );

          const untrusted = await httpJson(
            port,
            'POST',
            '/v1/messages',
            signedGrokBody('grok'),
          );
          assertEq(untrusted.status, 200, 'untrusted sentinel request keeps normal route behavior');
          assertEq(
            routeStub.lastRequest()?.model_used,
            'grok-route-alias',
            'untrusted sentinel still follows model_routes.grok alias',
          );
          assert(
            untrusted.headers['x-c-thru-resolved-via'] === undefined,
            'untrusted sentinel does not gain logical-role attribution',
          );

          const plain = await httpJson(
            port,
            'POST',
            '/v1/messages',
            Object.assign({ model: 'grok' }, MSG_BODY),
          );
          assertEq(plain.status, 200, 'plain grok model-route request returns 200');
          assertEq(
            routeStub.lastRequest()?.model_used,
            'grok-route-alias',
            'plain grok request still follows model_routes.grok alias',
          );
          assertEq(routeStub.requests.length, 2, 'only untrusted/plain requests use route alias');
          assertEq(pinStub.requests.length, 1, 'only trusted sentinel request uses model pin');
        }
      );

      pinStub.close();
      routeStub.close();
    }

    // ── 9. Trusted sentinel self-pin uses the same-name model route ─────────
    console.log('\n9. Trusted sentinel self-pin resolves without a false cycle');
    {
      const stub = await stubBackend();
      const config = {
        endpoints: {
          anthropic: {
            url: `http://127.0.0.1:${stub.port}`,
            format: 'anthropic',
            auth: 'none',
          },
        },
        model_routes: {
          'claude-sonnet-5': 'anthropic',
        },
        agent_to_capability: {
          'claude-sonnet-5': 'model:claude-sonnet-5',
        },
      };
      const configPath = writeConfig(tmpDir, config);

      await withProxy(
        {
          configPath,
          profile: '128gb',
          env: { C_THRU_AGENT_SENTINEL_SECRET: SENTINEL_SECRET },
        },
        async ({ port }) => {
          const body = Object.assign({}, MSG_BODY, {
            model: 'session-default',
            messages: [{
              role: 'user',
              content: `${formatAgentSentinel('claude-sonnet-5', SENTINEL_SECRET)}\nhi`,
            }],
          });
          const res = await httpJson(
            port,
            'POST',
            '/v1/messages',
            body,
            { 'x-claude-code-agent-id': 'self-pin-agent-test-id' },
          );
          assertEq(res.status, 200, 'trusted exact-name self-pin request returns 200');
          assertEq(
            res.headers['x-c-thru-served-by'],
            'claude-sonnet-5',
            'trusted exact-name self-pin reaches its concrete model route',
          );
          assertEq(stub.lastRequest()?.model_used, 'claude-sonnet-5',
            'trusted exact-name self-pin forwards the exact model ID');
        }
      );

      stub.close();
    }

    // ── 10. Trusted family self-pin uses its mode-conditional route ─────────
    console.log('\n10. Trusted family self-pin resolves its active-mode target');
    {
      const stub = await stubBackend();
      const config = {
        endpoints: {
          ollama_cloud: {
            url: `http://127.0.0.1:${stub.port}`,
            format: 'anthropic',
            auth: 'none',
          },
        },
        model_routes: {
          sonnet: {
            'best-cloud': 'claude-sonnet-5',
            'best-cloud-oss': 'kimi-k3:cloud',
          },
          'kimi-k3:cloud': 'ollama_cloud',
        },
        agent_to_capability: {
          sonnet: 'model:sonnet',
        },
        llm_mode: 'best-cloud-oss',
      };
      const configPath = writeConfig(tmpDir, config);

      await withProxy(
        {
          configPath,
          profile: '128gb',
          mode: 'best-cloud-oss',
          env: { C_THRU_AGENT_SENTINEL_SECRET: SENTINEL_SECRET },
        },
        async ({ port }) => {
          const body = Object.assign({}, MSG_BODY, {
            model: 'claude-sonnet-5',
            messages: [{
              role: 'user',
              content: `${formatAgentSentinel('sonnet', SENTINEL_SECRET)}\nhi`,
            }],
          });
          const res = await httpJson(
            port,
            'POST',
            '/v1/messages',
            body,
            { 'x-claude-code-agent-id': 'family-self-pin-test-id' },
          );
          assertEq(res.status, 200, 'trusted family self-pin request returns 200');
          assertEq(
            res.headers['x-c-thru-served-by'],
            'kimi-k3:cloud',
            'trusted family self-pin follows the active best-cloud-oss target',
          );
          assertEq(stub.lastRequest()?.model_used, 'kimi-k3:cloud',
            'trusted family self-pin forwards the active-mode model ID');
        }
      );

      stub.close();
    }

    return summary();
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

main().then(failed => process.exit(failed > 0 ? 1 : 0));
