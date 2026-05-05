#!/usr/bin/env node
'use strict';
// Tests for c-thru-explain.js — runs against the SHIPPED config.
// Smoke-level coverage: invokes the script and asserts the output contains the
// expected resolution chain anchors. Doesn't try to assert exact pixel-text
// since the formatting may evolve.
//
// Run: node test/c-thru-explain.test.js

const path = require('path');
const { spawnSync } = require('child_process');

const { assert, assertEq, summary } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', 'tools', 'c-thru-explain.js');

function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...extraEnv },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

console.log('c-thru-explain tests\n');

// ── 1: slot resolution — single capability ─────────────────────────────────
console.log('1. best-cloud mode resolves planner to a claude model at 128gb');
{
  const r = run(['--capability', 'planner', '--mode', 'best-cloud', '--tier', '128gb']);
  assert(r.code === 0, `exit 0 (got ${r.code}, stderr: ${r.stderr.slice(0, 200)})`);
  assert(r.stdout.includes('1. Slot pick'), '"1. Slot pick" line present');
  assert(r.stdout.includes('Final routing'), '"Final routing" header present');
  const servedBy = (r.stdout.match(/served_by\s+(\S+)/) || [])[1];
  assert(servedBy && /^claude-/.test(servedBy),
    `planner/best-cloud/128gb resolves to a claude-* model (got ${servedBy})`);
}

// ── 2: gov filter — Chinese-origin model blocked ───────────────────────────
console.log('\n2. best-cloud-gov mode blocks Chinese-origin models');
{
  // planner/best-cloud-oss/64gb = qwen3.6 (Chinese); gov mode should block it
  const r = run(['--capability', 'planner', '--mode', 'best-cloud-gov', '--tier', '64gb']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const blocked = r.stdout.includes('BLOCKED') || r.stdout.includes('Gov filter');
  // Accept either blocked output or a non-qwen served_by (gov fallback picks claude)
  const servedBy = (r.stdout.match(/served_by\s+(\S+)/) || [])[1] || '';
  assert(blocked || (!servedBy.match(/qwen|deepseek|kimi|glm/i)),
    `gov mode does not serve Chinese-origin model (servedBy=${servedBy})`);
}

// ── 3: --agent resolves through agent_to_capability ────────────────────────
console.log('\n3. --agent flag resolves through agent_to_capability');
{
  const r = run(['--agent', 'coder', '--mode', 'best-cloud', '--tier', '64gb']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  assert(r.stdout.includes('capability=coder'),
    `agent coder resolves to capability=coder (got: ${r.stdout.slice(0, 300)})`);
}

// ── 4: unknown capability errors cleanly ───────────────────────────────────
console.log('\n4. unknown capability errors cleanly');
{
  const r = run(['--capability', 'totally-bogus-cap', '--mode', 'best-cloud', '--tier', '128gb']);
  assert(r.code !== 0, `non-zero exit (got ${r.code})`);
  assert(r.stderr.includes('not defined') || r.stderr.includes('totally-bogus-cap'),
    `clear error message (got: ${r.stderr.slice(0, 200)})`);
}

// ── 5: --help shows updated flags ─────────────────────────────────────────
console.log('\n5. --help shows usage with --all and --format');
{
  const r = run(['--help']);
  assert(r.code === 0, `--help exit 0`);
  assert(r.stdout.includes('Usage:'), 'shows Usage');
  assert(r.stdout.includes('--capability'), 'lists --capability flag');
  assert(r.stdout.includes('--agent'), 'lists --agent flag');
  assert(r.stdout.includes('--all'), 'lists --all flag');
  assert(r.stdout.includes('--format'), 'lists --format flag');
}

// ── 6: missing required arg ───────────────────────────────────────────────
console.log('\n6. missing --capability/--agent → clean error');
{
  const r = run(['--mode', 'best-cloud']);
  assert(r.code !== 0, `non-zero exit`);
  assert(r.stderr.includes('--capability') || r.stderr.includes('--agent'),
    `error mentions required flag`);
}

// ── 7: --all --format json — valid JSON, required fields present ──────────
console.log('\n7. --all --format json emits valid JSON with required fields');
{
  const r = run(['--all', '--format', 'json', '--mode', 'best-cloud', '--tier', '128gb']);
  assert(r.code === 0, `exit 0 (got ${r.code}, stderr: ${r.stderr.slice(0, 300)})`);
  let arr;
  try {
    arr = JSON.parse(r.stdout);
  } catch (e) {
    assert(false, `stdout is valid JSON (parse error: ${e.message})`);
    arr = [];
  }
  assert(Array.isArray(arr), 'output is a JSON array');
  assert(arr.length > 0, `array is non-empty (got ${arr.length} entries)`);
  const REQUIRED = ['capability', 'model', 'endpoint_id', 'endpoint_url',
    'endpoint_cli_host', 'endpoint_format', 'local', 'ollama', 'is_recommended'];
  for (const field of REQUIRED) {
    assert(arr.every(e => field in e), `every entry has field "${field}"`);
  }
  // All capabilities from llm_profiles should appear
  const caps = new Set(arr.map(e => e.capability));
  for (const expected of ['planner', 'coder', 'tester', 'code-reviewer', 'generalist']) {
    assert(caps.has(expected), `capability "${expected}" present in output`);
  }
}

// ── 8: --all text format (default) — compact table ────────────────────────
console.log('\n8. --all (text format) emits a compact table');
{
  const r = run(['--all', '--mode', 'best-cloud', '--tier', '128gb']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  assert(r.stdout.includes('[cloud]') || r.stdout.includes('[local]'),
    'text output contains [cloud] or [local] tags');
  assert(r.stdout.includes('planner'), 'planner capability in text output');
  assert(r.stdout.includes('coder'), 'coder capability in text output');
}

// ── 9: --all --format json — local entries have endpoint_cli_host ─────────
console.log('\n9. local entries have non-null endpoint_cli_host');
{
  const r = run(['--all', '--format', 'json', '--mode', 'best-cloud', '--tier', '128gb']);
  assert(r.code === 0, `exit 0`);
  const arr = JSON.parse(r.stdout);
  const localEntries = arr.filter(e => e.local === true);
  // At 128gb/best-cloud some caps resolve local (tester, edge, fast-generalist, fast-scout, docs)
  // but we don't insist they exist — just check the invariant when they do
  assert(localEntries.every(e => e.endpoint_cli_host !== null && e.endpoint_cli_host !== ''),
    `all local entries have non-null endpoint_cli_host (${localEntries.length} local entries)`);
  const cloudEntries = arr.filter(e => e.local === false);
  assert(cloudEntries.every(e => e.endpoint_cli_host === null),
    `all cloud entries have null endpoint_cli_host (${cloudEntries.length} cloud entries)`);
}

// ── 10: --all --format json — gov mode strips Chinese-origin models ────────
console.log('\n10. gov mode output has no Chinese-origin models');
{
  const r = run(['--all', '--format', 'json', '--mode', 'best-cloud-gov', '--tier', '64gb']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const arr = JSON.parse(r.stdout);
  const chinese = arr.filter(e => /qwen|deepseek|kimi|glm/i.test(e.model));
  assert(chinese.length === 0,
    `no Chinese-origin models in gov mode (found: ${chinese.map(e => e.model).join(', ') || 'none'})`);
}

// ── 11: --all --format json — best-local-oss has local:true entries ────────
console.log('\n11. best-local-oss mode has local entries');
{
  const r = run(['--all', '--format', 'json', '--mode', 'best-local-oss', '--tier', '64gb']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const arr = JSON.parse(r.stdout);
  const localEntries = arr.filter(e => e.local === true && e.ollama === true);
  assert(localEntries.length > 0,
    `best-local-oss/64gb has at least one ollama local entry (found ${localEntries.length})`);
}

// ── 12: --all --format json — is_recommended flag ─────────────────────────
console.log('\n12. is_recommended field is always boolean');
{
  const r = run(['--all', '--format', 'json', '--mode', 'best-cloud', '--tier', '128gb']);
  assert(r.code === 0, `exit 0`);
  const arr = JSON.parse(r.stdout);
  assert(arr.every(e => typeof e.is_recommended === 'boolean'),
    'is_recommended is boolean on every entry');
}

// ── 13: --all --format json — CLAUDE_LLM_PROFILE env picks tier ───────────
console.log('\n13. CLAUDE_LLM_PROFILE env var selects tier when --tier omitted');
{
  const r = run(['--all', '--format', 'json', '--mode', 'best-cloud'],
    { CLAUDE_LLM_PROFILE: '64gb' });
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const arr = JSON.parse(r.stdout);
  assert(Array.isArray(arr) && arr.length > 0, 'produces output via env var tier');
  // planner/best-cloud/64gb = claude-sonnet-4-6
  const planner = arr.find(e => e.capability === 'planner');
  assert(planner !== undefined, 'planner entry present');
  assertEq(planner.model, 'claude-sonnet-4-6',
    'planner resolves to claude-sonnet-4-6 at 64gb/best-cloud');
}

// ── 14: --all --format json — ollama flag logic ───────────────────────────
console.log('\n14. ollama:true iff local and anthropic/ollama-legacy format');
{
  const r = run(['--all', '--format', 'json', '--mode', 'best-local-oss', '--tier', '64gb']);
  assert(r.code === 0, `exit 0`);
  const arr = JSON.parse(r.stdout);
  for (const e of arr) {
    if (e.local && (e.endpoint_format === 'anthropic' || e.endpoint_format === 'ollama-legacy')) {
      assert(e.ollama === true, `local+anthropic-format entry ${e.capability} has ollama:true`);
    } else {
      assert(e.ollama === false, `non-local entry ${e.capability} has ollama:false`);
    }
  }
}

// ── 15: --model branch still works (regression) ───────────────────────────
console.log('\n15. --model branch still resolves via model_routes (regression)');
{
  const r = run(['--model', 'claude-sonnet-4-6']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  assert(r.stdout.includes('Final routing'), '"Final routing" header present');
  assert(r.stdout.includes('served_by'), 'shows served_by');
}

// ── 16: --all with unknown mode exits with clear error ────────────────────
console.log('\n16. --all with unknown mode exits with clear error');
{
  const r = run(['--all', '--format', 'json', '--mode', 'bogus-mode']);
  assert(r.code !== 0, `non-zero exit (got ${r.code})`);
  assert(r.stderr.includes('bogus-mode') && r.stderr.includes('valid:'),
    `error names the bad mode and lists valid modes (got: ${r.stderr.slice(0, 200)})`);
}

const failed = summary();
process.exit(failed ? 1 : 0);
