#!/usr/bin/env node
'use strict';
// Judge canary — opt-in lightweight cloud validation.
// Runs ONE judge call against the real Anthropic API to confirm:
//   1. The judge prompt + response framing works end-to-end with a real model
//   2. The proxy routes correctly to the cloud backend in connected mode
//   3. The judge VERDICT format is parseable
//
// This is a single check that signals "the Anthropic judge path itself is
// healthy"; role-specific behavioral coverage lives in the agent contract
// suite and is independently fail-closed on multiple evidence signals.
//
// Guard: ANTHROPIC_API_KEY required. Skips gracefully without it.
// Run:   ANTHROPIC_API_KEY=... node test/judge-canary.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert,
  ensureModelTestSupervisor,
  summary,
  writeConfig,
  withModelTestProxy,
  modelHttpJson,
  modelTestTimeoutMs,
} = require('./helpers');
if (require.main === module) ensureModelTestSupervisor();
const { emitLiveOutcome } = require('./provider-live-prerequisites');

const LIVE_PROVIDER = 'anthropic';
const LIVE_SUITE = 'judge-canary';

console.log('judge canary smoke test\n');

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('SKIP: ANTHROPIC_API_KEY not set — judge canary requires real cloud access');
  emitLiveOutcome(LIVE_PROVIDER, LIVE_SUITE, 'skipped', 'missing_ANTHROPIC_API_KEY');
  process.exit(0);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-judge-canary-'));

  try {
    // Minimal config: judge maps to anthropic backend
    const config = {
      backends: {
        anthropic: {
          kind: 'anthropic',
          url: 'https://api.anthropic.com',
          auth_env: 'ANTHROPIC_API_KEY',
        },
      },
      model_routes: {
        'claude-haiku-4-5-20251001': 'anthropic',
        're:^claude-.*$':            'anthropic',
      },
      llm_profiles: {
        '128gb': {
          judge: {
            connected_model:  'claude-haiku-4-5-20251001',
            disconnect_model: 'claude-haiku-4-5-20251001',
            on_failure:       'hard_fail',
          },
        },
      },
    };
    const configPath = writeConfig(tmpDir, config);

    console.log('1. judge call against real Anthropic API (haiku, low-cost)');
    await withModelTestProxy(
      { configPath, profile: '128gb', mode: 'connected' },
      async ({ port }) => {
        const judgeBody = {
          model: 'judge',
          max_tokens: 50,
          messages: [{
            role: 'user',
            content: 'Output exactly the line: VERDICT: PASS',
          }],
        };

        const r = await modelHttpJson(port, 'POST', '/v1/messages', judgeBody);

        assert(r.status === 200, `judge request 200 (got ${r.status}, body: ${(r.bodyText || '').slice(0, 200)})`);
        const text = (r.json?.content || []).map(c => c.text || '').join('');
        assert(/VERDICT:\s*PASS/i.test(text),
          `judge response contains VERDICT: PASS (got ${JSON.stringify(text.slice(0, 100))})`);

        // Verify routing metadata
        const via = JSON.parse(r.headers['x-c-thru-resolved-via'] || '{}');
        assert(via.capability === 'judge',
          `resolved-via.capability=judge (got ${JSON.stringify(via.capability)})`);
        assert(via.served_by === 'claude-haiku-4-5-20251001',
          `resolved-via.served_by=haiku (got ${JSON.stringify(via.served_by)})`);
        assert(via.mode === 'connected',
          `resolved-via.mode=connected (got ${JSON.stringify(via.mode)})`);

        // Latency sanity check
        if (typeof via.latency_ms === 'number') {
          assert(via.latency_ms > 0 && via.latency_ms < modelTestTimeoutMs(),
            `latency_ms reasonable (got ${via.latency_ms})`);
        }
      }
    );

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  emitLiveOutcome(
    LIVE_PROVIDER,
    LIVE_SUITE,
    failed ? 'failed' : 'passed',
    failed ? `${failed}_assertions_failed` : 'all_mandatory_contracts_exercised',
  );
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  emitLiveOutcome(LIVE_PROVIDER, LIVE_SUITE, 'failed', err?.code || err?.message || 'uncaught_error');
  process.exit(1);
});
