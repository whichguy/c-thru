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
const path = require('path');
const { spawnSync } = require('child_process');
const { makeIsolatedTmpDir, modelTestTimeoutMs } = require('./helpers');

const CTHRU = path.join(__dirname, '..', 'tools', 'c-thru');
const COORDINATOR_ONLY = process.env.C_THRU_TEST_ONLY === 'coordinator';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else            { console.error(`  FAIL  ${message}`); failed++; }
}

function formatArgs(args) {
  return JSON.stringify((args || []).map((arg) => (
    typeof arg === 'string' && arg.length > 160
      ? `${arg.slice(0, 80)}…<${arg.length} chars>`
      : arg
  )));
}

function makeStubClaude(binDir) {
  const stubPath = path.join(binDir, 'claude');
  // Stub claude: JSON-dumps args + select env vars to stdout. Also captures the
  // inline JSON string passed to --settings (the launcher now passes settings
  // inline, not as a file path) so C1 can assert its shape.
  const script = `#!/bin/sh
node -e '
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(1);
let settings_content = null;
const si = args.indexOf("--settings");
if (si >= 0 && args[si + 1]) {
  // c-thru passes settings inline as a JSON string, not a file path.
  settings_content = args[si + 1];
} else {
  const settingsEquals = args.find(arg => arg.startsWith("--settings="));
  if (settingsEquals) settings_content = settingsEquals.slice("--settings=".length);
}
const agents_occurrences = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--agents") {
    agents_occurrences.push({ form: "space", value: i + 1 < args.length ? args[i + 1] : null });
    i++;
  } else if (args[i].startsWith("--agents=")) {
    agents_occurrences.push({ form: "equals", value: args[i].slice("--agents=".length) });
  }
}
const config_dir = process.env.CLAUDE_CONFIG_DIR || null;
const physical_settings_path = config_dir ? path.join(config_dir, "settings.json") : null;
let physical_settings_content = null;
if (physical_settings_path) {
  try { physical_settings_content = fs.readFileSync(physical_settings_path, "utf8"); } catch {}
}
const coordinator_agent_path = config_dir ? path.join(config_dir, "agents", "c-thru-coordinator.md") : null;
let coordinator_agent_is_symlink = false;
let coordinator_agent_realpath = null;
if (coordinator_agent_path) {
  try {
    coordinator_agent_is_symlink = fs.lstatSync(coordinator_agent_path).isSymbolicLink();
    coordinator_agent_realpath = fs.realpathSync(coordinator_agent_path);
  } catch {}
}
console.log(JSON.stringify({
  args,
  settings_content,
  agents_occurrences,
  config_dir,
  physical_settings_content,
  coordinator_agent_is_symlink,
  coordinator_agent_realpath,
  anthropic_base_url:    process.env.ANTHROPIC_BASE_URL    || null,
  claude_llm_mode:       process.env.CLAUDE_LLM_MODE       || null,
  claude_llm_profile:    process.env.CLAUDE_LLM_PROFILE    || null,
  claude_llm_memory_gb:  process.env.CLAUDE_LLM_MEMORY_GB  || null,
  claude_proxy_bypass:   process.env.CLAUDE_PROXY_BYPASS   || null,
  claude_proxy_journal:  process.env.CLAUDE_PROXY_JOURNAL  || null,
  claude_proxy_debug:    process.env.CLAUDE_PROXY_DEBUG    || null,
  claude_router_debug:   process.env.C_THRU_DEBUG          || null,
  claude_proxy_anthropic_upstream: process.env.CLAUDE_PROXY_ANTHROPIC_UPSTREAM || null,
  c_thru_anthropic_upstream_fingerprint: process.env.C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT || null,
  c_thru_no_update: process.env.C_THRU_NO_UPDATE || null,
  c_thru_session_id: process.env.C_THRU_SESSION_ID || null,
  c_thru_coordinator_active: process.env.C_THRU_COORDINATOR_ACTIVE || null,
}));
' -- "$@"
`;
  fs.writeFileSync(stubPath, script);
  fs.chmodSync(stubPath, 0o755);
}

function runCthru(args, configOverrides = {}, envOverrides = {}, opts = {}) {
  const tmpRoot = makeIsolatedTmpDir('c-thru-cli-e2e-');
  const homeDir = path.join(tmpRoot, 'home');
  const claudeDir = path.join(homeDir, '.claude');
  const fakeBin = path.join(tmpRoot, 'bin');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  // Optionally seed the DURABLE ~/.claude/settings.json before the launch so a
  // test can prove the ephemeral write never touches it. Captures its mtime.
  let durableSettings = null, seedMtimeMs = null;
  if (opts.seedSettings != null) {
    durableSettings = path.join(homeDir, '.claude', 'settings.json');
    fs.writeFileSync(durableSettings, opts.seedSettings);
    seedMtimeMs = fs.statSync(durableSettings).mtimeMs;
  }
  fs.symlinkSync(path.join(__dirname, '..', 'tools'), path.join(claudeDir, 'tools'));
  makeStubClaude(fakeBin);

  const config = Object.assign({
    backends: {
      anthropic: { kind: 'anthropic', url: 'https://anthropic.example' },
    },
    routes: {
      default: 'claude-sonnet-5',
      heavy:   'claude-opus-4-6',
    },
    model_routes: {
      'claude-sonnet-5': 'anthropic',
      'claude-opus-4-6':   'anthropic',
      're:^claude-.*$':    'anthropic',
    },
  }, configOverrides);

  const configPath = path.join(tmpRoot, 'model-map.json');
  fs.writeFileSync(configPath, JSON.stringify(config));

  const childEnv = { ...process.env };
  for (const key of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_BIN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROFILE_DIR', 'CLAUDE_DIR',
    'CLAUDE_MODEL_MAP_PATH', 'CLAUDE_MODEL_MAP_LAUNCH_CWD',
    'CLAUDE_PROXY_BYPASS', 'CLAUDE_PROXY_PORT', 'CLAUDE_PROXY_JOURNAL',
    'CLAUDE_PROXY_DEBUG', 'CLAUDE_PROXY_USE_OLLAMA_PORT',
    'CLAUDE_PROXY_ANTHROPIC_UPSTREAM', 'C_THRU_ANTHROPIC_UPSTREAM',
    'C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT', 'C_THRU_CLI_ANTHROPIC_UPSTREAM',
    'CLAUDE_LLM_MODE', 'CLAUDE_LLM_MEMORY_GB', 'CLAUDE_CONNECTIVITY_MODE',
    'C_THRU_DEBUG', 'C_THRU_SESSION_ID', 'C_THRU_LAUNCH_DEFAULT_MODEL',
    'C_THRU_PROXY_ALWAYS', 'C_THRU_COORDINATOR', 'C_THRU_COORDINATOR_ACTIVE',
  ]) {
    delete childEnv[key];
  }
  Object.assign(childEnv, {
    HOME: homeDir,
    TMPDIR: tmpRoot,
    PATH: `${fakeBin}:${process.env.PATH}`,
    CLAUDE_CONFIG_DIR: claudeDir,
    CLAUDE_PROFILE_DIR: claudeDir,
    CLAUDE_DIR: claudeDir,
    CLAUDE_MODEL_MAP_PATH: configPath,
    CLAUDE_MODEL_MAP_LAUNCH_CWD: tmpRoot,
    C_THRU_NO_UPDATE: '1',
    C_THRU_NO_MARKETPLACE_UPDATE: '1',
    C_THRU_NO_OAUTH_INJECT: '1',
    C_THRU_SKIP_PREPULL: '1',
    C_THRU_SKIP_PREFLIGHT: '1',
    CLAUDE_PROXY_STARTUP_PROBE: '0',
    CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
    OLLAMA_URL: 'http://127.0.0.1:11434',
    CLAUDE_LLM_PROFILE: '16gb',
  }, envOverrides);

  const result = spawnSync(CTHRU, args, {
    encoding: 'utf8',
    timeout: modelTestTimeoutMs(),
    env: childEnv,
    cwd: tmpRoot,
  });

  let parsed = null;
  try { parsed = JSON.parse((result.stdout || '').trim()); } catch {}
  if (!opts.keepSandbox) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '', json: parsed,
           tmpRoot, homeDir, durableSettings, seedMtimeMs };
}

console.log('c-thru CLI flag-stripping e2e tests\n');

if (!COORDINATOR_ONLY) {
// ── Test 1: --route is stripped, --model is set to resolved value ──────────
console.log('1. --route name → strips --route, forwards resolved model');
{
  const r = runCthru(['--route', 'heavy']);
  assert(r.code === 0, `exit 0 (got ${r.code}, stderr: ${r.stderr.slice(0, 200)})`);
  assert(r.json !== null, 'stub claude received args');
  const args = r.json?.args || [];
  assert(!args.includes('--route'), `--route stripped (got args: ${formatArgs(args)})`);
  assert(!args.includes('heavy'), `route value 'heavy' stripped`);
  assert(args.some(a => a === '--model=claude-opus-4-6' || a === 'claude-opus-4-6'),
    `--model resolved to claude-opus-4-6 (got ${formatArgs(args)})`);
}

// ── Test 2: --mode <value> sets CLAUDE_LLM_MODE and is stripped ────────────
console.log('\n2. --mode offline → sets CLAUDE_LLM_MODE, strips flag');
{
  const r = runCthru(['--mode', 'offline', '--model', 'claude-sonnet-5']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--mode'), `--mode stripped (got: ${formatArgs(args)})`);
  assert(!args.includes('offline'), `'offline' value stripped from args`);
  // --mode offline is normalized at export to best-local-oss (selectable mode name).
  assert(r.json?.claude_llm_mode === 'best-local-oss',
    `CLAUDE_LLM_MODE=best-local-oss after offline normalize (got ${JSON.stringify(r.json?.claude_llm_mode)})`);
}

// ── Test 3: --mode=value (= form) also stripped ────────────────────────────
console.log('\n3. --mode=connected (= form) → stripped, env set');
{
  const r = runCthru(['--mode=connected', '--model', 'claude-sonnet-5']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  // Tight check: --mode or --mode=, NOT --model (which has --mode as prefix).
  assert(!args.some(a => a === '--mode' || a.startsWith('--mode=')),
    `--mode=... stripped (got: ${formatArgs(args)})`);
  // --mode connected normalizes to best-cloud-oss (DEFAULT_MODE).
  assert(r.json?.claude_llm_mode === 'best-cloud-oss',
    `CLAUDE_LLM_MODE=best-cloud-oss after connected normalize (got ${JSON.stringify(r.json?.claude_llm_mode)})`);
}

// ── Test 4: --profile sets CLAUDE_LLM_PROFILE and is stripped ──────────────
console.log('\n4. --profile 64gb → sets CLAUDE_LLM_PROFILE, strips flag');
{
  const r = runCthru(['--profile', '64gb', '--model', 'claude-sonnet-5']);
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
  assert(r.json?.claude_llm_mode === 'best-local-oss', 'CLAUDE_LLM_MODE=best-local-oss (offline normalized)');
  assert(r.json?.claude_llm_profile === '128gb', 'CLAUDE_LLM_PROFILE=128gb');
  assert(args.some(a => a === '--model=claude-opus-4-6' || a === 'claude-opus-4-6'),
    `route resolved to opus (got ${formatArgs(args)})`);
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
  // Round-5 B2: the base URL carries a /s/<C_THRU_SESSION_ID> suffix so the
  // proxy can isolate per-session mode state on a shared proxy. The leading
  // `^https?://127\.0\.0\.1:\d+` match above still holds unchanged (no `$`
  // anchor) — this asserts the suffix ADDITIONALLY, not instead.
  const sessionId = r.json?.c_thru_session_id || '';
  assert(sessionId.length > 0, `C_THRU_SESSION_ID is set (got ${JSON.stringify(sessionId)})`);
  assert(url.endsWith(`/s/${sessionId}`),
    `ANTHROPIC_BASE_URL carries the /s/<session-id> suffix (got ${JSON.stringify(url)}, session ${JSON.stringify(sessionId)})`);
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

// ── Test 9: --bypass-proxy explicit + transparent paths ───────────────────
console.log('\n9. --bypass-proxy skips proxy on explicit-model and transparent paths');
{
  const r = runCthru(['--bypass-proxy', '--model', 'claude-sonnet-5'], {
    backends: {
      anthropic: { kind: 'anthropic', url: 'https://api.anthropic.com' },
    },
  });
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--bypass-proxy'), `--bypass-proxy stripped`);
  assert(r.json?.claude_proxy_bypass === '1', `CLAUDE_PROXY_BYPASS=1 (got ${JSON.stringify(r.json?.claude_proxy_bypass)})`);
  assert(r.json?.anthropic_base_url === 'https://api.anthropic.com',
    `explicit model bypass uses direct backend URL (got ${JSON.stringify(r.json?.anthropic_base_url)})`);
  assert(!/proxy\s+starting/.test(r.stderr),
    `explicit model bypass does not spawn proxy (stderr: ${r.stderr.slice(0, 200)})`);

  const prompt = 'transparent-bypass-prompt';
  const transparent = runCthru(['--bypass-proxy', '-p', prompt], {
    routes: {},
  });
  assert(transparent.code === 0,
    `transparent bypass exit 0 (got ${transparent.code}, stderr: ${transparent.stderr.slice(0, 200)})`);
  const transparentArgs = transparent.json?.args || [];
  assert(!transparentArgs.includes('--bypass-proxy'),
    `transparent bypass strips private flag (got ${formatArgs(transparentArgs)})`);
  assert(transparentArgs.includes('-p') && transparentArgs.includes(prompt),
    `transparent bypass preserves Claude-owned prompt args (got ${formatArgs(transparentArgs)})`);
  assert(transparent.json?.anthropic_base_url === null,
    `transparent bypass does not inject a proxy URL (got ${JSON.stringify(transparent.json?.anthropic_base_url)})`);
  assert(!/proxy\s+starting/.test(transparent.stderr),
    `transparent bypass does not spawn proxy (stderr: ${transparent.stderr.slice(0, 200)})`);

  for (const [model, kind] of [
    ['gemini-test-model', 'gemini'],
    ['openai-test-model', 'openai'],
    ['ollama-legacy-test-model', 'ollama'],
  ]) {
    const incompatible = runCthru(['--bypass-proxy', '--model', model], {
      backends: {
        anthropic: { kind: 'anthropic', url: 'https://anthropic.example' },
        incompatible: { kind, url: `https://${kind}.example` },
      },
      routes: { default: 'claude-sonnet-5' },
      model_routes: {
        'claude-sonnet-5': 'anthropic',
        [model]: 'incompatible',
      },
    });
    assert(incompatible.code !== 0,
      `${kind} bypass fails before launching Claude (got ${incompatible.code})`);
    assert(new RegExp(`format=${kind}`).test(incompatible.stderr) &&
      /requires c-thru protocol translation/.test(incompatible.stderr),
    `${kind} bypass explains the protocol boundary (stderr: ${incompatible.stderr.slice(0, 240)})`);
    assert(!/proxy\s+starting/.test(incompatible.stderr),
      `${kind} bypass rejection does not start a proxy`);
  }

  const xaiLike = runCthru(['--bypass-proxy', '--model', 'xai-test-model'], {
    backends: {
      anthropic: { kind: 'anthropic', url: 'https://api.anthropic.com' },
      xai: {
        kind: 'anthropic',
        url: 'https://api.x.ai',
        auth: { header: 'Authorization', scheme: 'Bearer', env: 'XAI_API_KEY' },
      },
    },
    routes: { default: 'claude-sonnet-5' },
    model_routes: {
      'claude-sonnet-5': 'anthropic',
      'xai-test-model': 'xai',
    },
  });
  assert(xaiLike.code !== 0,
    `non-native Anthropic-shape bypass fails before launching Claude (got ${xaiLike.code})`);
  assert(/supports only the native Anthropic API/.test(xaiLike.stderr),
    `non-native Anthropic-shape bypass explains auth/path boundary (stderr: ${xaiLike.stderr.slice(0, 240)})`);
  assert(!/proxy\s+starting/.test(xaiLike.stderr),
    `non-native Anthropic-shape bypass rejection does not start a proxy`);

  const unresolved = runCthru(['--bypass-proxy', '--model', 'unmapped-test-model'], {
    backends: {
      anthropic: { kind: 'anthropic', url: 'https://api.anthropic.com' },
    },
    model_routes: {},
  });
  assert(unresolved.code !== 0,
    `unmapped bypass fails before launching Claude (got ${unresolved.code})`);
  assert(/select a model mapped to the native Anthropic API/.test(unresolved.stderr),
    `unmapped bypass explains the native route requirement (stderr: ${unresolved.stderr.slice(0, 240)})`);
  assert(!/proxy\s+starting/.test(unresolved.stderr),
    `unmapped bypass rejection does not start a proxy`);
}

// ── Test 10: --journal ────────────────────────────────────────────────────
console.log('\n10. --journal → CLAUDE_PROXY_JOURNAL=1, stripped from args');
{
  const r = runCthru(['--journal', '--model', 'claude-sonnet-5']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--journal'), `--journal stripped`);
  assert(r.json?.claude_proxy_journal === '1', `CLAUDE_PROXY_JOURNAL=1`);
}

// ── Test 11: --no-update ──────────────────────────────────────────────────
console.log('\n11. --no-update → C_THRU_NO_UPDATE=1, stripped');
{
  const r = runCthru(['--no-update', '--model', 'claude-sonnet-5']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--no-update'), `--no-update stripped`);
  assert(r.json?.c_thru_no_update === '1', `C_THRU_NO_UPDATE=1`);
}

// ── Test 12: --proxy-debug 2 ──────────────────────────────────────────────
console.log('\n12. --proxy-debug 2 → CLAUDE_PROXY_DEBUG=2, both flag and value stripped');
{
  const r = runCthru(['--proxy-debug', '2', '--model', 'claude-sonnet-5']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--proxy-debug'), `--proxy-debug stripped`);
  assert(!args.includes('2'), `value '2' stripped`);
  assert(r.json?.claude_proxy_debug === '2', `CLAUDE_PROXY_DEBUG=2 (got ${JSON.stringify(r.json?.claude_proxy_debug)})`);
}

// ── Test 13: --proxy-debug (no value) defaults to 1 ───────────────────────
console.log('\n13. --proxy-debug (no value) → CLAUDE_PROXY_DEBUG=1');
{
  const r = runCthru(['--proxy-debug', '--model', 'claude-sonnet-5']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--proxy-debug'), `--proxy-debug stripped`);
  assert(r.json?.claude_proxy_debug === '1', `default CLAUDE_PROXY_DEBUG=1`);
}

// ── Test 14: --router-debug=2 (= form) ────────────────────────────────────
console.log('\n14. --router-debug=2 → C_THRU_DEBUG=2');
{
  const r = runCthru(['--router-debug=2', '--model', 'claude-sonnet-5']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.some(x => x.startsWith('--router-debug')), `--router-debug=... stripped`);
  assert(r.json?.claude_router_debug === '2', `CLAUDE_ROUTER_DEBUG=2`);
}

// ── Test 15: --memory-gb 32 ───────────────────────────────────────────────
console.log('\n15. --memory-gb 32 → CLAUDE_LLM_MEMORY_GB=32, stripped');
{
  const r = runCthru(['--memory-gb', '32', '--model', 'claude-sonnet-5']);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  const args = r.json?.args || [];
  assert(!args.includes('--memory-gb'), `--memory-gb stripped`);
  assert(!args.includes('32'), `value '32' stripped`);
  assert(r.json?.claude_llm_memory_gb === '32', `CLAUDE_LLM_MEMORY_GB=32`);
}

// ── Test 15b: --anthropic-upstream (A1 loopback + export override) ────────
console.log('\n15b. --anthropic-upstream → export override; Claude BASE_URL loopback; flag stripped');
{
  const gw = 'https://llm-gateway.example.com/anthropic';
  const r = runCthru(['--anthropic-upstream', gw, '--model', 'claude-sonnet-5'], {
    backends: {
      anthropic: { kind: 'anthropic', url: 'https://api.anthropic.com' },
    },
  });
  assert(r.code === 0, `exit 0 (got ${r.code}; stderr=${(r.stderr || '').slice(0, 200)})`);
  const args = r.json?.args || [];
  assert(!args.includes('--anthropic-upstream'), `--anthropic-upstream stripped`);
  assert(!args.includes(gw), `gateway URL not in Claude argv`);
  const base = r.json?.anthropic_base_url || '';
  assert(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(base),
    `Claude ANTHROPIC_BASE_URL is loopback (got ${base})`);
  assert(String(r.json?.claude_proxy_anthropic_upstream || '').includes('llm-gateway.example.com'),
    `CLAUDE_PROXY_ANTHROPIC_UPSTREAM exported (got ${r.json?.claude_proxy_anthropic_upstream})`);
  assert(!!r.json?.c_thru_anthropic_upstream_fingerprint,
    'C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT exported');
  assert(/Loose policy|upstream override/i.test(r.stderr || ''),
    'Loose OAuth warn on stderr');
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
  const r = runCthru(['--journal', '--proxy-debug', '1', '--no-update', '--model', 'claude-sonnet-5']);
  assert(r.code === 0, `exit 0`);
  assert(r.json?.claude_proxy_journal === '1', 'journal env');
  assert(r.json?.claude_proxy_debug === '1', 'proxy-debug env');
  assert(r.json?.c_thru_no_update === '1', 'no-update env');
  const args = r.json?.args || [];
  for (const f of ['--journal', '--proxy-debug', '--no-update']) {
    assert(!args.includes(f), `${f} stripped`);
  }
}

// ── Test 18 (C1 + C2): ephemeral --settings shape + one-line system-prompt pointer ──
// Single ollama-backed run (forces a proxy spawn → PROXY_PORT set → the one-line
// pointer is appended and --settings is forwarded). Asserts BOTH the settings
// file shape (C1: one command SessionStart hook, no http hook) AND the
// append-system-prompt drift guard (C2: one-line pointer, not the old endpoint
// list). CLAUDE_PROXY_STARTUP_PROBE=0 (set in runCthru) keeps it hermetic.
console.log('\n18. (C1/C2) ollama-backed run: ephemeral --settings shape + system-prompt pointer');
{
  const r = runCthru(['--model', 'qwen3:1.7b'], {
    backends: { ollama: { kind: 'ollama', url: 'http://127.0.0.1:11434' } },
    routes: { default: 'qwen3:1.7b' },
    model_routes: { 'qwen3:1.7b': 'ollama' },
  });
  assert(r.code === 0, `exit 0 (got ${r.code}, stderr: ${r.stderr.slice(0, 200)})`);
  const args = r.json?.args || [];

  // ── C1: the launcher forwarded --settings, and the file is valid JSON ──────
  assert(args.includes('--settings'), `--settings forwarded to claude (got ${formatArgs(args)})`);
  let settings = null;
  try { settings = JSON.parse(r.json?.settings_content || ''); } catch {}
  assert(settings !== null,
    `--settings file is valid JSON (got ${JSON.stringify((r.json?.settings_content || '').slice(0, 120))})`);
  if (settings) {
    const ssHooks = (settings.hooks?.SessionStart || []).flatMap(e => e.hooks || []);
    assert(ssHooks.length === 1, `SessionStart has exactly one hook (got ${ssHooks.length}: ${JSON.stringify(ssHooks)})`);
    assert(ssHooks[0]?.type === 'command', `SessionStart hook is type:"command" (got ${JSON.stringify(ssHooks[0]?.type)})`);
    assert(/c-thru-session-start/.test(ssHooks[0]?.command || ''),
      `SessionStart command → c-thru-session-start (got ${ssHooks[0]?.command})`);
    // No HTTP SessionStart hook anywhere — the redundant one was removed.
    const allHooks = Object.values(settings.hooks || {}).flat().flatMap(e => e.hooks || []);
    const httpHooks = allHooks.filter(h => h?.type === 'http');
    assert(httpHooks.length === 0, `no type:"http" hook anywhere (got ${JSON.stringify(httpHooks)})`);
    // The rest of the ephemeral surface survives the trim.
    assert(settings.mcpServers && typeof settings.mcpServers === 'object', 'mcpServers present');
    assert(Array.isArray(settings.hooks?.UserPromptSubmit), 'UserPromptSubmit hooks present');
    assert(Array.isArray(settings.hooks?.PostToolUse), 'PostToolUse hooks present');
    assert(Array.isArray(settings.hooks?.PreToolUse), 'PreToolUse hooks present');
    assert(settings.permissions && Array.isArray(settings.permissions.allow), 'permissions.allow present');
  }

  // ── C2: --append-system-prompt is the one-line pointer (drift guard) ───────
  const ai = args.indexOf('--append-system-prompt');
  assert(ai >= 0, `--append-system-prompt present (got ${formatArgs(args)})`);
  const sysPrompt = ai >= 0 ? (args[ai + 1] || '') : '';
  assert(/see SessionStart context for endpoints/.test(sysPrompt),
    `pointer references SessionStart context (got ${JSON.stringify(sysPrompt.slice(0, 200))})`);
  assert(/http:\/\/127\.0\.0\.1:\d+/.test(sysPrompt),
    `pointer carries the proxy base URL (got ${JSON.stringify(sysPrompt.slice(0, 200))})`);
  // The old per-endpoint list must NOT reappear in-band — this is the drift guard.
  assert(!/Use curl from Bash/.test(sysPrompt), 'no old "Use curl from Bash" endpoint list (drift guard)');
  assert(!/switch routing mode/.test(sysPrompt), 'no old "switch routing mode" line (drift guard)');

  // ── C2 (positive invariant): the in-band pointer is exactly one canonical line ──
  // The denylist above catches the OLD endpoint list reappearing; this asserts
  // the pointer's exact shape so a multi-line expansion or a re-added endpoint
  // enumeration trips the test even if it uses new wording. Mirrors c-thru:3669.
  const promptLines = sysPrompt.split('\n');
  const pointerLines = promptLines.filter(l => l.includes('proxy control plane'));
  assert(pointerLines.length === 1,
    `exactly one 'proxy control plane' line in-band (got ${pointerLines.length}: ${JSON.stringify(pointerLines)})`);
  assert(pointerLines.length === 1 &&
    /^c-thru proxy control plane: http:\/\/127\.0\.0\.1:\d+ — see SessionStart context for endpoints$/.test(pointerLines[0]),
    `pointer line matches the canonical one-line form (got ${JSON.stringify(pointerLines[0])})`);
  // Identity/ops tip may cite GET /c-thru/recent once as proof channel.
  // Drift guard: multi-endpoint catalog lines (status+recent+dashboard) must stay out of band.
  assert(!promptLines.some(l => ((l.match(/GET \/c-thru\//g) || []).length >= 2)),
    'no multi-endpoint enumeration (GET /c-thru/...) leaked in-band (drift guard)');

  // Injected claude options must stay before the first positional/subcommand.
  const positionalRun = runCthru(['--model=claude-sonnet-5', 'agents']);
  assert(positionalRun.code === 0,
    `positional run exits 0 (got ${positionalRun.code}, stderr: ${positionalRun.stderr.slice(0, 200)})`);
  const positionalArgs = positionalRun.json?.args || [];
  const positionalIndex = positionalArgs.indexOf('agents');
  assert(positionalIndex >= 0, `positional 'agents' forwarded (got ${JSON.stringify(positionalArgs)})`);
  for (const flag of ['--append-system-prompt', '--settings', '--agents']) {
    const flagIndex = positionalArgs.indexOf(flag);
    if (flagIndex >= 0) {
      assert(flagIndex < positionalIndex,
        `${flag} appears before positional 'agents' (got ${JSON.stringify(positionalArgs)})`);
    }
  }

  const promptText = 'cthru-ordering-regression-prompt-7c6f';
  const promptRun = runCthru(['-p', promptText]);
  assert(promptRun.code === 0,
    `-p prompt run exits 0 (got ${promptRun.code}, stderr: ${promptRun.stderr.slice(0, 200)})`);
  const promptArgs = promptRun.json?.args || [];
  const promptFlagIndex = promptArgs.indexOf('-p');
  const promptValueIndex = promptArgs.indexOf(promptText);
  assert(promptFlagIndex >= 0 && promptValueIndex === promptFlagIndex + 1,
    `-p prompt value remains adjacent to -p (got ${JSON.stringify(promptArgs)})`);

  const explicitModel = 'claude-sonnet-5';
  const modelPromptText = 'cthru-ordering-regression-model-prompt-25b4';
  const modelPromptRun = runCthru(['--model', explicitModel, '-p', modelPromptText]);
  assert(modelPromptRun.code === 0,
    `two-word --model prompt run exits 0 (got ${modelPromptRun.code}, stderr: ${modelPromptRun.stderr.slice(0, 200)})`);
  const modelPromptArgs = modelPromptRun.json?.args || [];
  const modelFlagIndex = modelPromptArgs.indexOf('--model');
  const modelValueIndex = modelPromptArgs.indexOf(explicitModel);
  assert(modelFlagIndex >= 0 && modelValueIndex === modelFlagIndex + 1,
    `two-word --model value remains adjacent, with no injected option between flag and value (got ${JSON.stringify(modelPromptArgs)})`);
}

// ── Test 19: inbound OLLAMA_URL is honored (precedence regression) ─────────
// c-thru:49 must NOT clobber a caller-set OLLAMA_URL. The --router-debug=2 env
// dump (c-thru:3489) prints "OLLAMA_URL=<value>" to stderr. Pass a distinctive
// closed-port URL inbound and assert it survives verbatim — pre-fix, line 49
// (`${OLLAMA_BASE_URL:-http://localhost:11434}`) would overwrite it with the
// localhost:11434 default, so this test would print/assert that instead.
console.log('\n19. inbound OLLAMA_URL honored (not clobbered by line 49)');
{
  const inbound = 'http://127.0.0.1:1';   // closed port — distinctive, never the default
  const r = runCthru(['--router-debug=2', '--model', 'claude-sonnet-5'], {}, { OLLAMA_URL: inbound });
  assert(r.code === 0, `exit 0 (got ${r.code}, stderr: ${r.stderr.slice(0, 200)})`);
  assert(r.stderr.includes(`OLLAMA_URL=${inbound}`),
    `--router-debug=2 dump echoes inbound OLLAMA_URL=${inbound} (got stderr: ${r.stderr.slice(-400)})`);
  assert(!/OLLAMA_URL=http:\/\/localhost:11434/.test(r.stderr),
    'inbound OLLAMA_URL not overwritten by the localhost:11434 default');
}

// ── Test 20: a launch leaves the DURABLE ~/.claude/settings.json untouched ──
// The inline-override invariant: ephemeral session settings are written to a
// temp session dir, NEVER the user's real settings.json. This is a tripwire —
// it fails if a future change repoints the ephemeral write at the durable dir.
console.log('\n20. launch leaves durable ~/.claude/settings.json byte-identical + mtime-unchanged');
{
  const sentinel = JSON.stringify({ env: { C_THRU_SENTINEL: 'durable-must-not-change' } }, null, 2);
  const r = runCthru(['--route', 'heavy'], {}, {}, { keepSandbox: true, seedSettings: sentinel });
  try {
    assert(r.code === 0, `launch exit 0 (got ${r.code}, stderr: ${r.stderr.slice(0, 160)})`);
    const after = fs.readFileSync(r.durableSettings, 'utf8');
    assert(after === sentinel, 'durable settings.json is byte-identical after a launch (ephemeral write must not touch it)');
    const afterMtimeMs = fs.statSync(r.durableSettings).mtimeMs;
    assert(afterMtimeMs === r.seedMtimeMs, `durable settings.json mtime unchanged (seed ${r.seedMtimeMs}, after ${afterMtimeMs})`);
  } finally {
    try { fs.rmSync(r.tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── Test 21 (F1): --dangerously-skip-permissions is opt-in ──────────────────
// c-thru no longer auto-prepends it; it is forwarded only when the user passes
// it, and de-duplicated if passed multiple times. Default posture = prompts on.
console.log('\n21. (F1) --dangerously-skip-permissions is opt-in (absent by default, deduped when passed)');
{
  // 21a: absent by default
  const r0 = runCthru(['--model', 'claude-sonnet-5']);
  assert(r0.code === 0, `21a exit 0 (got ${r0.code}, stderr: ${r0.stderr.slice(0, 200)})`);
  const a0 = r0.json?.args || [];
  const cnt0 = a0.filter(a => a === '--dangerously-skip-permissions').length;
  assert(cnt0 === 0, `21a flag absent by default (got ${cnt0} in ${JSON.stringify(a0)})`);

  // 21b: present exactly once when passed once
  const r1 = runCthru(['--dangerously-skip-permissions', '--model', 'claude-sonnet-5']);
  assert(r1.code === 0, `21b exit 0 (got ${r1.code})`);
  const a1 = r1.json?.args || [];
  const cnt1 = a1.filter(a => a === '--dangerously-skip-permissions').length;
  assert(cnt1 === 1, `21b flag present exactly once when passed once (got ${cnt1} in ${JSON.stringify(a1)})`);

  // 21c: deduped when passed multiple times
  const r2 = runCthru(['--dangerously-skip-permissions', '--dangerously-skip-permissions', '--dangerously-skip-permissions', '--model', 'claude-sonnet-5']);
  assert(r2.code === 0, `21c exit 0 (got ${r2.code})`);
  const a2 = r2.json?.args || [];
  const cnt2 = a2.filter(a => a === '--dangerously-skip-permissions').length;
  assert(cnt2 === 1, `21c flag deduped to exactly one when passed thrice (got ${cnt2} in ${JSON.stringify(a2)})`);
}

// ── Test 22 (F2): transparent (no-model) path injects --settings/--agents/--append-system-prompt ──
// The no-model path used to forward raw ORIG_ARGS, dropping the ephemeral
// settings/agents/system-prompt despite building them. Now it routes through
// build_forwarded_args like the routed path. Config has NO default route so
// MODEL stays empty and the transparent path is taken; ollama backend forces a
// proxy spawn so PROXY_PORT is set and the in-band pointer is appended.
console.log('\n22. (F2) transparent no-model path forwards --settings/--agents/--append-system-prompt');
{
  const r = runCthru(['-p', 'hello'], {
    backends: { ollama: { kind: 'ollama', url: 'http://127.0.0.1:11434' } },
    routes: {},  // no default → MODEL empty → transparent path
    model_routes: { 'qwen3:1.7b': 'ollama' },
  });
  assert(r.code === 0, `exit 0 (got ${r.code}, stderr: ${r.stderr.slice(0, 200)})`);
  assert(r.json !== null, `stub claude received args (stdout: ${r.stdout.slice(0, 200)})`);
  const args = r.json?.args || [];
  assert(args.includes('--settings'),
    `--settings forwarded on transparent path (got ${JSON.stringify(args.slice(0, 12))}…)`);
  assert(args.includes('--append-system-prompt'),
    `--append-system-prompt forwarded on transparent path (got ${JSON.stringify(args.slice(0, 12))}…)`);
  // --agents is forwarded when the agents dir yields a non-empty map (it does —
  // the repo ships agents/*.md and setup_ephemeral_session reads them).
  assert(args.includes('--agents'),
    `--agents forwarded on transparent path (got ${JSON.stringify(args.slice(0, 12))}…)`);
  // The user's -p and prompt text still pass through.
  assert(args.includes('-p'), `user -p flag passes through (got ${formatArgs(args)})`);
  assert(args.includes('hello'), `user prompt text passes through (got ${formatArgs(args)})`);
}

// ── Test 23 (F2.1): --print-routing on the transparent path is a dry-run ───
// With no model/default-route, --print-routing must NOT launch a session or
// spawn a proxy; it prints a dry-run line and exits 0. The stub claude must
// not be invoked (no JSON on stdout).
console.log('\n23. (F2.1) --print-routing (no model) is a dry-run — no launch, no stub call');
{
  const r = runCthru(['--print-routing'], {
    backends: { ollama: { kind: 'ollama', url: 'http://127.0.0.1:11434' } },
    routes: {},  // no default → transparent path
    model_routes: { 'qwen3:1.7b': 'ollama' },
  });
  assert(r.code === 0, `exit 0 (got ${r.code}, stderr: ${r.stderr.slice(0, 200)})`);
  assert(r.json === null,
    `stub claude NOT invoked (no JSON on stdout; got: ${r.stdout.slice(0, 120)})`);
  assert(/dry-run|proxy\/session NOT started/.test(r.stderr),
    `stderr carries the dry-run notice (got stderr: ${r.stderr.slice(0, 200)})`);
}

// ── Test 24 (F4): bare value-taking c-thru flags don't swallow a following flag ──
// --model/--route/--mode/--profile/--memory-gb, when given with no explicit
// value (immediately followed by another flag), must NOT consume that flag as
// their value. Before the fix, `c-thru --model --print hello` would swallow
// `--print` as the model name; now --model is treated as valueless and falls
// back to routes.default, while --print and the prompt text pass through.
console.log('\n24. (F4) bare --model/--route/--mode/--profile don\'t swallow a following flag');
{
  // 24a: --model --print hello → --model treated as valueless (falls back to
  // routes.default, which build_forwarded_args re-injects), --print/hello pass
  // through untouched rather than "--print" being swallowed as the model name.
  const r0 = runCthru(['--model', '--print', 'hello']);
  assert(r0.code === 0, `24a exit 0 (got ${r0.code}, stderr: ${r0.stderr.slice(0, 200)})`);
  const a0 = r0.json?.args || [];
  assert(a0.includes('--print'), `24a --print not swallowed as model value (got ${JSON.stringify(a0)})`);
  assert(a0.includes('hello'), `24a prompt text passes through (got ${JSON.stringify(a0)})`);
  assert(a0.includes('claude-sonnet-5'),
    `24a falls back to routes.default model, not '--print' (got ${JSON.stringify(a0)})`);

  // 24b: --route --print hello → falls back to routes.default, --print/hello pass through
  const r1 = runCthru(['--route', '--print', 'hello']);
  assert(r1.code === 0, `24b exit 0 (got ${r1.code}, stderr: ${r1.stderr.slice(0, 200)})`);
  const a1 = r1.json?.args || [];
  assert(a1.includes('--print'), `24b --print not swallowed as route value (got ${JSON.stringify(a1)})`);
  assert(a1.includes('hello'), `24b prompt text passes through (got ${JSON.stringify(a1)})`);

  // 24c: --mode --print hello → --mode requires a value and errors out (guard
  // treats --print as flag-like, so no value follows); asserts it does NOT
  // silently set CLAUDE_LLM_MODE=--print.
  const r2 = runCthru(['--mode', '--print', 'hello', '--model', 'claude-sonnet-5']);
  assert(r2.code !== 0, `24c --mode with no value (flag-like next token) errors out (got exit ${r2.code})`);
  assert(!/CLAUDE_LLM_MODE=--print/.test(r2.stderr || ''),
    `24c CLAUDE_LLM_MODE never set to '--print' (got stderr: ${r2.stderr.slice(0, 200)})`);

  // 24d: --profile --print hello → same guard, same error-out contract
  const r3 = runCthru(['--profile', '--print', 'hello', '--model', 'claude-sonnet-5']);
  assert(r3.code !== 0, `24d --profile with no value (flag-like next token) errors out (got exit ${r3.code})`);

  // 24e: --memory-gb --print hello → silently valueless (matches original
  // no-value behavior), --print/hello pass through untouched.
  const r4 = runCthru(['--memory-gb', '--print', 'hello', '--model', 'claude-sonnet-5']);
  assert(r4.code === 0, `24e exit 0 (got ${r4.code}, stderr: ${r4.stderr.slice(0, 200)})`);
  const a4 = r4.json?.args || [];
  assert(a4.includes('--print'), `24e --print not swallowed as memory-gb value (got ${JSON.stringify(a4)})`);
  assert(r4.json?.claude_llm_memory_gb === null,
    `24e CLAUDE_LLM_MEMORY_GB not set (got ${JSON.stringify(r4.json?.claude_llm_memory_gb)})`);

  // 24f (regression guard): legitimate values still work normally.
  const r5 = runCthru(['--model', 'claude-opus-4-6', '--memory-gb', '64']);
  assert(r5.code === 0, `24f exit 0 (got ${r5.code}, stderr: ${r5.stderr.slice(0, 200)})`);
  assert(r5.json?.claude_llm_memory_gb === '64',
    `24f legitimate --memory-gb 64 still works (got ${JSON.stringify(r5.json?.claude_llm_memory_gb)})`);
}

// ── Test 25: caller --agents payloads reconcile with the ephemeral fleet ──
console.log('\n25. caller --agents payloads merge with the c-thru fleet');
{
  const getAgents = r => r.json?.agents_occurrences || [];
  const parse = occurrence => JSON.parse(occurrence.value);

  const a = runCthru(['--agents', '{"myrev":{"description":"d","prompt":"p"}}', '-p', 'hi']);
  const aa = getAgents(a);
  assert(a.code === 0, `25a inline payload exit 0 (got ${a.code}, stderr: ${a.stderr.slice(0, 200)})`);
  assert(aa.length === 1 && parse(aa[0]).myrev && parse(aa[0]).coder,
    `25a merged inline agents contain caller and fleet (got ${formatArgs(aa)})`);

  const b = runCthru(['--no-agents', '--agents', '{"myrev":{"description":"d","prompt":"p"}}']);
  const ba = getAgents(b);
  assert(b.code === 0, `25b --no-agents caller payload exit 0 (got ${b.code}, stderr: ${b.stderr.slice(0, 200)})`);
  assert(ba.length === 1 && parse(ba[0]).myrev && !parse(ba[0]).coder,
    `25b --no-agents suppresses fleet but preserves caller (got ${formatArgs(ba)})`);

  const agentsFileDir = makeIsolatedTmpDir('c-thru-agents-file-');
  const agentsFile = path.join(agentsFileDir, 'caller-agents.json');
  fs.writeFileSync(agentsFile, JSON.stringify({ fromFile: { description: 'file' } }));
  const c = runCthru(['--agents', agentsFile]);
  const ca = getAgents(c);
  assert(c.code === 0 && ca.length === 1 && parse(ca[0]).fromFile && parse(ca[0]).coder,
    `25c absolute file --agents payload merges with fleet (got ${formatArgs(ca)})`);
  fs.rmSync(agentsFileDir, { recursive: true, force: true });

  const d = runCthru(['--agents', '{"rev":{"description":"A"}}', '--agents', '{"rev":{"description":"B"}}']);
  const da = getAgents(d);
  assert(d.code === 0 && da.length === 1 && parse(da[0]).rev?.description === 'B',
    `25d later caller --agents payload wins (got ${JSON.stringify(da)})`);

  const e = runCthru(['--agents', 'not-json']);
  const ea = getAgents(e);
  assert(e.code === 0 && ea.length === 2 && parse(ea[0]).coder && ea[1].value === 'not-json',
    `25e invalid payload keeps fleet injection first and raw flag second (got ${JSON.stringify(ea)})`);

  const eEquals = runCthru(['--agents=not-json']);
  const eea = getAgents(eEquals);
  assert(eEquals.code === 0 && eea.length === 2 && parse(eea[0]).coder &&
    eea[1].form === 'equals' && eea[1].value === 'not-json',
    `25e equals-form invalid payload keeps fleet injection and raw flag (got ${JSON.stringify(eea)})`);

  const e2 = runCthru(['--agents', '{"myrev":{"description":"d"}}', '--agents', 'not-json']);
  const e2a = getAgents(e2);
  assert(e2.code === 0 && e2a.length === 2 && parse(e2a[0]).coder && parse(e2a[0]).myrev && e2a[1].value === 'not-json',
    `25e2 mixed payload keeps merged caller/fleet first and raw invalid second (got ${JSON.stringify(e2a)})`);

  const f = runCthru(
    ['--bypass-proxy', '--agents', '{"x":{"description":"d"}}',
      '--settings', '{"permissions":{"allow":["Read"]}}'],
    {
      backends: {
        anthropic: { kind: 'anthropic', url: 'https://api.anthropic.com' },
      },
    },
  );
  const fa = getAgents(f);
  assert(f.code === 0 && fa.length === 1 && fa[0].form === 'space' && fa[0].value === '{"x":{"description":"d"}}',
    `25f bypass forwards caller --agents untouched (got ${JSON.stringify(fa)})`);
  assert(f.json?.settings_content === '{"permissions":{"allow":["Read"]}}',
    `25f bypass forwards caller --settings untouched (got ${JSON.stringify(f.json?.settings_content)})`);
  assert(!/proxy\s+starting/.test(f.stderr),
    `25f bypass does not start a proxy (stderr: ${f.stderr.slice(0, 200)})`);
  const fModelFlags = (f.json?.args || []).filter(
    arg => arg === '--model' || arg.startsWith('--model='),
  );
  assert(fModelFlags.length === 1 && !f.json?.args?.includes('--bypass-proxy'),
    `25f default-route bypass forwards one resolved model and strips private flags (got ${JSON.stringify(fModelFlags)})`);

  const fEquals = runCthru(
    ['--bypass-proxy', '--model', 'claude-sonnet-5',
      '--agents={"y":{"description":"eq"}}',
      '--settings={"permissions":{"allow":["Glob"]}}'],
    {
      backends: {
        anthropic: { kind: 'anthropic', url: 'https://api.anthropic.com' },
      },
    },
  );
  const fea = getAgents(fEquals);
  const fEqualsModelFlags = (fEquals.json?.args || []).filter(
    arg => arg === '--model' || arg.startsWith('--model='),
  );
  assert(fEquals.code === 0 && fea.length === 1 && fea[0].form === 'equals' &&
    fea[0].value === '{"y":{"description":"eq"}}',
  `25f equals-form bypass forwards caller --agents untouched (got ${JSON.stringify(fea)})`);
  assert(fEquals.json?.settings_content === '{"permissions":{"allow":["Glob"]}}',
    `25f equals-form bypass forwards caller --settings untouched (got ${JSON.stringify(fEquals.json?.settings_content)})`);
  assert(fEqualsModelFlags.length === 1 && !fEquals.json?.args?.includes('--bypass-proxy') &&
    !/proxy\s+starting/.test(fEquals.stderr),
  `25f explicit-model equals-form bypass forwards one model, strips private flags, and starts no proxy (got ${JSON.stringify(fEqualsModelFlags)})`);

  const g0 = runCthru(['--agents']);
  assert(g0.code !== 0 && /c-thru: --agents requires a value/.test(g0.stderr),
    `25g bare --agents is rejected as valueless (got exit ${g0.code}, stderr: ${g0.stderr.slice(0, 200)})`);
  const g1 = runCthru(['--agents', '--print', 'hello']);
  assert(g1.code !== 0 && /c-thru: --agents requires a value/.test(g1.stderr),
    `25g --agents does not swallow --print as its value (got exit ${g1.code}, stderr: ${g1.stderr.slice(0, 200)})`);
}
}

function runCoordinatorCthru(args, configOverrides = {}, envOverrides = {}, opts = {}) {
  return runCthru(args, configOverrides, {
    ...envOverrides,
    C_THRU_PROXY_ALWAYS: '0',
  }, opts);
}

// ── Test 26: opt-in session coordinator and precedence contract ────────────
console.log('\n26. opt-in coordinator stays outside routed fleet and preserves precedence');
{
  const parseJson = value => {
    try { return JSON.parse(value || ''); } catch { return null; }
  };
  const fleet = result => {
    const occurrence = (result.json?.agents_occurrences || [])[0];
    return parseJson(occurrence?.value) || {};
  };
  const coordinatorSource = path.join(__dirname, '..', 'session-agents', 'c-thru-coordinator.md');
  const coordinatorText = fs.readFileSync(coordinatorSource, 'utf8');
  const toolsMatch = coordinatorText.match(/^tools:\s*Agent\(([^)]*)\)\s*$/m);
  const coordinatorTools = (toolsMatch?.[1] || '').split(',').map(value => value.trim()).filter(Boolean).sort();
  const reservedAgentFiles = new Set(['AGENTS.md', 'CLAUDE.md']);
  const routedRoster = fs.readdirSync(path.join(__dirname, '..', 'agents'))
    .filter(name => name.endsWith('.md') && !reservedAgentFiles.has(name))
    .map(name => name.replace(/\.md$/, ''))
    .sort();
  assert(/^model:\s*inherit\s*$/m.test(coordinatorText) &&
    toolsMatch && JSON.stringify(coordinatorTools) === JSON.stringify(routedRoster) &&
    coordinatorTools.length >= 28 && !coordinatorTools.includes('c-thru-coordinator'),
  `26a coordinator inherits the session model and tools allowlist is exactly the N routed agents (got ${coordinatorTools.length})`);
  assert(/Mandatory named-brand routing/.test(coordinatorText) &&
    /`deepseek` means Agent `deepseek`/.test(coordinatorText) &&
    /`gemini` or `google gemini` means Agent `gemini`/.test(coordinatorText) &&
    /first and only delegation/.test(coordinatorText) &&
    /without first searching for inputs, inspecting the workspace, validating whether the referenced artifact exists, or invoking any helper/.test(coordinatorText) &&
    /Never answer the named-model request inline/.test(coordinatorText),
  '26a explicit brand requests prohibit helper or generic-agent preflight');
  assert(/`tester`: run or write tests; check behavior; verify correctness; cover edge cases/.test(coordinatorText) &&
    /`code-reviewer`: review code, a diff, or a pull request/.test(coordinatorText) &&
    /`reviewer-plan`: decide whether an existing plan is ready/.test(coordinatorText) &&
    /`docs`: help text, usage blurbs, reference docs, inline comments, doc blocks/.test(coordinatorText),
  '26a task-trigger table covers observed tester, review, plan-review, and docs boundaries');

  const defaultOff = runCoordinatorCthru(['-p', 'hello']);
  assert(defaultOff.code === 0 && defaultOff.json?.c_thru_coordinator_active === null &&
    defaultOff.json?.physical_settings_content === null &&
    defaultOff.json?.coordinator_agent_is_symlink === false,
  '26a coordinator defaults off with no physical settings or session-agent link');

  const envOn = runCoordinatorCthru(['-p', 'hello'], {}, { C_THRU_COORDINATOR: '1' });
  const envPhysical = parseJson(envOn.json?.physical_settings_content);
  const envInline = parseJson(envOn.json?.settings_content);
  const envFleet = fleet(envOn);
  assert(envOn.code === 0 && envOn.json?.c_thru_coordinator_active === '1',
    `26b env opt-in activates coordinator (got exit ${envOn.code}, stderr: ${envOn.stderr.slice(0, 200)})`);
  assert(envPhysical?.agent === 'c-thru-coordinator' &&
    envPhysical?.permissions?.deny?.includes('Agent(c-thru-coordinator)'),
  `26b low-priority physical settings selects and self-denies coordinator (got ${JSON.stringify(envPhysical)})`);
  assert(envInline?.permissions?.deny?.includes('Agent(c-thru-coordinator)'),
    `26b inline merge reinforces self-deny only while trusted coordinator is active (got ${JSON.stringify(envInline?.permissions)})`);
  assert(envOn.json?.coordinator_agent_is_symlink === true &&
    envOn.json?.coordinator_agent_realpath === fs.realpathSync(coordinatorSource),
  `26b coordinator source is linked into ephemeral agents (got ${JSON.stringify(envOn.json?.coordinator_agent_realpath)})`);
  assert(Object.keys(envFleet).length >= 28 && !envFleet['c-thru-coordinator'],
    `26b routed fleet remains fleet agents and excludes coordinator (got ${Object.keys(envFleet).length})`);

  const flagOn = runCoordinatorCthru(['--coordinator', '-p', 'hello']);
  assert(flagOn.code === 0 && flagOn.json?.c_thru_coordinator_active === '1' &&
    !(flagOn.json?.args || []).includes('--coordinator'),
  `26c private --coordinator opts in and is stripped (got ${formatArgs(flagOn.json?.args)})`);

  const forcedOff = runCoordinatorCthru(['--no-coordinator', '-p', 'hello'], {}, { C_THRU_COORDINATOR: '1' });
  assert(forcedOff.code === 0 && forcedOff.json?.c_thru_coordinator_active === null &&
    forcedOff.json?.physical_settings_content === null &&
    !(forcedOff.json?.args || []).includes('--no-coordinator'),
  '26d --no-coordinator overrides env opt-in and is stripped');

  for (const [label, agentArgs] of [
    ['spaced', ['--agent', 'coder']],
    ['equals', ['--agent=coder']],
  ]) {
    const result = runCoordinatorCthru([...agentArgs, '-p', 'hello'], {}, { C_THRU_COORDINATOR: '1' });
    const args = result.json?.args || [];
    const preserved = label === 'spaced'
      ? args.includes('--agent') && args.includes('coder')
      : args.includes('--agent=coder');
    assert(result.code === 0 && result.json?.c_thru_coordinator_active === '1' && preserved,
      `26e caller --agent ${label} form is preserved and naturally outranks physical default (got ${formatArgs(args)})`);
  }

  const userWins = runCoordinatorCthru(['-p', 'hello'], {}, { C_THRU_COORDINATOR: '1' }, {
    seedSettings: JSON.stringify({
      agent: 'user-agent',
      permissions: { deny: ['Bash(dangerous *)'] },
    }),
  });
  const userInline = parseJson(userWins.json?.settings_content);
  assert(userWins.code === 0 && parseJson(userWins.json?.physical_settings_content)?.agent === 'c-thru-coordinator' &&
    userInline?.agent === 'user-agent' &&
    userInline?.permissions?.deny?.includes('Bash(dangerous *)') &&
    userInline?.permissions?.deny?.includes('Agent(c-thru-coordinator)'),
  `26f existing user inline layer wins agent key while permission denies merge (got ${JSON.stringify(userInline)})`);

  const callerWins = runCoordinatorCthru(
    ['--settings', '{"agent":"caller-agent"}', '-p', 'hello'],
    {},
    { C_THRU_COORDINATOR: '1' },
  );
  assert(callerWins.code === 0 && parseJson(callerWins.json?.settings_content)?.agent === 'caller-agent',
    `26g caller --settings agent wins physical coordinator default (got ${JSON.stringify(callerWins.json?.settings_content)})`);

  const opaque = runCoordinatorCthru(['--', '--no-coordinator'], {}, { C_THRU_COORDINATOR: '1' });
  assert(opaque.code === 0 && opaque.json?.c_thru_coordinator_active === '1' &&
    (opaque.json?.args || []).includes('--no-coordinator'),
  `26h -- makes later private-looking tokens opaque (got ${formatArgs(opaque.json?.args)})`);
}

// ── Test 27: coordinator collision and incompatible launch boundaries ──────
console.log('\n27. coordinator disables cleanly on collisions and incompatible launch modes');
{
  const parseJson = value => {
    try { return JSON.parse(value || ''); } catch { return null; }
  };
  const collision = runCoordinatorCthru(
    ['--agents', '{"c-thru-coordinator":{"description":"caller-owned","prompt":"caller"}}', '-p', 'hello'],
    {},
    { C_THRU_COORDINATOR: '1' },
  );
  const collisionInline = parseJson(collision.json?.settings_content);
  const collisionFleet = parseJson(collision.json?.agents_occurrences?.[0]?.value);
  assert(collision.code === 0 && collision.json?.c_thru_coordinator_active === null &&
    collision.json?.physical_settings_content === null &&
    collisionFleet?.['c-thru-coordinator']?.description === 'caller-owned',
  '27a caller reserved-name collision disables auto coordinator but preserves caller definition');
  assert(/caller --agents defines reserved name 'c-thru-coordinator'; coordinator disabled/.test(collision.stderr),
    `27a reserved-name collision emits warning (got ${collision.stderr.slice(0, 240)})`);
  assert(!collisionInline?.permissions?.deny?.includes('Agent(c-thru-coordinator)'),
    '27a disabled coordinator does not deny the caller-owned reserved definition');

  const nativeAnthropicConfig = {
    backends: { anthropic: { kind: 'anthropic', url: 'https://api.anthropic.com' } },
  };
  const skipped = [
    ['no-agents', ['--no-agents', '-p', 'hello'], {}],
    ['bypass', ['--bypass-proxy', '--model', 'claude-sonnet-5', '-p', 'hello'], nativeAnthropicConfig],
    ['native subcommand', ['agents', '--coordinator', '--help'], {}],
    ['resume', ['--resume', 'session-id'], {}],
    ['continue', ['--continue'], {}],
    ['from-pr', ['--from-pr', '123'], {}],
    ['teleport', ['--teleport'], {}],
    ['system prompt', ['--system-prompt', 'caller prompt', '-p', 'hello'], {}],
    ['system prompt file', ['--system-prompt-file=prompt.txt', '-p', 'hello'], {}],
    ['bare', ['--bare', '-p', 'hello'], {}],
    ['safe mode', ['--safe-mode', '-p', 'hello'], {}],
  ];
  for (const [label, args, config] of skipped) {
    const result = runCoordinatorCthru(args, config, { C_THRU_COORDINATOR: '1' });
    assert(result.code === 0 && result.json?.c_thru_coordinator_active === null &&
      result.json?.physical_settings_content === null &&
      result.json?.coordinator_agent_is_symlink === false,
    `27b ${label} launch skips coordinator (got exit ${result.code}, stderr: ${result.stderr.slice(0, 160)})`);
  }
}

// ── Test 28: caller tool restrictions gate the coordinator ─────────────────
console.log('\n28. explicit CLI tool restrictions disable coordinator when Agent is unavailable');
{
  const cases = [
    ['tools excludes Agent', ['--tools', 'Bash,Edit', '-p', 'hello'], false, /caller --tools excludes Agent/],
    ['tools equals excludes Agent', ['--tools=Bash,Edit', '-p', 'hello'], false, /caller --tools excludes Agent/],
    ['tools default', ['--tools', 'default', '-p', 'hello'], true, null],
    ['tools includes Agent', ['--tools', 'Bash,Agent', '-p', 'hello'], true, null],
    ['disallowed Agent', ['--disallowedTools', 'Agent', '-p', 'hello'], false, /disallowed-tools blocks Agent/],
    ['disallowed Agent equals', ['--disallowed-tools=Bash,Agent', '-p', 'hello'], false, /disallowed-tools blocks Agent/],
    ['disallowed unrelated tool', ['--disallowedTools', 'Bash', '-p', 'hello'], true, null],
  ];
  for (const [label, args, active, warning] of cases) {
    const result = runCoordinatorCthru(args, {}, { C_THRU_COORDINATOR: '1' });
    assert(result.code === 0 && (result.json?.c_thru_coordinator_active === '1') === active &&
      (result.json?.physical_settings_content !== null) === active,
    `28a ${label} yields coordinator active=${active} while preserving launch (got exit ${result.code})`);
    if (warning) {
      assert(warning.test(result.stderr), `28b ${label} emits explicit warning (got ${result.stderr.slice(0, 220)})`);
    }
    for (const arg of args) {
      assert((result.json?.args || []).includes(arg),
        `28c ${label} preserves caller token ${JSON.stringify(arg)}`);
    }
  }
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
