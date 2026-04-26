#!/usr/bin/env node
'use strict';
// Tests for c-thru-explain.js — runs against the SHIPPED config + benchmark.
// Smoke-level coverage: invokes the script and asserts the output contains the
// expected resolution chain anchors. Doesn't try to assert exact pixel-text
// since the formatting may evolve.
//
// Run: node test/c-thru-explain.test.js

const path = require('path');
const { spawnSync } = require('child_process');

const { assert, summary } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', 'tools', 'c-thru-explain.js');

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' }, // strip ANSI for predictable matching
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

console.log('c-thru-explain tests\n');

// ── Test 1: slot-based mode (connected) — shows slot pick, no ranking ─────
console.log('1. connected mode shows slot pick');
{
  const r = run(['--capability', 'workhorse', '--mode', 'connected', '--tier', '128gb']);
  assert(r.code === 0, `exit 0 (got ${r.code}, stderr: ${r.stderr.slice(0, 200)})`);
  assert(r.stdout.includes('1. Slot pick'), '"1. Slot pick" line present');
  assert(r.stdout.includes('connected_model'), 'shows source as connected_model');
  assert(r.stdout.includes('Final routing'), '"Final routing" header present');
  assert(r.stdout.includes('backend_id'), 'shows backend_id');
}

// ── Test 2: filter mode (claude-only) shows filter walk ────────────────────
console.log('\n2. claude-only mode shows filter swap');
{
  const r = run(['--capability', 'workhorse', '--mode', 'claude-only', '--tier', '128gb']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  // Should show either "Filter swap" or "Filter result"
  assert(r.stdout.includes('Filter') || r.stdout.includes('claude-only'),
    `mentions filter or claude-only in output`);
  // served_by should be a claude-* model
  const servedBy = (r.stdout.match(/served_by\s+(\S+)/) || [])[1];
  assert(servedBy && /^claude-/.test(servedBy),
    `claude-only resolves to a claude-* model (got ${servedBy})`);
}

// ── Test 3: ranking mode shows full candidate list with tiebreaks ──────────
console.log('\n3. fastest-possible mode shows ranking eligible list');
{
  const r = run(['--capability', 'workhorse', '--mode', 'fastest-possible', '--tier', '128gb']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  assert(r.stdout.includes('Ranking'), '"Ranking" header present');
  assert(r.stdout.includes('eligible'), 'shows eligible candidate list');
  assert(r.stdout.includes('t/s'), 'shows tokens_per_sec column');
  // Should show the arrow → on the selected model
  assert(r.stdout.includes('→'), 'arrow marker on selected model');
}

// ── Test 4: --agent resolves through agent_to_capability ──────────────────
console.log('\n4. --agent flag resolves through agent_to_capability');
{
  const r = run(['--agent', 'test-writer', '--mode', 'connected', '--tier', '64gb']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  // test-writer maps to code-analyst capability
  assert(r.stdout.includes('capability=code-analyst'),
    `agent test-writer resolves to capability=code-analyst (full output: ${r.stdout.slice(0, 300)})`);
}

// ── Test 5: unknown capability prints clean error ──────────────────────────
console.log('\n5. unknown capability errors cleanly');
{
  const r = run(['--capability', 'totally-bogus-cap', '--mode', 'connected', '--tier', '128gb']);
  assert(r.code !== 0, `non-zero exit (got ${r.code})`);
  assert(r.stderr.includes('not defined') || r.stderr.includes('totally-bogus-cap'),
    `clear error message (got: ${r.stderr.slice(0, 200)})`);
}

// ── Test 6: --help works ───────────────────────────────────────────────────
console.log('\n6. --help shows usage');
{
  const r = run(['--help']);
  assert(r.code === 0, `--help exit 0`);
  assert(r.stdout.includes('Usage:'), 'shows Usage');
  assert(r.stdout.includes('--capability'), 'lists --capability flag');
  assert(r.stdout.includes('--agent'), 'lists --agent flag');
}

// ── Test 7: missing required arg ──────────────────────────────────────────
console.log('\n7. missing --capability/--agent → clean error');
{
  const r = run(['--mode', 'connected']);
  assert(r.code !== 0, `non-zero exit`);
  assert(r.stderr.includes('--capability') || r.stderr.includes('--agent'),
    `error mentions required flag`);
}

const failed = summary();
process.exit(failed ? 1 : 0);
