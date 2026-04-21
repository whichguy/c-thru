#!/usr/bin/env node
'use strict';
// Integration tests for hardware-tier forcing via --profile flag.
// Asserts active_tier from /ping — not /v1/models, since LLM_PROFILE_ALIASES is a static set.
// Run with: node test/proxy-tier-resolution.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { assert, summary, writeConfig, httpJson, withProxy } = require('./helpers');

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

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
