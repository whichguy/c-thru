#!/usr/bin/env node
'use strict';
// A8 / F1 residual: Anthropic upstream override must hard-fail when the local
// proxy cannot start (or when PROXY_ALWAYS=0), never fall through to map
// api.anthropic.com. Run: node test/c-thru-anthropic-upstream-failclosed.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CTHRU = path.join(__dirname, '..', 'tools', 'c-thru');
const REPO_TOOLS = path.join(__dirname, '..', 'tools');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL  ${msg}`);
    failed++;
  }
}

function makeSandbox({ brokenProxy = false } = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-failclosed-'));
  const homeDir = path.join(tmpRoot, 'home');
  const claudeDir = path.join(homeDir, '.claude');
  const toolsDir = path.join(claudeDir, 'tools');
  const fakeBin = path.join(tmpRoot, 'bin');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });

  // Stub claude — if invoked, write a marker so we can detect fallthrough.
  const marker = path.join(tmpRoot, 'claude-invoked');
  const stubClaude = `#!/bin/sh
printf 'INVOKED\\n' > "${marker.replace(/'/g, "'\\''")}"
node -e 'console.log(JSON.stringify({
  args: process.argv.slice(1),
  anthropic_base_url: process.env.ANTHROPIC_BASE_URL || null,
}))' -- "$@"
`;
  fs.writeFileSync(path.join(fakeBin, 'claude'), stubClaude, 'utf8');
  fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);

  if (brokenProxy) {
    // Profile-local claude-proxy wins over CTHRU_REPO_ROOT fallback.
    // Exit immediately without READY so ensure_proxy_http_base fails.
    const broken = `#!/bin/sh
echo "c-thru-test: intentional broken claude-proxy (no READY)" >&2
exit 1
`;
    fs.writeFileSync(path.join(toolsDir, 'claude-proxy'), broken, 'utf8');
    fs.chmodSync(path.join(toolsDir, 'claude-proxy'), 0o755);
  } else {
    fs.symlinkSync(REPO_TOOLS, toolsDir + '.link-src');
    // Prefer symlink of whole tools dir for healthy proxy (optional path).
    try { fs.rmSync(toolsDir, { recursive: true, force: true }); } catch {}
    fs.symlinkSync(REPO_TOOLS, toolsDir);
  }

  const configPath = path.join(tmpRoot, 'model-map.json');
  fs.writeFileSync(configPath, JSON.stringify({
    backends: {
      anthropic: { kind: 'anthropic', url: 'https://api.anthropic.com' },
    },
    routes: {
      default: 'claude-sonnet-5',
    },
    model_routes: {
      'claude-sonnet-5': 'anthropic',
    },
  }), 'utf8');

  return { tmpRoot, homeDir, claudeDir, fakeBin, configPath, marker };
}

function runCthru(sandbox, args, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: sandbox.homeDir,
    PATH: `${sandbox.fakeBin}:${process.env.PATH}`,
    CLAUDE_DIR: sandbox.claudeDir,
    CLAUDE_CONFIG_DIR: sandbox.claudeDir,
    CLAUDE_PROFILE_DIR: sandbox.claudeDir,
    CLAUDE_MODEL_MAP_PATH: sandbox.configPath,
    CLAUDE_MODEL_MAP_LAUNCH_CWD: sandbox.tmpRoot,
    C_THRU_NO_UPDATE: '1',
    C_THRU_NO_MARKETPLACE_UPDATE: '1',
    C_THRU_NO_OAUTH_INJECT: '1',
    C_THRU_SKIP_PREPULL: '1',
    C_THRU_SKIP_PREFLIGHT: '1',
    CLAUDE_PROXY_STARTUP_PROBE: '0',
    CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
    CLAUDE_LLM_PROFILE: '16gb',
    CLAUDE_PROXY_READY_TIMEOUT_SECONDS: '2',
    NO_AGENTS: '1',
    // Scrub ambient override pollution
    CLAUDE_PROXY_ANTHROPIC_UPSTREAM: '',
    C_THRU_ANTHROPIC_UPSTREAM: '',
    C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT: '',
    ANTHROPIC_BASE_URL: '',
    ...extraEnv,
  };
  // Empty string still exports; delete true empties
  for (const k of [
    'CLAUDE_PROXY_ANTHROPIC_UPSTREAM',
    'C_THRU_ANTHROPIC_UPSTREAM',
    'C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT',
    'ANTHROPIC_BASE_URL',
  ]) {
    if (env[k] === '' || env[k] == null) delete env[k];
  }

  const result = spawnSync(CTHRU, args, {
    encoding: 'utf8',
    env,
    cwd: sandbox.tmpRoot,
    timeout: 60000,
  });
  const invoked = fs.existsSync(sandbox.marker);
  let json = null;
  try { json = JSON.parse((result.stdout || '').trim()); } catch {}
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    invoked,
    json,
  };
}

function cleanup(sandbox) {
  try { fs.rmSync(sandbox.tmpRoot, { recursive: true, force: true }); } catch {}
}

function main() {
  console.log('c-thru anthropic upstream fail-closed (A8 residual)\n');

  // R1a: override + broken proxy → fatal, Claude not launched with map URL
  console.log('R1a. override + proxy start fail → hard-fail (no map fallthrough)');
  {
    const sb = makeSandbox({ brokenProxy: true });
    try {
      const r = runCthru(sb, [
        '--anthropic-upstream', 'https://llm-gateway.example.com/anthropic',
        '--model', 'claude-sonnet-5',
      ]);
      assert(r.code !== 0 && r.code != null, `exit non-zero (got ${r.code})`);
      assert(/upstream override is active/i.test(r.stderr),
        `stderr names override active (got: ${r.stderr.slice(0, 300)})`);
      assert(/refusing direct map Anthropic/i.test(r.stderr),
        'stderr refuses direct map Anthropic path');
      // Claude must not successfully fall through to map api.anthropic.com.
      if (r.invoked && r.json) {
        const base = r.json.anthropic_base_url || '';
        assert(!/api\.anthropic\.com/.test(base),
          `Claude BASE_URL is not map api.anthropic.com (got ${base})`);
      } else {
        assert(!r.invoked, 'Claude not invoked after fail-closed');
      }
    } finally {
      cleanup(sb);
    }
  }

  // R1b: override + PROXY_ALWAYS=0 → hard-fail hybrid
  console.log('\nR1b. override + C_THRU_PROXY_ALWAYS=0 → hard-fail (no hybrid)');
  {
    const sb = makeSandbox({ brokenProxy: false });
    try {
      const r = runCthru(sb, [
        '--anthropic-upstream', 'https://llm-gateway.example.com/anthropic',
        '--model', 'claude-sonnet-5',
      ], {
        C_THRU_PROXY_ALWAYS: '0',
      });
      assert(r.code !== 0 && r.code != null, `exit non-zero (got ${r.code})`);
      assert(/C_THRU_PROXY_ALWAYS/i.test(r.stderr),
        `stderr mentions C_THRU_PROXY_ALWAYS (got: ${r.stderr.slice(0, 300)})`);
      if (r.invoked && r.json) {
        const base = r.json.anthropic_base_url || '';
        assert(!/api\.anthropic\.com/.test(base) || r.code !== 0,
          `no successful map fallthrough (base=${base})`);
      }
    } finally {
      cleanup(sb);
    }
  }

  // R1c: no override + broken proxy → existing degrade path (WARN), not override fatal
  console.log('\nR1c. no override + proxy fail → not override-specific fatal');
  {
    const sb = makeSandbox({ brokenProxy: true });
    try {
      const r = runCthru(sb, ['--model', 'claude-sonnet-5']);
      assert(!/upstream override is active/i.test(r.stderr),
        'override-specific fatal string absent without override');
      // May exit 0 with WARN degrade or non-zero for other reasons — either is fine.
      // If Claude ran, direct map URL is allowed (historical PROXY_ALWAYS degrade).
      if (r.code === 0 && r.invoked && r.json) {
        assert(!!r.json.anthropic_base_url,
          `Claude received a BASE_URL on degrade path (got ${r.json.anthropic_base_url})`);
      } else {
        assert(r.code != null,
          `non-override path completed (code=${r.code}, invoked=${r.invoked})`);
      }
    } finally {
      cleanup(sb);
    }
  }

  // L2: ambient API_KEY + override → inject skips (metered path); Claude keeps API_KEY
  console.log('\nL2. override + ambient ANTHROPIC_API_KEY → inject skips (keep API key)');
  {
    const sb = makeSandbox({ brokenProxy: false });
    try {
      // Dump extra auth fields from stub
      const stubPath = path.join(sb.fakeBin, 'claude');
      fs.writeFileSync(stubPath, `#!/bin/sh
printf 'INVOKED\\n' > "${sb.marker.replace(/'/g, "'\\''")}"
node -e 'console.log(JSON.stringify({
  args: process.argv.slice(1),
  anthropic_base_url: process.env.ANTHROPIC_BASE_URL || null,
  anthropic_api_key: process.env.ANTHROPIC_API_KEY || null,
  anthropic_auth_token: process.env.ANTHROPIC_AUTH_TOKEN || null,
  claude_proxy_anthropic_upstream: process.env.CLAUDE_PROXY_ANTHROPIC_UPSTREAM || null,
}))' -- "$@"
`, 'utf8');
      fs.chmodSync(stubPath, 0o755);

      const r = runCthru(sb, [
        '--anthropic-upstream', 'https://llm-gateway.example.com/anthropic',
        '--model', 'claude-sonnet-5',
      ], {
        ANTHROPIC_API_KEY: 'sk-ant-api-ambient-test',
        // Allow inject path to run so we prove API_KEY causes early return
        C_THRU_NO_OAUTH_INJECT: '0',
      });
      assert(r.code === 0, `exit 0 (got ${r.code}; ${(r.stderr || '').slice(0, 200)})`);
      assert(r.invoked, 'Claude invoked');
      assert(r.json?.anthropic_api_key === 'sk-ant-api-ambient-test',
        `API_KEY preserved (got ${r.json?.anthropic_api_key})`);
      // Inject must not invent AUTH_TOKEN when API_KEY present (skip before keychain)
      assert(!r.json?.anthropic_auth_token,
        `AUTH_TOKEN not injected when API_KEY set (got ${r.json?.anthropic_auth_token})`);
      assert(/llm-gateway\.example\.com/.test(String(r.json?.claude_proxy_anthropic_upstream || '')),
        'override still exported with API_KEY path');
      const base = r.json?.anthropic_base_url || '';
      assert(/^https?:\/\/(127\.0\.0\.1|localhost)/.test(base),
        `Claude BASE_URL loopback (got ${base})`);
    } finally {
      cleanup(sb);
    }
  }

  console.log(`\n${passed}/${passed + failed} passed${failed ? ` — ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
}

main();
