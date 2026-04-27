#!/usr/bin/env node
'use strict';
// E2E tests for c-thru CLI flag handling: --route, --mode, --profile.
// Uses a stub `claude` binary that JSON-dumps args + relevant env so we can
// verify the launcher correctly strips its own flags AND exports CLAUDE_LLM_MODE
// / CLAUDE_LLM_PROFILE for the proxy.
//
// Distinct from proxy-tier-resolution.test.js (which tests only the proxy):
// this drives the full c-thru bash entrypoint → proxy spawn → stub claude exec.
//
// Run: node test/cli-e2e-flags.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CTHRU = path.join(__dirname, '..', 'tools', 'c-thru');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else            { console.error(`  FAIL  ${message}`); failed++; }
}

function makeStubClaude(binDir) {
  const stubPath = path.join(binDir, 'claude');
  // Stub claude: JSON-dumps args + select env vars to stdout
  const script = `#!/bin/sh
node -e 'console.log(JSON.stringify({
  args: process.argv.slice(1),
  anthropic_base_url:    process.env.ANTHROPIC_BASE_URL    || null,
  claude_llm_mode:       process.env.CLAUDE_LLM_MODE       || null,
  claude_llm_profile:    process.env.CLAUDE_LLM_PROFILE    || null,
  claude_llm_memory_gb:  process.env.CLAUDE_LLM_MEMORY_GB  || null,
  claude_proxy_bypass:   process.env.CLAUDE_PROXY_BYPASS   || null,
  claude_proxy_journal:  process.env.CLAUDE_PROXY_JOURNAL  || null,
  claude_proxy_debug:    process.env.CLAUDE_PROXY_DEBUG    || null,
  claude_router_debug:   process.env.CLAUDE_ROUTER_DEBUG   || null,
  claude_router_no_update: process.env.CLAUDE_ROUTER_NO_UPDATE || null,
}))' -- "$@"
`;
  fs.writeFileSync(stubPath, script);
  fs.chmodSync(stubPath, 0o755);
}

function runCthru(args, configOverrides = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-cli-e2e-'));
  const homeDir = path.join(tmpRoot, 'home');
  const fakeBin = path.join(tmpRoot, 'bin');
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.symlinkSync(path.join(__dirname, '..', 'tools'), path.join(homeDir, '.claude', 'tools'));
  makeStubClaude(fakeBin);

  const config = Object.assign({
    backends: {
      anthropic: { kind: 'anthropic', url: 'https://anthropic.example' },
    },
    routes: {
      default: 'claude-sonnet-4-6',
      heavy:   'claude-opus-4-6',
    },
    model_routes: {
      'claude-sonnet-4-6': 'anthropic',
      'claude-opus-4-6':   'anthropic',
      're:^claude-.*$':    'anthropic',
    },
  }, configOverrides);

  const configPath = path.join(tmpRoot, 'model-map.json');
  fs.writeFileSync(configPath, JSON.stringify(config));

  const result = spawnSync(CTHRU, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CLAUDE_MODEL_MAP_PATH: configPath,
      CLAUDE_ROUTER_NO_UPDATE: '1',
      C_THRU_SKIP_PREPULL: '1',
      C_THRU_SKIP_PREFLIGHT: '1',
      CLAUDE_PROXY_STARTUP_PROBE: '0',
      CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
      OLLAMA_URL: 'http://127.0.0.1:11434',
    },
    cwd: tmpRoot,
  });

  let parsed = null;
  try { parsed = JSON.parse((result.stdout || '').trim()); } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '', json: parsed };
}

console.log('c-thru CLI flag-stripping e2e tests\n');

// ── Test 1: --route is stripped, --model is set to resolved value ──────────
console.log('1. --route name → strips --route, forwards resolved model');
{
  const r = runCthru(['--route', 'heavy']);
  assert(r.code === 0, `exit 0 (got ${r.code}, stderr: ${r.stderr.slice(0, 200)})`);
  assert(r.json !== null, 'stub claude received args');
  const args = r.json?.args || [];
  assert(!args.includes('--route'), `--route stripped (got args: ${JSON.stringify(args)})`);
  assert(!args.includes('heavy'), `route value 'heavy' stripped`);
  assert(args.some(a => a === '--model=claude-opus-4-6' || a === 'claude-opus-4-6'),
    `--model resolved to claude-opus-4-6 (got ${JSON.stringify(args)})`);
}

// ── Test 2: --mode <value> sets CLAUDE_LLM_MODE and is stripped ────────────
console.log('\n2. --mode offline → sets CLAUDE_LLM_MODE, strips flag');
{
  const r = runCthru(['--mode', 'offline', '--model', 'claude-sonnet-4-6']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--mode'), `--mode stripped (got: ${JSON.stringify(args)})`);
  assert(!args.includes('offline'), `'offline' value stripped from args`);
  assert(r.json?.claude_llm_mode === 'offline',
    `CLAUDE_LLM_MODE=offline reaches claude env (got ${JSON.stringify(r.json?.claude_llm_mode)})`);
}

// ── Test 3: --mode=value (= form) also stripped ────────────────────────────
console.log('\n3. --mode=connected (= form) → stripped, env set');
{
  const r = runCthru(['--mode=connected', '--model', 'claude-sonnet-4-6']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  // Tight check: --mode or --mode=, NOT --model (which has --mode as prefix).
  assert(!args.some(a => a === '--mode' || a.startsWith('--mode=')),
    `--mode=... stripped (got: ${JSON.stringify(args)})`);
  assert(r.json?.claude_llm_mode === 'connected',
    `CLAUDE_LLM_MODE=connected (got ${JSON.stringify(r.json?.claude_llm_mode)})`);
}

// ── Test 4: --profile sets CLAUDE_LLM_PROFILE and is stripped ──────────────
console.log('\n4. --profile 64gb → sets CLAUDE_LLM_PROFILE, strips flag');
{
  const r = runCthru(['--profile', '64gb', '--model', 'claude-sonnet-4-6']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--profile'), `--profile stripped`);
  assert(!args.includes('64gb'), `'64gb' value stripped`);
  assert(r.json?.claude_llm_profile === '64gb',
    `CLAUDE_LLM_PROFILE=64gb reaches env (got ${JSON.stringify(r.json?.claude_llm_profile)})`);
}

// ── Test 5: combined --mode + --profile + --route ──────────────────────────
console.log('\n5. --mode + --profile + --route together');
{
  const r = runCthru(['--mode', 'offline', '--profile', '128gb', '--route', 'heavy']);
  assert(r.code === 0, `exit 0 (got ${r.code}, stderr: ${r.stderr.slice(0, 200)})`);
  const args = r.json?.args || [];
  assert(!args.includes('--mode'), '--mode stripped');
  assert(!args.includes('--profile'), '--profile stripped');
  assert(!args.includes('--route'), '--route stripped');
  assert(r.json?.claude_llm_mode === 'offline', 'CLAUDE_LLM_MODE=offline');
  assert(r.json?.claude_llm_profile === '128gb', 'CLAUDE_LLM_PROFILE=128gb');
  assert(args.some(a => a === '--model=claude-opus-4-6' || a === 'claude-opus-4-6'),
    `route resolved to opus (got ${JSON.stringify(args)})`);
}

// ── Test 6: ollama-backed model → proxy is spawned, BASE_URL points to it ──
console.log('\n6. ollama-backed model → ANTHROPIC_BASE_URL points to spawned proxy');
{
  // Force proxy spawn by routing through an ollama backend
  const r = runCthru(['--model', 'qwen3:1.7b'], {
    backends: {
      ollama: { kind: 'ollama', url: 'http://127.0.0.1:11434' },
    },
    routes: { default: 'qwen3:1.7b' },
    model_routes: { 'qwen3:1.7b': 'ollama' },
  });
  assert(r.code === 0, `exit 0 (got ${r.code}, stderr: ${r.stderr.slice(0, 200)})`);
  const url = r.json?.anthropic_base_url || '';
  assert(/^https?:\/\/127\.0\.0\.1:\d+/.test(url),
    `ANTHROPIC_BASE_URL = proxy URL on 127.0.0.1 (got ${JSON.stringify(url)})`);
}

// ── Test 7: invalid --mode value should produce non-zero exit ──────────────
console.log('\n7. --mode without value → exit non-zero');
{
  const r = runCthru(['--mode']);
  assert(r.code !== 0, `--mode without value exits non-zero (got ${r.code})`);
  assert(/--mode requires a value/.test(r.stderr),
    `error message present (got: ${r.stderr.slice(0, 200)})`);
}

// ── Test 8: --profile without value → exit non-zero ────────────────────────
console.log('\n8. --profile without value → exit non-zero');
{
  const r = runCthru(['--profile']);
  assert(r.code !== 0, `exits non-zero (got ${r.code})`);
  assert(/--profile requires a tier/.test(r.stderr),
    `error message present (got: ${r.stderr.slice(0, 200)})`);
}

// ── Test 9: --bypass-proxy ────────────────────────────────────────────────
console.log('\n9. --bypass-proxy → CLAUDE_PROXY_BYPASS=1, stripped from args');
{
  const r = runCthru(['--bypass-proxy', '--model', 'claude-sonnet-4-6']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--bypass-proxy'), `--bypass-proxy stripped`);
  assert(r.json?.claude_proxy_bypass === '1', `CLAUDE_PROXY_BYPASS=1 (got ${JSON.stringify(r.json?.claude_proxy_bypass)})`);
}

// ── Test 10: --journal ────────────────────────────────────────────────────
console.log('\n10. --journal → CLAUDE_PROXY_JOURNAL=1, stripped from args');
{
  const r = runCthru(['--journal', '--model', 'claude-sonnet-4-6']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--journal'), `--journal stripped`);
  assert(r.json?.claude_proxy_journal === '1', `CLAUDE_PROXY_JOURNAL=1`);
}

// ── Test 11: --no-update ──────────────────────────────────────────────────
console.log('\n11. --no-update → CLAUDE_ROUTER_NO_UPDATE=1, stripped');
{
  const r = runCthru(['--no-update', '--model', 'claude-sonnet-4-6']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--no-update'), `--no-update stripped`);
  assert(r.json?.claude_router_no_update === '1', `CLAUDE_ROUTER_NO_UPDATE=1`);
}

// ── Test 12: --proxy-debug 2 ──────────────────────────────────────────────
console.log('\n12. --proxy-debug 2 → CLAUDE_PROXY_DEBUG=2, both flag and value stripped');
{
  const r = runCthru(['--proxy-debug', '2', '--model', 'claude-sonnet-4-6']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--proxy-debug'), `--proxy-debug stripped`);
  assert(!args.includes('2'), `value '2' stripped`);
  assert(r.json?.claude_proxy_debug === '2', `CLAUDE_PROXY_DEBUG=2 (got ${JSON.stringify(r.json?.claude_proxy_debug)})`);
}

// ── Test 13: --proxy-debug (no value) defaults to 1 ───────────────────────
console.log('\n13. --proxy-debug (no value) → CLAUDE_PROXY_DEBUG=1');
{
  const r = runCthru(['--proxy-debug', '--model', 'claude-sonnet-4-6']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--proxy-debug'), `--proxy-debug stripped`);
  assert(r.json?.claude_proxy_debug === '1', `default CLAUDE_PROXY_DEBUG=1`);
}

// ── Test 14: --router-debug=2 (= form) ────────────────────────────────────
console.log('\n14. --router-debug=2 → CLAUDE_ROUTER_DEBUG=2');
{
  const r = runCthru(['--router-debug=2', '--model', 'claude-sonnet-4-6']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.some(x => x.startsWith('--router-debug')), `--router-debug=... stripped`);
  assert(r.json?.claude_router_debug === '2', `CLAUDE_ROUTER_DEBUG=2`);
}

// ── Test 15: --memory-gb 32 ───────────────────────────────────────────────
console.log('\n15. --memory-gb 32 → CLAUDE_LLM_MEMORY_GB=32, stripped');
{
  const r = runCthru(['--memory-gb', '32', '--model', 'claude-sonnet-4-6']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--memory-gb'), `--memory-gb stripped`);
  assert(!args.includes('32'), `value '32' stripped`);
  assert(r.json?.claude_llm_memory_gb === '32', `CLAUDE_LLM_MEMORY_GB=32`);
}

// ── Test 16: --memory-gb non-numeric → error ──────────────────────────────
console.log('\n16. --memory-gb foo → exit non-zero');
{
  const r = runCthru(['--memory-gb', 'foo']);
  assert(r.code !== 0, `non-numeric value rejected (got ${r.code})`);
  assert(/memory.gb.*positive integer|CLAUDE_LLM_MEMORY_GB.*positive integer/i.test(r.stderr), `clear error message`);
}

// ── Test 17: combined --journal + --proxy-debug 1 + --no-update ───────────
console.log('\n17. multiple flags combined');
{
  const r = runCthru(['--journal', '--proxy-debug', '1', '--no-update', '--model', 'claude-sonnet-4-6']);
  assert(r.code === 0, `exit 0`);
  assert(r.json?.claude_proxy_journal === '1', 'journal env');
  assert(r.json?.claude_proxy_debug === '1', 'proxy-debug env');
  assert(r.json?.claude_router_no_update === '1', 'no-update env');
  const args = r.json?.args || [];
  for (const f of ['--journal', '--proxy-debug', '--no-update']) {
    assert(!args.includes(f), `${f} stripped`);
  }
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
