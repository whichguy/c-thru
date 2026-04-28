#!/usr/bin/env node
'use strict';
// Auto-detection test: spawns proxy with NO --profile flag and NO CLAUDE_LLM_PROFILE/
// CLAUDE_LLM_MEMORY_GB env overrides, then validates the proxy reports the correct
// hardware tier via /ping and x-c-thru-resolved-via response headers.
//
// Expected tier is passed in via EXPECTED_TIER env var (set by proxy-autodetect.test.sh
// from the machine's real RAM). Falls back to detecting via os.totalmem() when run standalone.
//
// Run with:  node test/proxy-autodetect.test.js              (standalone)
//            bash test/proxy-autodetect.test.sh              (shell-driven, compares to hw)

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, summary,
  stubBackend, writeConfig, httpJson, withProxy,
} = require('./helpers');

console.log('proxy-autodetect hardware-tier tests\n');

// ── Derive expected tier ───────────────────────────────────────────────────

function tierForGb(gb) {
  if (gb < 24) return '16gb';
  if (gb < 40) return '32gb';
  if (gb < 56) return '48gb';
  if (gb < 96) return '64gb';
  return '128gb';
}

const expectedTier = process.env.EXPECTED_TIER ||
  tierForGb(Math.floor(os.totalmem() / (1024 ** 3)));

console.log(`Machine RAM: ${Math.floor(os.totalmem() / (1024 ** 3))}GB`);
console.log(`Expected tier: ${expectedTier}\n`);

// ── Config (no llm_active_profile — let the proxy auto-detect) ─────────────

const CONCRETE_MODEL = 'autodetect-model-v1';

function buildConfig(stubPort) {
  const profile = {
    workhorse: {
      connected_model:  `${CONCRETE_MODEL}@stub`,
      disconnect_model: `${CONCRETE_MODEL}@stub`,
    },
  };
  // Populate only the expected tier so resolution fails loudly on wrong tier.
  return {
    backends: {
      stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    llm_profiles: {
      [expectedTier]: profile,
    },
  };
}

const MSG_BODY = {
  messages: [{ role: 'user', content: 'what is your model name, where were you born, model id and who is your maker?' }],
  max_tokens: 10,
};

function parseResolvedVia(headers) {
  const raw = headers['x-c-thru-resolved-via'];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-auto-'));
  let cfg16Dir    = null;
  let stub;

  // Spawn with NO --profile and clear any tier-forcing env vars so the proxy
  // falls through to os.totalmem() detection.
  const proxyOpts = {
    env: {
      CLAUDE_PROXY_ANNOTATE_MODEL: '1',
      CLAUDE_LLM_PROFILE:   '',   // clear any inherited value
      CLAUDE_LLM_MEMORY_GB: '',   // clear any inherited value
    },
  };

  try {
    stub = await stubBackend();
    const configPath = writeConfig(tmpDir, buildConfig(stub.port));

    // ── Test 1: /ping reports the correct auto-detected tier ───────────────
    console.log('1. /ping reports correct auto-detected tier');
    await withProxy({ configPath, ...proxyOpts }, async ({ port }) => {
      const r = await httpJson(port, 'GET', '/ping');
      assert(r.status === 200, '/ping status 200');
      assert(r.json && r.json.active_tier === expectedTier,
        `/ping active_tier === ${expectedTier} (got ${r.json && r.json.active_tier})`);
    });

    // ── Test 2: /v1/messages x-c-thru-resolved-via.tier matches auto-detected tier
    console.log('\n2. x-c-thru-resolved-via.tier matches auto-detected tier');
    await withProxy({ configPath, ...proxyOpts }, async ({ port }) => {
      const body = Object.assign({ model: 'workhorse' }, MSG_BODY);
      const r = await httpJson(port, 'POST', '/v1/messages', body);

      assert(r.status === 200, `autodetect: status 200 (got ${r.status})`);

      const via = parseResolvedVia(r.headers);
      assert(via !== null, 'autodetect: x-c-thru-resolved-via header present');
      assert(via && via.tier === expectedTier,
        `autodetect: x-c-thru-resolved-via.tier === ${expectedTier} (got ${via && via.tier})`);
      assert(via && via.served_by === CONCRETE_MODEL,
        `autodetect: served_by === ${CONCRETE_MODEL} (correct profile for tier)`);
      assert(via && via.capability === 'workhorse',
        'autodetect: capability === workhorse');
    });

    // ── Test 3: CLAUDE_LLM_MEMORY_GB override changes the reported tier ────
    console.log('\n3. CLAUDE_LLM_MEMORY_GB=14 overrides auto-detection → 16gb');
    {
      // Build a config that has a 16gb profile (the forced tier).
      cfg16Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-auto16-'));
      const cfg16 = writeConfig(cfg16Dir, {
        backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
        llm_profiles: {
          '16gb': {
            workhorse: {
              connected_model:  'wh-forced-16gb@stub',
              disconnect_model: 'wh-forced-16gb@stub',
            },
          },
        },
      });

      await withProxy(
        { configPath: cfg16, env: { CLAUDE_PROXY_ANNOTATE_MODEL: '1', CLAUDE_LLM_MEMORY_GB: '14' } },
        async ({ port }) => {
          const r = await httpJson(port, 'GET', '/ping');
          assert(r.json && r.json.active_tier === '16gb',
            `CLAUDE_LLM_MEMORY_GB=14 → active_tier === 16gb (got ${r.json && r.json.active_tier})`);

          const body = Object.assign({ model: 'workhorse' }, MSG_BODY);
          const r2 = await httpJson(port, 'POST', '/v1/messages', body);
          const via = parseResolvedVia(r2.headers);
          assert(via && via.tier === '16gb',
            `CLAUDE_LLM_MEMORY_GB=14 → x-c-thru-resolved-via.tier === 16gb (got ${via && via.tier})`);
          assert(via && via.served_by === 'wh-forced-16gb',
            `CLAUDE_LLM_MEMORY_GB=14 → served_by === wh-forced-16gb`);
        }
      );
    }

  } finally {
    if (stub) await stub.close().catch(() => {});
    try { fs.rmSync(tmpDir,    { recursive: true, force: true }); } catch {}
    try { fs.rmSync(cfg16Dir,  { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
