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

// Build a tier profile entry. Model names encode tier+capability+mode for
// unambiguous assertion: e.g. "wh-64gb-conn@stub".
function profileEntry(cap, tier, stubSuffix) {
  const base = `${cap}-${tier}`;
  const entry = {
    connected_model:  `${base}-conn@${stubSuffix}`,
    disconnect_model: `${base}-disc@${stubSuffix}`,
  };
  // judge gets explicit modes[] entries so semi-offload and cloud-judge-only
  // select different models than connected/offline.
  if (cap === 'judge') {
    entry.modes = {
      'semi-offload':      `${base}-semi@${stubSuffix}`,
      'cloud-judge-only':  `${base}-cjo@${stubSuffix}`,
    };
  }
  return entry;
}

const TIERS       = ['16gb', '32gb', '48gb', '64gb', '128gb'];
const CAPABILITIES = ['workhorse', 'judge', 'deep-coder'];

// Build the full fixture config given a running stub port.
function buildFixtureConfig(stubPort) {
  const stubSuffix = 'stub';
  const llm_profiles = {};
  for (const tier of TIERS) {
    llm_profiles[tier] = {};
    for (const cap of CAPABILITIES) {
      const entry = profileEntry(cap, tier, stubSuffix);
      // Add best-quality convenience fields on the 64gb tier for new-mode tests
      if (tier === '64gb') {
        entry.cloud_best_model = `${cap}-${tier}-cloud-best@${stubSuffix}`;
        entry.local_best_model = `${cap}-${tier}-local-best@${stubSuffix}`;
      }
      llm_profiles[tier][cap] = entry;
    }
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
    for (const [mode, suffix] of [['connected', 'conn'], ['offline', 'disc']]) {
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

  // ── 2. modes[] sub-map: semi-offload and cloud-judge-only ──────────────
  console.log('\n2. modes[] sub-map (64gb × semi-offload + cloud-judge-only)');
  for (const [mode, suffix] of [['semi-offload', 'semi'], ['cloud-judge-only', 'cjo']]) {
    await withProxy(
      { configPath, profile: '64gb', env: { CLAUDE_LLM_MODE: mode } },
      async ({ port }) => {
        const body = Object.assign({ model: 'judge' }, MSG_BODY);
        await httpJson(port, 'POST', '/v1/messages', body);
        const req = stub.lastRequest();
        const expected = `judge-64gb-${suffix}`;
        assert(
          req && req.model_used === expected,
          `tier=64gb mode=${mode} cap=judge → model_used=${expected} (got ${req && req.model_used})`
        );
      }
    );
  }

  // ── 3. agent_to_capability chain ────────────────────────────────────────
  console.log('\n3. agent_to_capability chain (test-agent → workhorse)');
  await withProxy(
    { configPath, profile: '64gb', env: { CLAUDE_LLM_MODE: 'connected' } },
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

  // ── 4. cloud-best-quality: uses cloud_best_model ─────────────────────
  console.log('\n4. cloud-best-quality uses cloud_best_model field');
  await withProxy(
    { configPath, profile: '64gb', env: { CLAUDE_LLM_MODE: 'cloud-best-quality' } },
    async ({ port }) => {
      for (const cap of CAPABILITIES) {
        const body = Object.assign({ model: cap }, MSG_BODY);
        await httpJson(port, 'POST', '/v1/messages', body);
        const req = stub.lastRequest();
        const expected = `${cap}-64gb-cloud-best`;
        assert(
          req && req.model_used === expected,
          `cloud-best-quality cap=${cap} → model_used=${expected} (got ${req && req.model_used})`
        );
      }
    }
  );

  // ── 5. local-best-quality: uses local_best_model ─────────────────────
  console.log('\n5. local-best-quality uses local_best_model field');
  await withProxy(
    { configPath, profile: '64gb', env: { CLAUDE_LLM_MODE: 'local-best-quality' } },
    async ({ port }) => {
      for (const cap of CAPABILITIES) {
        const body = Object.assign({ model: cap }, MSG_BODY);
        await httpJson(port, 'POST', '/v1/messages', body);
        const req = stub.lastRequest();
        const expected = `${cap}-64gb-local-best`;
        assert(
          req && req.model_used === expected,
          `local-best-quality cap=${cap} → model_used=${expected} (got ${req && req.model_used})`
        );
      }
    }
  );

  // ── 6. x-c-thru-resolved-via header includes mode and local_terminal_appended ─
  console.log('\n6. x-c-thru-resolved-via header includes mode + local_terminal_appended');
  await withProxy(
    { configPath, profile: '64gb', env: { CLAUDE_LLM_MODE: 'cloud-best-quality' } },
    async ({ port }) => {
      const body = Object.assign({ model: 'workhorse' }, MSG_BODY);
      const resp = await httpJson(port, 'POST', '/v1/messages', body);
      const headerStr = resp.headers && resp.headers['x-c-thru-resolved-via'];
      if (headerStr) {
        let parsed;
        try { parsed = JSON.parse(headerStr); } catch {}
        assert(parsed && parsed.mode === 'cloud-best-quality',
          `x-c-thru-resolved-via.mode is 'cloud-best-quality' (got ${parsed && parsed.mode})`);
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
        '64gb': {
          workhorse: {
            connected_model: 'wh-primary',
            disconnect_model: 'wh-fallback',
          },
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
      { configPath: fallbackConfigPath, profile: '64gb', env: { CLAUDE_LLM_MODE: 'connected' } },
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
          '64gb': {
            workhorse: {
              connected_model:  'wh-cloud-primary',
              disconnect_model: 'wh-local-terminal',  // guard appends this
            },
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
        { configPath: ltConfigPath, profile: '64gb', env: { CLAUDE_LLM_MODE: 'connected' } },
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
    // ── 9. Active-path tiebreaker: speed-sort within quality band ────────
    // Chain (raw config order): [A(q=90,s=20), B(q=87,s=95), C(q=60,s=99)]
    // terminatedModel = A (fails with 429).
    // Without tiebreaker: filtered=[B,C], walk order B→C.
    // With tiebreaker (5% tolerance): threshold=87*0.95=82.65; in-band: B(87). Out: C(60).
    // Wait — B is first in filtered so topScore=87, threshold=82.65. In-band: B(87). Out: C(60).
    // Only one in-band so sort is no-op → result [B, C]. Same as raw.
    // Need a case where in-band has ≥2 entries with different speeds.
    // Chain: [A(q=90,s=20), B(q=87,s=30), C(q=86,s=99), D(q=60,s=50)]
    // filtered=[B(87,30), C(86,99), D(60,50)]. topScore=87. threshold=87*0.95=82.65.
    // In-band: B(87), C(86). Out: D(60). Speed-sort in-band: C(99)>B(30) → [C,B].
    // Result: [C, B, D]. Raw order would be [B, C, D].
    // So tiebreaker promotes C (lower quality but MUCH faster) above B.
    // Test: A fails → first call is C (not B). If tiebreaker missing: first call is B.
    console.log('\n9. Active-path tiebreaker: speed-sort within quality band promotes faster candidate');
    let tiebreakerStub;
    try {
      tiebreakerStub = await multiModelSelectiveStub(['tb-primary'], 429);
      const tbConfig = {
        backends: { tb: { kind: 'anthropic', url: `http://127.0.0.1:${tiebreakerStub.port}` } },
        model_routes: {
          'tb-primary': 'tb', 'tb-B': 'tb', 'tb-C': 'tb', 'tb-D': 'tb',
        },
        llm_profiles: {
          '64gb': {
            workhorse: { connected_model: 'tb-primary', disconnect_model: 'tb-D' },
          },
        },
        quality_tolerance_pct: 5,
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
        { configPath: tbConfigPath, profile: '64gb', env: { CLAUDE_LLM_MODE: 'cloud-best-quality' } },
        async ({ port }) => {
          const body = Object.assign({ model: 'workhorse' }, MSG_BODY);
          const resp = await httpJson(port, 'POST', '/v1/messages', body, {}, 5000);
          assert(resp.status === 200,
            `tiebreaker test: request succeeds after primary fails (got status=${resp.status})`);
          // With tiebreaker: B(q=87,s=30) and C(q=86,s=99) are in-band (threshold=87*0.95=82.65).
          // Speed sort promotes C before B → first fallback is C.
          // Without tiebreaker: raw order B then C → first fallback is B.
          const reqs = tiebreakerStub.requests;
          assert(reqs.length >= 2, `≥2 calls: primary + fallback (got ${reqs.length})`);
          assert(reqs[0] && reqs[0].model_used === 'tb-primary',
            `first call was tb-primary (got ${reqs[0] && reqs[0].model_used})`);
          assert(reqs[1] && reqs[1].model_used === 'tb-C',
            `second call was tb-C (speed-promoted over tb-B by tiebreaker; got ${reqs[1] && reqs[1].model_used})`);
        }
      );
    } finally {
      if (tiebreakerStub) await tiebreakerStub.close().catch(() => {});
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
