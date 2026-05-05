#!/usr/bin/env node
'use strict';
// End-to-end model resolution matrix: tiers × modes × capability aliases.
// Spawns a real proxy + stub backend; asserts the concrete model that hits
// the wire (stub.lastRequest().model_used) matches what pure-function tests predict.
//
// Coverage:
//   - All 5 hw tiers (16gb/32gb/48gb/64gb/128gb) × connected + offline
//   - modes[] sub-map: semi-offload + cloud-judge-only via judge profile
//   - agent_to_capability chain: "test-agent" → workhorse → concrete model
//
// Run with: node test/proxy-resolution-matrix.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, summary,
  stubBackend, writeConfig,
  httpJson, withProxy,
} = require('./helpers');

console.log('proxy-resolution-matrix integration tests\n');

// ── Fixture helpers ────────────────────────────────────────────────────────

// Build a capability profile entry in the new [cap][mode][tier] schema.
// Model names encode cap+tier+mode-suffix for unambiguous assertion.
function profileEntry(cap, stubSuffix) {
  return {
    'best-cloud':     Object.fromEntries(TIERS.map(t => [t, `${cap}-${t}-conn@${stubSuffix}`])),
    'best-local-oss': Object.fromEntries(TIERS.map(t => [t, `${cap}-${t}-disc@${stubSuffix}`])),
    'best-cloud-oss': Object.fromEntries(TIERS.map(t => [t, `${cap}-${t}-oss@${stubSuffix}`])),
    'best-cloud-gov': Object.fromEntries(TIERS.map(t => [t, `${cap}-${t}-gov@${stubSuffix}`])),
    'best-local-gov': Object.fromEntries(TIERS.map(t => [t, `${cap}-${t}-lgov@${stubSuffix}`])),
  };
}

const TIERS       = ['16gb', '32gb', '48gb', '64gb', '128gb'];
const CAPABILITIES = ['workhorse', 'judge', 'deep-coder'];

// Build the full fixture config given a running stub port.
function buildFixtureConfig(stubPort) {
  const stubSuffix = 'stub';
  const llm_profiles = {};
  for (const cap of CAPABILITIES) {
    llm_profiles[cap] = profileEntry(cap, stubSuffix);
  }
  return {
    backends: {
      stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    llm_profiles,
    agent_to_capability: {
      'test-agent': 'workhorse',
    },
  };
}

// Minimal Anthropic-format request body (non-streaming).
const MSG_BODY = {
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 1,
};

// ── Test runner ────────────────────────────────────────────────────────────

async function runMatrix(stub, configPath) {
  // ── 1. Tier × mode matrix (workhorse, judge, deep-coder) ───────────────
  console.log('1. Tier × mode matrix');
  for (const tier of TIERS) {
    for (const [mode, suffix] of [['best-cloud', 'conn'], ['best-local-oss', 'disc'], ['best-cloud-oss', 'oss']]) {
      await withProxy(
        { configPath, profile: tier, env: { CLAUDE_LLM_MODE: mode } },
        async ({ port }) => {
          for (const cap of CAPABILITIES) {
            const body = Object.assign({ model: cap }, MSG_BODY);
            await httpJson(port, 'POST', '/v1/messages', body);
            const req = stub.lastRequest();
            const expected = `${cap}-${tier}-${suffix}`;
            assert(
              req && req.model_used === expected,
              `tier=${tier} mode=${mode} cap=${cap} → model_used=${expected} (got ${req && req.model_used})`
            );
            assert(
              req && req.serving_url && req.serving_url.includes('/v1/messages'),
              `serving_url contains /v1/messages for ${cap}@${tier}/${mode}`
            );
          }
        }
      );
    }
  }

  // ── 2. agent_to_capability chain ────────────────────────────────────────
  console.log('\n2. agent_to_capability chain (test-agent → workhorse)');
  await withProxy(
    { configPath, profile: '64gb', env: { CLAUDE_LLM_MODE: 'best-cloud' } },
    async ({ port }) => {
      const body = Object.assign({ model: 'test-agent' }, MSG_BODY);
      await httpJson(port, 'POST', '/v1/messages', body);
      const req = stub.lastRequest();
      const expected = 'workhorse-64gb-conn';
      assert(
        req && req.model_used === expected,
        `agent=test-agent → workhorse → model_used=${expected} (got ${req && req.model_used})`
      );
      assert(
        req && req.serving_url.startsWith('http://127.0.0.1:'),
        `agent chain request reached stub at ${req && req.serving_url}`
      );
    }
  );

  // ── 3. x-c-thru-resolved-via header includes mode and local_terminal_appended ─
  console.log('\n3. x-c-thru-resolved-via header includes mode + local_terminal_appended');
  await withProxy(
    { configPath, profile: '64gb', env: { CLAUDE_LLM_MODE: 'best-cloud' } },
    async ({ port }) => {
      const body = Object.assign({ model: 'workhorse' }, MSG_BODY);
      const resp = await httpJson(port, 'POST', '/v1/messages', body);
      const headerStr = resp.headers && resp.headers['x-c-thru-resolved-via'];
      if (headerStr) {
        let parsed;
        try { parsed = JSON.parse(headerStr); } catch {}
        assert(parsed && parsed.mode === 'best-cloud',
          `x-c-thru-resolved-via.mode is 'best-cloud' (got ${parsed && parsed.mode})`);
        assert(parsed && 'local_terminal_appended' in parsed,
          `x-c-thru-resolved-via includes local_terminal_appended key`);
      } else {
        assert(false, 'x-c-thru-resolved-via header present on capability request');
      }
    }
  );
}

// ── Stub that returns error for any model in badModels set, 200 otherwise ─
function multiModelSelectiveStub(badModels, errorCode) {
  const http = require('http');
  const badSet = new Set(badModels);
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const modelUsed = body ? body.model : null;
      requests.push({ model_used: modelUsed });
      if (badSet.has(modelUsed)) {
        const errBody = JSON.stringify({ error: { type: 'rate_limit_error', message: 'error' } });
        res.writeHead(errorCode, { 'Content-Type': 'application/json' });
        res.end(errBody);
      } else {
        const successBody = JSON.stringify({
          id: 'msg_stub', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: modelUsed,
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(successBody);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, requests, close: () => new Promise(r => server.close(r)) });
    });
    server.on('error', reject);
  });
}

// ── Stub that returns 429 for 'bad-model', 200 for everything else ────────
// Both primary and fallback route to the same backend; the stub dispatches
// by model name so the cooldown key is the plain resolved model name.
function modelSelectiveStub(badModel, errorCode) {
  const http = require('http');
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const modelUsed = body ? body.model : null;
      requests.push({ model_used: modelUsed });
      if (modelUsed === badModel) {
        const errBody = JSON.stringify({ error: { type: 'rate_limit_error', message: 'rate limited' } });
        res.writeHead(errorCode, { 'Content-Type': 'application/json' });
        res.end(errBody);
      } else {
        const successBody = JSON.stringify({
          id: 'msg_stub', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: modelUsed,
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(successBody);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server, port, requests,
        lastRequest: () => requests[requests.length - 1] || null,
        close: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-matrix-'));
  let stub;
  let errorStub;

  try {
    stub = await stubBackend();
    const config = buildFixtureConfig(stub.port);
    const configPath = writeConfig(tmpDir, config);

    await runMatrix(stub, configPath);

    // ── 7. Active-path fallback: fallback_chains consulted on in-flight 429 ─
    // Both primary and fallback route to the SAME smart backend that returns 429
    // for 'wh-primary' and 200 for 'wh-fallback'. Cooldown key = plain model name.
    console.log('\n7. Active-path fallback: fallback_chains consulted on in-flight 429');
    errorStub = await modelSelectiveStub('wh-primary', 429);
    const fallbackConfig = {
      backends: {
        smart: { kind: 'anthropic', url: `http://127.0.0.1:${errorStub.port}` },
      },
      model_routes: {
        'wh-primary': 'smart',
        'wh-fallback': 'smart',
      },
      llm_profiles: {
        workhorse: {
          'best-cloud':     { '64gb': 'wh-primary'  },
          'best-local-oss': { '64gb': 'wh-fallback' },
        },
      },
      fallback_chains: {
        '64gb': {
          workhorse: [
            { model: 'wh-primary',  quality_score: 80, speed_score: 60 },
            { model: 'wh-fallback', quality_score: 70, speed_score: 90 },
          ],
        },
      },
    };
    const fallbackConfigPath = writeConfig(tmpDir, fallbackConfig);
    await withProxy(
      { configPath: fallbackConfigPath, profile: '64gb', env: { CLAUDE_LLM_MODE: 'best-cloud' } },
      async ({ port }) => {
        const body = Object.assign({ model: 'workhorse' }, MSG_BODY);
        const resp = await httpJson(port, 'POST', '/v1/messages', body, {}, 5000);
        assert(
          resp.status === 200,
          `active-path 429 on wh-primary → fallback_chains → 200 (got status=${resp.status})`
        );
        assert(
          errorStub.requests.length >= 2,
          `two backend calls made (primary attempted then fallback, got ${errorStub.requests.length})`
        );
        assert(
          errorStub.requests[0] && errorStub.requests[0].model_used === 'wh-primary',
          `first call was wh-primary (got ${errorStub.requests[0] && errorStub.requests[0].model_used})`
        );
        assert(
          errorStub.requests[errorStub.requests.length - 1].model_used === 'wh-fallback',
          `last call was wh-fallback (got ${errorStub.requests[errorStub.requests.length - 1].model_used})`
        );
      }
    );
    // ── 8. Active-path local-terminal guard: appended terminal fires ──────
    // Chain ends on a non-local (kind:anthropic) model; guard appends disconnect_model
    // (kind:ollama) as terminal. Both non-local candidates return 429; local terminal
    // returns 200. Assert local_terminal_appended:true in x-c-thru-resolved-via.
    console.log('\n8. Active-path local-terminal guard: appended local terminal fires');
    let localTerminalStub;
    try {
      localTerminalStub = await multiModelSelectiveStub(['wh-cloud-primary', 'wh-cloud-secondary'], 429);
      const ltConfig = {
        backends: {
          cloud: { kind: 'anthropic', url: `http://127.0.0.1:${localTerminalStub.port}` },
          // kind:ollama + localhost → modelIsLocal returns true; same port for test simplicity
          local: { kind: 'ollama', url: `http://127.0.0.1:${localTerminalStub.port}` },
        },
        model_routes: {
          'wh-cloud-primary':   'cloud',
          'wh-cloud-secondary': 'cloud',
          'wh-local-terminal':  'local',
        },
        llm_profiles: {
          workhorse: {
            'best-cloud':     { '64gb': 'wh-cloud-primary'   },
            'best-local-oss': { '64gb': 'wh-local-terminal'  },
          },
        },
        fallback_chains: {
          '64gb': {
            workhorse: [
              { model: 'wh-cloud-primary',   quality_score: 80, speed_score: 60 },
              { model: 'wh-cloud-secondary', quality_score: 75, speed_score: 70 },
              // last entry is cloud → non-local → guard fires, appends wh-local-terminal
            ],
          },
        },
      };
      const ltConfigPath = writeConfig(tmpDir, ltConfig);
      await withProxy(
        { configPath: ltConfigPath, profile: '64gb', env: { CLAUDE_LLM_MODE: 'best-cloud' } },
        async ({ port }) => {
          const body = Object.assign({ model: 'workhorse' }, MSG_BODY);
          const resp = await httpJson(port, 'POST', '/v1/messages', body, {}, 6000);
          assert(resp.status === 200,
            `local-terminal guard → 200 after cloud fallbacks exhausted (got ${resp.status})`);
          // Verify local terminal was used (should be last request)
          const reqs = localTerminalStub.requests;
          assert(reqs.length >= 2, `≥2 backend calls: primary + fallback(s) (got ${reqs.length})`);
          assert(reqs[reqs.length - 1].model_used === 'wh-local-terminal',
            `last call served by wh-local-terminal (got ${reqs[reqs.length - 1].model_used})`);
          // local_terminal_appended:true in resolved-via header
          const headerStr = resp.headers && resp.headers['x-claude-proxy-fallback-from'];
          assert(typeof headerStr === 'string' && headerStr.length > 0,
            `x-claude-proxy-fallback-from header present (got ${headerStr})`);
        }
      );
    } finally {
      if (localTerminalStub) await localTerminalStub.close().catch(() => {});
    }
    // ── 9. Active-path fallback chain ordering ────────────────────────────
    // Chain order is preserved when primary fails: B comes before C since
    // chain is [A, B, C, D] and A fails → next is B in declaration order.
    console.log('\n9. Active-path fallback: chain walked in declaration order when primary fails');
    let tiebreakerStub;
    try {
      tiebreakerStub = await multiModelSelectiveStub(['tb-primary'], 429);
      const tbConfig = {
        backends: { tb: { kind: 'anthropic', url: `http://127.0.0.1:${tiebreakerStub.port}` } },
        model_routes: {
          'tb-primary': 'tb', 'tb-B': 'tb', 'tb-C': 'tb', 'tb-D': 'tb',
        },
        llm_profiles: {
          workhorse: {
            'best-cloud':     { '64gb': 'tb-primary' },
            'best-local-oss': { '64gb': 'tb-D'       },
          },
        },
        fallback_chains: {
          '64gb': {
            workhorse: [
              { model: 'tb-primary', quality_score: 90, speed_score: 20 },
              { model: 'tb-B',       quality_score: 87, speed_score: 30 },
              { model: 'tb-C',       quality_score: 86, speed_score: 99 },
              { model: 'tb-D',       quality_score: 60, speed_score: 50 },
            ],
          },
        },
      };
      const tbConfigPath = writeConfig(tmpDir, tbConfig);
      await withProxy(
        { configPath: tbConfigPath, profile: '64gb', env: { CLAUDE_LLM_MODE: 'best-cloud' } },
        async ({ port }) => {
          const body = Object.assign({ model: 'workhorse' }, MSG_BODY);
          const resp = await httpJson(port, 'POST', '/v1/messages', body, {}, 5000);
          assert(resp.status === 200,
            `chain ordering test: request succeeds after primary fails (got status=${resp.status})`);
          // Without speed-sort tiebreaker (best-cloud mode), chain is walked in raw declaration order.
          // A fails → first fallback is B (second entry in chain).
          const reqs = tiebreakerStub.requests;
          assert(reqs.length >= 2, `≥2 calls: primary + fallback (got ${reqs.length})`);
          assert(reqs[0] && reqs[0].model_used === 'tb-primary',
            `first call was tb-primary (got ${reqs[0] && reqs[0].model_used})`);
          assert(reqs[1] && reqs[1].model_used === 'tb-B',
            `second call was tb-B (declaration order, no tiebreaker; got ${reqs[1] && reqs[1].model_used})`);
        }
      );
    } finally {
      if (tiebreakerStub) await tiebreakerStub.close().catch(() => {});
    }
    // ── 10. Pre-flight + active: single-entry chain (degenerate) uses local terminal ─
    // Chain has only the primary model. After filter the set is empty.
    // Both pre-flight (resolveFallbackModel) and active (buildFallbackCandidatesFromChain)
    // must still append disconnect_model as local terminal and serve the request.
    console.log('\n10. Degenerate single-entry chain: local terminal appended when filtered set is empty');
    let singleEntryStub;
    try {
      singleEntryStub = await modelSelectiveStub('se-primary', 429);
      const seConfig = {
        backends: {
          cloud: { kind: 'anthropic', url: `http://127.0.0.1:${singleEntryStub.port}` },
          local: { kind: 'ollama',    url: `http://127.0.0.1:${singleEntryStub.port}` },
        },
        model_routes: { 'se-primary': 'cloud', 'se-local': 'local' },
        llm_profiles: {
          workhorse: {
            'best-cloud':     { '64gb': 'se-primary' },
            'best-local-oss': { '64gb': 'se-local'   },
          },
        },
        fallback_chains: {
          '64gb': {
            // Degenerate: only the primary is in the chain
            workhorse: [{ model: 'se-primary', quality_score: 80, speed_score: 60 }],
          },
        },
      };
      const seConfigPath = writeConfig(tmpDir, seConfig);
      await withProxy(
        { configPath: seConfigPath, profile: '64gb', env: { CLAUDE_LLM_MODE: 'best-cloud' } },
        async ({ port }) => {
          const body = Object.assign({ model: 'workhorse' }, MSG_BODY);
          const resp = await httpJson(port, 'POST', '/v1/messages', body, {}, 5000);
          assert(resp.status === 200,
            `single-entry chain → local terminal → 200 (got status=${resp.status})`);
          const reqs = singleEntryStub.requests;
          assert(reqs.length >= 2,
            `≥2 calls: primary (429) then local terminal (200) (got ${reqs.length})`);
          assert(reqs[0].model_used === 'se-primary',
            `first call was se-primary (got ${reqs[0].model_used})`);
          assert(reqs[reqs.length - 1].model_used === 'se-local',
            `last call was se-local (local terminal) (got ${reqs[reqs.length - 1].model_used})`);
        }
      );
    } finally {
      if (singleEntryStub) await singleEntryStub.close().catch(() => {});
    }
  } finally {
    if (stub) await stub.close().catch(() => {});
    if (errorStub) await errorStub.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
