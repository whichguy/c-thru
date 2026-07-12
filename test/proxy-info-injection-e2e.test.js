#!/usr/bin/env node
'use strict';
// System test for the dynamic proxy-info injection feature (Parts 1–3):
//   • the proxy owns one canonical control-plane block at POST /hooks/context
//   • c-thru-session-start.sh is the single injector of that block
//   • claude_proxy_listen_port discovers the proxy from ANTHROPIC_BASE_URL alone
//   • the c-thru-status skill consumes the injected URL + endpoints
//
// Unlike session-start-injection.test.js (stub proxy) and proxy-dashboard.test.js
// (proxy-only), this is the END-TO-END system test: a REAL proxy + the REAL
// scripts, with no stub standing between producer (proxy) and consumer (hook /
// launcher). It is the green-gate that the producer's block and the consumer's
// extraction actually agree at runtime.
//
// Always-run (no creds, no live backend — the proxy serves /hooks/context and
// /ping from its own state; we never forward a /v1/messages).
//
// Covers: A (reaffirm via real binary), B1 (producer↔consumer integration),
//         D2 (plugin-mode --list discovery), E1 (skill contract — static).
//
// Run: node test/proxy-info-injection-e2e.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  assert, assertEq, summary, withProxy, httpJson, writeConfig,
} = require('./helpers');

const REPO_DIR      = path.join(__dirname, '..');
const SESSION_START = path.join(REPO_DIR, 'tools', 'c-thru-session-start.sh');
const CTHRU         = path.join(REPO_DIR, 'tools', 'c-thru');
const BUNDLED_MAP   = path.join(REPO_DIR, 'config', 'model-map.json');

console.log('proxy-info-injection e2e (real proxy ↔ hook ↔ launcher ↔ skill)\n');

function mkdtemp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `c-thru-pii-${label}-`));
}

async function main() {
  // Minimal valid config — the proxy only needs to start and answer /ping +
  // /hooks/context; we never forward a real request, so no live backend.
  const cfgDir = mkdtemp('cfg');
  const configPath = writeConfig(cfgDir, {
    backends: { anthropic: { kind: 'anthropic', url: 'https://anthropic.example' } },
    model_routes: { 're:^claude-.*$': 'anthropic' },
  });

  try {
    await withProxy({ configPath }, async ({ port }) => {
      // ── A (reaffirm): the REAL proxy owns the canonical control-plane block ──
      console.log('A. real proxy POST /hooks/context owns the canonical block');
      const hk = await httpJson(port, 'POST', '/hooks/context', null, {}, 3000);
      assertEq(hk.status, 200, '/hooks/context returns 200');
      const addl = (hk.json && hk.json.hookSpecificOutput && hk.json.hookSpecificOutput.additionalContext) || '';
      assert(addl.includes(`http://127.0.0.1:${port}`), `block carries the real live port base URL (http://127.0.0.1:${port})`);
      assert(addl.includes('/c-thru/status'),   'block lists /c-thru/status');
      assert(addl.includes('/c-thru/recent'),   'block lists /c-thru/recent');
      assert(addl.includes('/c-thru/dashboard'),'block lists /c-thru/dashboard');
      assert(addl.includes(`http://127.0.0.1:${port}/c-thru/dashboard`), 'block carries the dashboard_url');

      // ── B1-integration: the REAL hook consumes the REAL proxy's block ───────
      // Pre-seed model-map.system.json so the hook's first-run seeding block is
      // SKIPPED — otherwise the real-repo hook would spawn a stray proxy on 10017
      // (ROUTER_REPO_ROOT is the real repo, which has config/model-map.json + a
      // real claude-proxy). Copy the real config (not a touch/empty file) so the
      // pollution check can't choke on a malformed map.
      console.log('\nB1. c-thru-session-start.sh injects the real proxy block (producer ↔ consumer)');
      const profileDir = mkdtemp('prof');
      fs.copyFileSync(BUNDLED_MAP, path.join(profileDir, 'model-map.system.json'));
      const hookEnv = Object.assign({}, process.env, {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        CLAUDE_PROFILE_DIR: profileDir,
      });
      // Plugin-mode shape: discovery comes from ANTHROPIC_BASE_URL only; no
      // Ollama check (keeps output to the proxy block + any real-repo advisories).
      delete hookEnv.OLLAMA_URL;
      delete hookEnv.OLLAMA_BASE_URL;
      delete hookEnv.CLAUDE_PROXY_PORT;
      delete hookEnv.CLAUDE_PROXY_USE_OLLAMA_PORT;

      const r = spawnSync('bash', [SESSION_START], { encoding: 'utf8', env: hookEnv, input: '', timeout: 15000 });
      assertEq(r.status, 0, `hook exits 0 (stderr: ${(r.stderr || '').slice(0, 200)})`);
      let hookAddl = '';
      try { hookAddl = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch {}
      assert(hookAddl.includes(`http://127.0.0.1:${port}`), 'merged context carries the real proxy URL');
      assert(hookAddl.includes('/c-thru/status') && hookAddl.includes('/c-thru/recent') && hookAddl.includes('/c-thru/dashboard'),
        'merged context lists all three endpoints');
      const blockCount = (hookAddl.match(/proxy control plane/g) || []).length;
      assertEq(blockCount, 1, 'proxy control-plane block appears exactly once (producer & consumer agree)');
      fs.rmSync(profileDir, { recursive: true, force: true });

      // ── D2: plugin-mode discovery — c-thru --list finds the proxy from URL ──
      // Mirrors cli-e2e-flags env setup but with ONLY ANTHROPIC_BASE_URL set as
      // the proxy locator (no CLAUDE_PROXY_PORT/PROXY_PORT/pid) — the headline
      // plugin-mode user outcome.
      console.log('\nD2. c-thru --list discovers the proxy from ANTHROPIC_BASE_URL alone (plugin mode)');
      const listRoot = mkdtemp('list');
      const homeDir  = path.join(listRoot, 'home');
      const fakeBin  = path.join(listRoot, 'bin');
      fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.symlinkSync(path.join(REPO_DIR, 'tools'), path.join(homeDir, '.claude', 'tools'));
      // Trivial stub claude so any early dep probe is satisfied (--list never
      // execs it — it short-circuits before the launch path).
      fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 0\n');
      fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);

      const listConfig = path.join(listRoot, 'model-map.json');
      fs.writeFileSync(listConfig, JSON.stringify({
        backends: { anthropic: { kind: 'anthropic', url: 'https://anthropic.example' } },
        routes: { default: 'claude-sonnet-4-6' },
        model_routes: { 'claude-sonnet-4-6': 'anthropic', 're:^claude-.*$': 'anthropic' },
      }));

      const listEnv = Object.assign({}, process.env, {
        HOME: homeDir,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CLAUDE_MODEL_MAP_PATH: listConfig,
        CLAUDE_ROUTER_NO_UPDATE: '1',
        C_THRU_SKIP_PREPULL: '1',
        C_THRU_SKIP_PREFLIGHT: '1',
        CLAUDE_PROXY_STARTUP_PROBE: '0',
        CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
        CLAUDE_LLM_PROFILE: '16gb',
        OLLAMA_URL: 'http://127.0.0.1:1',          // closed → fast fail, never lists models
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      });
      // Discovery MUST come from ANTHROPIC_BASE_URL — not an inherited port/pid.
      delete listEnv.CLAUDE_PROXY_PORT;
      delete listEnv.PROXY_PORT;
      delete listEnv.CLAUDE_PROXY_USE_OLLAMA_PORT;
      delete listEnv.CLAUDE_PROFILE_DIR;            // default to $HOME/.claude (hermetic)

      const lr = spawnSync(CTHRU, ['--list'], { encoding: 'utf8', env: listEnv, timeout: 20000, cwd: listRoot });
      assertEq(lr.status, 0, `c-thru --list exits 0 (stderr: ${(lr.stderr || '').slice(0, 300)})`);
      assert((lr.stdout || '').includes(`http://127.0.0.1:${port}`),
        `--list prints the discovered proxy URL http://127.0.0.1:${port} (got stdout: ${(lr.stdout || '').slice(0, 300)})`);
      fs.rmSync(listRoot, { recursive: true, force: true });
    });
  } finally {
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }

  // ── E1 (skill contract — static): the c-thru-status command consumes the URL ─
  console.log('\nE1. c-thru-status skill consumes the injected URL + endpoints');
  const cmd = fs.readFileSync(path.join(REPO_DIR, 'plugins', 'c-thru', 'commands', 'c-thru-status.md'), 'utf8');
  const fm = cmd.split(/^---$/m)[1] || '';   // frontmatter between the first two --- fences
  assert(/allowed-tools:\s*.*Bash/.test(fm), 'frontmatter allowed-tools includes Bash');
  assert(cmd.includes('127.0.0.1'),     'body references the 127.0.0.1 base URL');
  assert(cmd.includes('/c-thru/recent'),'body references /c-thru/recent');
  assert(cmd.includes('/c-thru/status'),'body references /c-thru/status');
  assert(cmd.includes('dashboard_url'), 'body references dashboard_url');
}

main()
  .then(() => process.exit(summary() ? 1 : 0))
  .catch(err => { console.error(err); process.exit(1); });
