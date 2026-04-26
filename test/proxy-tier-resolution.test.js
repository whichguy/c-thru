#!/usr/bin/env node
'use strict';
// Integration tests for hardware-tier forcing via --profile flag.
// Asserts active_tier from /ping — not /v1/models, since LLM_PROFILE_ALIASES is a static set.
// Run with: node test/proxy-tier-resolution.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { assert, summary, stubBackend, writeConfig, httpJson, withProxy } = require('./helpers');

console.log('proxy-tier-resolution integration tests\n');

const TIER_CONFIG = {
  llm_profiles: {
    '16gb':  { workhorse: { connected_model: 'qwen3:1.7b',  disconnect_model: 'qwen3:1.7b'  } },
    '64gb':  { workhorse: { connected_model: 'qwen3:27b',   disconnect_model: 'qwen3:1.7b'  } },
    '128gb': { workhorse: { connected_model: 'qwen3:122b',  disconnect_model: 'qwen3:1.7b'  } },
  },
  agent_to_capability: { 'test-agent': 'workhorse' },
};

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-tier-'));
  const configPath = writeConfig(tmpDir, TIER_CONFIG);

  // ── Test 1: --profile 16gb → active_tier === '16gb' ─────────────────────
  console.log('1. --profile 16gb forces active_tier to 16gb');
  await withProxy({ configPath, profile: '16gb' }, async ({ port }) => {
    const r = await httpJson(port, 'GET', '/ping');
    assert(r.json && r.json.active_tier === '16gb', 'active_tier === 16gb');
  });

  // ── Test 2: --profile 64gb → active_tier === '64gb' ─────────────────────
  console.log('\n2. --profile 64gb forces active_tier to 64gb');
  await withProxy({ configPath, profile: '64gb' }, async ({ port }) => {
    const r = await httpJson(port, 'GET', '/ping');
    assert(r.json && r.json.active_tier === '64gb', 'active_tier === 64gb');
  });

  // ── Test 3: --profile 128gb → active_tier === '128gb' ───────────────────
  console.log('\n3. --profile 128gb forces active_tier to 128gb');
  await withProxy({ configPath, profile: '128gb' }, async ({ port }) => {
    const r = await httpJson(port, 'GET', '/ping');
    assert(r.json && r.json.active_tier === '128gb', 'active_tier === 128gb');
  });

  // ── Test 4: CLAUDE_LLM_MEMORY_GB=14 → 16gb tier (hw-profile breakpoint) ─
  // hw-profile.js: gb < 24 → '16gb'
  console.log('\n4. CLAUDE_LLM_MEMORY_GB=14 resolves to 16gb tier');
  await withProxy({ configPath, env: { CLAUDE_LLM_MEMORY_GB: '14' } }, async ({ port }) => {
    const r = await httpJson(port, 'GET', '/ping');
    assert(r.json && r.json.active_tier === '16gb', 'CLAUDE_LLM_MEMORY_GB=14 → 16gb');
  });

  // ── Test 5: --profile wins over CLAUDE_LLM_MEMORY_GB ────────────────────
  // CLAUDE_LLM_MEMORY_GB=120 would resolve to 128gb, but --profile 16gb overrides
  console.log('\n5. --profile 16gb wins over CLAUDE_LLM_MEMORY_GB=120');
  await withProxy({ configPath, profile: '16gb', env: { CLAUDE_LLM_MEMORY_GB: '120' } }, async ({ port }) => {
    const r = await httpJson(port, 'GET', '/ping');
    assert(r.json && r.json.active_tier === '16gb', '--profile wins over CLAUDE_LLM_MEMORY_GB');
  });

  // ── Tests 6-11: --mode flag forces LLM mode end-to-end ─────────────────
  // Fixture has all optional fields so every mode resolves to a distinct model.
  const stub = await stubBackend();
  const modeConfig = writeConfig(tmpDir, {
    backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
    llm_profiles: {
      '128gb': { workhorse: {
        connected_model:  'mode-conn@stub',
        disconnect_model: 'mode-disc@stub',
        cloud_best_model: 'mode-cbq@stub',
        local_best_model: 'mode-lbq@stub',
        modes: {
          'semi-offload':    'mode-semi@stub',
          'cloud-judge-only': 'mode-cjo@stub',
        },
      } },
    },
  });

  const parseVia = headers => {
    try { return JSON.parse(headers['x-c-thru-resolved-via']); } catch { return null; }
  };
  const MSG = { model: 'workhorse', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 };

  const modeCases = [
    { mode: 'offline',            expectedModel: 'mode-disc', label: 'disconnect_model' },
    { mode: 'connected',          expectedModel: 'mode-conn', label: 'connected_model'  },
    { mode: 'semi-offload',       expectedModel: 'mode-semi', label: 'modes[semi-offload]' },
    { mode: 'cloud-judge-only',   expectedModel: 'mode-cjo',  label: 'modes[cloud-judge-only]' },
    { mode: 'cloud-best-quality', expectedModel: 'mode-cbq',  label: 'cloud_best_model' },
    { mode: 'local-best-quality', expectedModel: 'mode-lbq',  label: 'local_best_model' },
  ];

  let testNum = 6;
  try {
    for (const { mode, expectedModel, label } of modeCases) {
      console.log(`\n${testNum++}. --mode ${mode} → ${label}`);
      await withProxy({ configPath: modeConfig, profile: '128gb', mode }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', MSG);
        const req = stub.lastRequest();
        assert(req && req.model_used === expectedModel,
          `--mode ${mode}: stub receives ${label} (got ${req && req.model_used})`);
        const via = parseVia(r.headers);
        assert(via && via.mode === mode,
          `--mode ${mode}: x-c-thru-resolved-via.mode=${mode} (got ${via && via.mode})`);
      });
    }
  } finally { await stub.close().catch(() => {}); }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
