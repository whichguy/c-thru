#!/usr/bin/env node
'use strict';
// Integration tests for target-backed terminal resolution.
// Run: node test/proxy-targets.test.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  stubBackend, writeConfig, httpJson, withProxy, spawnProxy, waitForPing,
} = require('./helpers');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    failed++;
  }
}

const MSG = { messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 };

function buildBaseConfig(stubPort, extras = {}) {
  return Object.assign({
    backends: {
      stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    llm_profiles: {
      '16gb': {
        workhorse: { connected_model: 'workhorse-leaf', disconnect_model: 'workhorse-leaf' },
        judge: { connected_model: 'workhorse-leaf', disconnect_model: 'workhorse-leaf' },
      },
    },
  }, extras);
}

async function main() {
  console.log('proxy-targets tests\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-targets-'));
  let stub;
  try {
    stub = await stubBackend();

    console.log('1. Explicit target resolves to configured backend/model + headers');
    {
      const configPath = writeConfig(tmpDir, buildBaseConfig(stub.port, {
        llm_profiles: {
          '16gb': {
            workhorse: { connected_model: 'glm5.1-zai', disconnect_model: 'glm5.1-zai' },
            judge: { connected_model: 'glm5.1-zai', disconnect_model: 'glm5.1-zai' },
          },
        },
        targets: {
          default: { backend: 'stub' },
          'glm5.1-zai': {
            backend: 'stub',
            model: 'glm-5.1',
            request_defaults: { reasoning_effort: 'low' },
          },
        },
      }));
      await withProxy({ configPath, profile: '16gb', env: { CLAUDE_LLM_MODE: 'connected' } }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', { ...MSG, model: 'workhorse' });
        assert(r.status === 200, `explicit target status 200 (got ${r.status})`);
        assert(stub.lastRequest()?.model_used === 'glm-5.1',
          `explicit target forwarded provider model glm-5.1 (got ${stub.lastRequest()?.model_used})`);
        assert(stub.lastRequest()?.body?.reasoning_effort === 'low',
          `explicit target forwarded request_defaults.reasoning_effort=low (got ${JSON.stringify(stub.lastRequest()?.body?.reasoning_effort)})`);
        const via = JSON.parse(r.headers['x-c-thru-resolved-via']);
        assert(via?.target_id === 'glm5.1-zai', `resolved_via.target_id=glm5.1-zai (got ${via?.target_id})`);
        assert(via?.backend_id === 'stub', `resolved_via.backend_id=stub (got ${via?.backend_id})`);
      });
    }

    console.log('\n2. Unmatched terminal uses targets.default and passes model through');
    {
      const configPath = writeConfig(tmpDir, buildBaseConfig(stub.port, {
        llm_profiles: {
          '16gb': {
            workhorse: { connected_model: 'raw-pass-through', disconnect_model: 'raw-pass-through' },
            judge: { connected_model: 'raw-pass-through', disconnect_model: 'raw-pass-through' },
          },
        },
        targets: {
          default: {
            backend: 'stub',
            request_defaults: { metadata: { source: 'default-target' } },
          },
        },
      }));
      await withProxy({ configPath, profile: '16gb', env: { CLAUDE_LLM_MODE: 'connected' } }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', { ...MSG, model: 'workhorse' });
        assert(r.status === 200, `default target status 200 (got ${r.status})`);
        assert(stub.lastRequest()?.model_used === 'raw-pass-through',
          `default target forwarded raw model label (got ${stub.lastRequest()?.model_used})`);
        assert(stub.lastRequest()?.body?.metadata?.source === 'default-target',
          `default target forwarded default request_defaults (got ${JSON.stringify(stub.lastRequest()?.body?.metadata)})`);
        const via = JSON.parse(r.headers['x-c-thru-resolved-via']);
        assert(via?.target_id === 'default', `resolved_via.target_id=default (got ${via?.target_id})`);
      });
    }

    console.log('\n3. Env-backed request_defaults coerce and merge');
    {
      const configPath = writeConfig(tmpDir, buildBaseConfig(stub.port, {
        llm_profiles: {
          '16gb': {
            workhorse: { connected_model: 'env-target', disconnect_model: 'env-target' },
            judge: { connected_model: 'env-target', disconnect_model: 'env-target' },
          },
        },
        targets: {
          default: { backend: 'stub' },
          'env-target': {
            backend: 'stub',
            model: 'env-model',
            request_defaults: {
              think: { '$env': 'TEST_TARGET_THINK', default: false },
              options: {
                num_predict: { '$env': 'TEST_TARGET_NUM_PREDICT', default: 128 },
                keep_other: 7,
              },
            },
          },
        },
      }));
      await withProxy({
        configPath,
        profile: '16gb',
        env: {
          CLAUDE_LLM_MODE: 'connected',
          TEST_TARGET_THINK: 'true',
          TEST_TARGET_NUM_PREDICT: '512',
        },
      }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          ...MSG,
          model: 'workhorse',
          options: { keep_client: 99 },
        });
        assert(r.status === 200, `env target status 200 (got ${r.status})`);
        assert(stub.lastRequest()?.body?.think === true,
          `env boolean coerced to true (got ${JSON.stringify(stub.lastRequest()?.body?.think)})`);
        assert(stub.lastRequest()?.body?.options?.num_predict === 512,
          `env number coerced to 512 (got ${JSON.stringify(stub.lastRequest()?.body?.options?.num_predict)})`);
        assert(stub.lastRequest()?.body?.options?.keep_other === 7,
          `default nested option preserved (got ${JSON.stringify(stub.lastRequest()?.body?.options?.keep_other)})`);
        assert(stub.lastRequest()?.body?.options?.keep_client === 99,
          `client nested option preserved (got ${JSON.stringify(stub.lastRequest()?.body?.options?.keep_client)})`);
      });
    }

    console.log('\n4. JS-backed request_defaults work only from trusted profile config');
    {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-home-js-'));
      const profileDir = path.join(tmpHome, '.claude');
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, 'model-map.json'), JSON.stringify(buildBaseConfig(stub.port, {
        llm_profiles: {
          '16gb': {
            workhorse: { connected_model: 'js-target', disconnect_model: 'js-target' },
            judge: { connected_model: 'js-target', disconnect_model: 'js-target' },
          },
        },
        targets: {
          default: { backend: 'stub' },
          'js-target': {
            backend: 'stub',
            model: 'js-model',
            request_defaults: {
              options: {
                num_predict: {
                  '$js': '(ctx) => ctx.request.headers[\"x-num-predict\"] ? Number(ctx.request.headers[\"x-num-predict\"]) : ((ctx.request.body.max_tokens || 0) + 1)',
                },
              },
            },
          },
        },
      })));
      let child = null;
      try {
        const started = await spawnProxy({
          profile: '16gb',
          tmpHome,
          cwd: tmpHome,
          env: { CLAUDE_LLM_MODE: 'connected', C_THRU_ENABLE_TARGET_JS: '1' },
        });
        child = started.child;
        await waitForPing(started.port);
        const r = await httpJson(started.port, 'POST', '/v1/messages', { ...MSG, model: 'workhorse' }, { 'x-num-predict': '777' });
        assert(r.status === 200, `trusted JS target status 200 (got ${r.status})`);
        assert(stub.lastRequest()?.body?.options?.num_predict === 777,
          `JS wrapper used request headers/body to compute 777 (got ${JSON.stringify(stub.lastRequest()?.body?.options?.num_predict)})`);
      } finally {
        try { if (child) child.kill('SIGTERM'); } catch {}
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
      }
    }

    console.log('\n5. JS-backed request_defaults exceptions return clean 500 and restore in-flight stats');
    {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-home-js-err-'));
      const profileDir = path.join(tmpHome, '.claude');
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, 'model-map.json'), JSON.stringify(buildBaseConfig(stub.port, {
        llm_profiles: {
          '16gb': {
            workhorse: { connected_model: 'js-target', disconnect_model: 'js-target' },
            judge: { connected_model: 'js-target', disconnect_model: 'js-target' },
          },
        },
        targets: {
          default: { backend: 'stub' },
          'js-target': {
            backend: 'stub',
            model: 'js-model',
            request_defaults: {
              options: {
                num_predict: {
                  '$js': '(ctx) => { throw new Error(\"boom from target js\") }',
                },
              },
            },
          },
        },
      })));
      let child = null;
      try {
        const started = await spawnProxy({
          profile: '16gb',
          tmpHome,
          cwd: tmpHome,
          env: { CLAUDE_LLM_MODE: 'connected', C_THRU_ENABLE_TARGET_JS: '1' },
        });
        child = started.child;
        await waitForPing(started.port);
        const r = await httpJson(started.port, 'POST', '/v1/messages', { ...MSG, model: 'workhorse' });
        assert(r.status === 500, `target JS exception returns 500 (got ${r.status})`);
        assert(JSON.stringify(r.json || {}).includes('boom from target js'),
          `target JS exception message surfaced (got ${JSON.stringify(r.json)})`);
        const stats = await httpJson(started.port, 'GET', '/debug/stats');
        assert(stats.json?.currentInFlight === 0,
          `currentInFlight restored to 0 after request-default failure (got ${JSON.stringify(stats.json?.currentInFlight)})`);
      } finally {
        try { if (child) child.kill('SIGTERM'); } catch {}
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
      }
    }

    console.log('\n6. JS-backed request_defaults are rejected for project/override config');
    {
      const jsConfigPath = writeConfig(tmpDir, buildBaseConfig(stub.port, {
        llm_profiles: {
          '16gb': {
            workhorse: { connected_model: 'js-target', disconnect_model: 'js-target' },
            judge: { connected_model: 'js-target', disconnect_model: 'js-target' },
          },
        },
        targets: {
          default: { backend: 'stub' },
          'js-target': {
            backend: 'stub',
            model: 'js-model',
            request_defaults: {
              options: { num_predict: { '$js': '(ctx) => 12' } },
            },
          },
        },
      }));
      let rejected = false;
      try {
        await spawnProxy({
          configPath: jsConfigPath,
          profile: '16gb',
          env: { CLAUDE_LLM_MODE: 'connected', C_THRU_ENABLE_TARGET_JS: '1' },
        });
      } catch (error) {
        rejected = true;
        assert(/before emitting READY|invalid model-map/i.test(String(error.message)),
          `project JS config rejected before startup (got ${error.message})`);
      }
      assert(rejected, 'project JS config is rejected');
    }
  } finally {
    if (stub) await stub.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
