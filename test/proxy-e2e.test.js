#!/usr/bin/env node
'use strict';
// End-to-end tests: invokes c-thru directly as a subprocess with -p (non-interactive).
// Tests the full stack: c-thru → proxy spawn → Ollama → response.
//
// Requires: Ollama running at localhost:11434 with qwen3:1.7b pulled.
// Skips gracefully when Ollama is unreachable.
//
// Run with: node test/proxy-e2e.test.js

const fs           = require('fs');
const http         = require('http');
const os           = require('os');
const { execFile } = require('child_process');
const path         = require('path');

const {
  assert,
  assertEq,
  ensureModelTestSupervisor,
  summary,
  modelTestTimeoutMs,
  modelTestProxyEnv,
} = require('./helpers');
if (require.main === module) ensureModelTestSupervisor();

console.log('proxy-e2e integration tests (c-thru -p)\n');

// ── Constants ──────────────────────────────────────────────────────────────

const REPO_ROOT      = path.join(__dirname, '..');
const C_THRU         = path.join(REPO_ROOT, 'tools', 'c-thru');
const CHECKOUT_MODEL_MAP = path.join(REPO_ROOT, 'config', 'model-map.json');
const E2E_MODEL      = 'qwen3:1.7b';    // smallest available; already pulled
const TEST_ROOT      = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-proxy-e2e-'));
const TEST_PROFILE   = path.join(TEST_ROOT, 'claude-profile');
fs.mkdirSync(TEST_PROFILE, { recursive: true });
process.once('exit', () => {
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});
// A cold or queued local model may take hours. The shared override also widens
// the proxy's generation watchdogs, while probeOllama stays intentionally short.
const E2E_TIMEOUT_MS = modelTestTimeoutMs();
const LIVE_ANTHROPIC = process.env.C_THRU_LIVE_ANTHROPIC === '1';
const ANTHROPIC_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
];

// Short prompt: e2e only needs a non-empty model reply. Long identity prompts
// inflate local-model latency and flaked under concurrent suite pressure.
const IDENTITY_PROMPT = 'Reply with one word: ok';

// ── Helpers ────────────────────────────────────────────────────────────────

function childEnv({ allowLiveAnthropic = false } = {}) {
  const env = Object.assign({}, process.env, modelTestProxyEnv(E2E_TIMEOUT_MS), {
    CLAUDE_CONFIG_DIR: TEST_PROFILE,
    CLAUDE_DIR: TEST_PROFILE,
    CLAUDE_PROFILE_DIR: TEST_PROFILE,
    CLAUDE_MODEL_MAP_LAUNCH_CWD: TEST_ROOT,
    CLAUDE_MODEL_MAP_PATH: CHECKOUT_MODEL_MAP,
    C_THRU_BRAND_REUSE_GATEWAY_PROXY: '0',
    C_THRU_KEEP_PROXY: '0',
    C_THRU_NO_UPDATE: '1',
    C_THRU_NO_MARKETPLACE_UPDATE: '1',
    C_THRU_NO_OAUTH_INJECT: '1',
    C_THRU_SKIP_INFO_INJECTION: '1',
    C_THRU_SKIP_PREPULL: '1',
    C_THRU_SKIP_PREFLIGHT: '1',
    NO_AGENTS: '1',
  });
  for (const key of [
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_MODEL_MAP_DEFAULTS_PATH',
    'CLAUDE_MODEL_MAP_OVERRIDES_PATH',
    'CLAUDE_MODEL_MAP_SYNC_STATE_FILE',
    'CLAUDE_PROXY_BIND_ADDR',
    'CLAUDE_PROXY_BYPASS',
    'CLAUDE_PROXY_PORT',
    'CLAUDE_PROXY_READY_TIMEOUT_SECONDS',
    'CLAUDE_PROXY_USE_OLLAMA_PORT',
    'CLAUDE_ROUTER_SKIP_PROXY_AUTOSTART',
    'C_THRU_SKIP_PROXY_AUTOSTART',
    'PROXY_PORT',
  ]) {
    delete env[key];
  }
  if (!allowLiveAnthropic) {
    for (const key of ANTHROPIC_CREDENTIAL_KEYS) delete env[key];
    // Claude Code requires a credential even when ANTHROPIC_BASE_URL points to
    // the local c-thru proxy. This non-secret placeholder satisfies the CLI;
    // the local endpoint's auth:none policy strips it before Ollama.
    env.ANTHROPIC_AUTH_TOKEN = 'c-thru-local-e2e-placeholder';
  } else {
    // The live path is admitted only after main() verifies the explicit gate
    // plus a real ANTHROPIC_API_KEY. Never let an ambient auth token substitute.
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

function probeOllama(timeoutMs = 2000) {
  return new Promise(resolve => {
    const req = http.request(
      { hostname: '127.0.0.1', port: 11434, path: '/api/tags', method: 'GET' },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve({ available: true, models: (body.models || []).map(m => m.name) });
          } catch { resolve({ available: false, models: [] }); }
        });
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ available: false, models: [] }); });
    req.on('error', () => resolve({ available: false, models: [] }));
    req.end();
  });
}

// Runs: c-thru [extraArgs...] --model <model> -p "<prompt>"
// Returns { exitCode, stdout, stderr }
function runCThru(model, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const args = [
      ...extraArgs,
      '--model', model,
      '-p', IDENTITY_PROMPT,
    ];
    // Skip bulk pre-pull AND preflight fleet pulls — e2e only needs the
    // explicit --model tag. Offline mode otherwise blocks on ollama pull of
    // every missing local_models entry from /v1/active-models (e.g. qwen3.6:35b).
    const env = childEnv();
    const proc = execFile(C_THRU, args, {
      cwd: TEST_ROOT,
      timeout: E2E_TIMEOUT_MS,
      env,
    }, (err, stdout, stderr) => {
      if (err && err.killed) {
        reject(new Error(`c-thru timed out after ${E2E_TIMEOUT_MS}ms.\nstderr: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve({ exitCode: err ? (err.code || 1) : 0, stdout, stderr });
    });
    proc; // suppress unused-var warning
  });
}

// ── Skip counter ───────────────────────────────────────────────────────────

let _skipped = 0;
function skip(reason) { console.log(`  SKIP  ${reason}`); _skipped++; }

// ── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  const probe = await probeOllama();
  if (!probe.available) {
    skip('Ollama not reachable at localhost:11434 — skipping all E2E tests');
    console.log(`\n0/0 passed (${_skipped} skipped)`);
    process.exit(0);
  }
  if (!probe.models.includes(E2E_MODEL)) {
    skip(`${E2E_MODEL} not pulled — run: ollama pull ${E2E_MODEL}`);
    console.log(`\n0/0 passed (${_skipped} skipped)`);
    process.exit(0);
  }
  console.log(`Ollama reachable. ${probe.models.length} models present. Using: ${E2E_MODEL}\n`);

  // ── Test 1: direct model routing ───────────────────────────────────────────
  console.log(`1. Direct model routing (c-thru --model ${E2E_MODEL} -p "...")`);
  {
    const r = await runCThru(E2E_MODEL);
    assertEq(r.exitCode, 0, `direct route: exit code 0 (got ${r.exitCode})`);
    assert(
      r.stdout.trim().length > 0,
      `direct route: stdout is non-empty (stderr tail: ${JSON.stringify(r.stderr.slice(-300))})`,
    );
    console.log(`  response: ${r.stdout.trim().slice(0, 120)}…`);
  }

  // ── Test 2: offline mode ───────────────────────────────────────────────────
  console.log('\n2. Offline mode (--mode offline forces local model)');
  {
    const r = await runCThru(E2E_MODEL, ['--mode', 'offline']);
    assertEq(r.exitCode, 0, `offline: exit code 0 (got ${r.exitCode})`);
    assert(
      r.stdout.trim().length > 0,
      `offline: stdout is non-empty (stderr tail: ${JSON.stringify(r.stderr.slice(-300))})`,
    );
    console.log(`  response: ${r.stdout.trim().slice(0, 120)}…`);
  }

  // ── Test 3: default route (no explicit model) ──────────────────────────────
  console.log('\n3. Default route (c-thru -p "..." — no --model flag)');
  {
    const hasRealKey = process.env.ANTHROPIC_API_KEY &&
      !process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-test');
    if (!LIVE_ANTHROPIC || !hasRealKey) {
      skip('default route (requires C_THRU_LIVE_ANTHROPIC=1 + real ANTHROPIC_API_KEY)');
    } else {
      const r = await new Promise((resolve, reject) => {
        const args = ['-p', IDENTITY_PROMPT];
        execFile(C_THRU, args, {
          cwd: TEST_ROOT,
          timeout: E2E_TIMEOUT_MS,
          env: childEnv({ allowLiveAnthropic: true }),
        }, (err, stdout, stderr) => {
          if (err && err.killed) { reject(new Error(`timed out.\nstderr: ${stderr.slice(0, 500)}`)); return; }
          resolve({ exitCode: err ? (err.code || 1) : 0, stdout, stderr });
        });
      });
      assertEq(r.exitCode, 0, `default route: exit code 0 (got ${r.exitCode})`);
      assert(r.stdout.trim().length > 0, 'default route: stdout is non-empty');
      console.log(`  response: ${r.stdout.trim().slice(0, 120)}…`);
    }
  }

  const failed = summary();
  if (_skipped) console.log(`(${_skipped} skipped)`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
