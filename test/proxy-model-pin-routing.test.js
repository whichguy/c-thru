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

console.log('proxy-model-pin-routing integration tests\n');

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

    // ── 3. Genuine cycle in agent_to_capability IS detected ──────────────
    //      agent-a → model:node-x, node-x → model:agent-a
    //      Both keys must be in agent_to_capability so the recursive
    //      resolveBackend call re-enters the model: pin path.
    console.log('\n3. Genuine cycle in agent_to_capability is detected');
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

    // ── 4. model: prefix with empty model name returns 400 ──────────────
    console.log('\n4. model: prefix with empty model name returns clean error');
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

    // ── 5. Multiple agents pinned to same model all resolve ─────────────
    console.log('\n5. Multiple independent model: pins all resolve correctly');
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

    // ── 6. model: pin in route chain resolves correctly ────────────────
    //      Tests the seen set is clean per top-level resolveBackend call.
    console.log('\n6. Seen set does not persist across independent resolutions');
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

    return summary();
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

main().then(failed => process.exit(failed > 0 ? 1 : 0));
