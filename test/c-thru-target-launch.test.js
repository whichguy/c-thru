#!/usr/bin/env node
'use strict';
// Launch-path regression tests for target handling in tools/c-thru.
// Run: node test/c-thru-target-launch.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    failed++;
  }
}

const CTHRU = path.join(__dirname, '..', 'tools', 'c-thru');

function makeStubClaude(binDir) {
  const stubPath = path.join(binDir, 'claude');
  const script = `#!/bin/sh
node -e 'console.log(JSON.stringify({args: process.argv.slice(1), anthropic_base_url: process.env.ANTHROPIC_BASE_URL || null, anthropic_api_key: process.env.ANTHROPIC_API_KEY || null, anthropic_auth_token: process.env.ANTHROPIC_AUTH_TOKEN || null}))' -- "$@"
`;
  fs.writeFileSync(stubPath, script, 'utf8');
  fs.chmodSync(stubPath, 0o755);
}

function runCthru({ modelArg, args, extraEnv = {}, ...config }) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-launch-'));
  const homeDir = path.join(tmpRoot, 'home');
  const claudeDir = path.join(homeDir, '.claude');
  const fakeBin = path.join(tmpRoot, 'bin');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.symlinkSync(path.join(__dirname, '..', 'tools'), path.join(claudeDir, 'tools'));
  makeStubClaude(fakeBin);

  const configPath = path.join(tmpRoot, 'model-map.json');
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

  const cthruArgs = args || ['--model', modelArg];
  const result = spawnSync(CTHRU, cthruArgs, {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      CLAUDE_DIR: claudeDir,
      CLAUDE_CONFIG_DIR: claudeDir,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CLAUDE_MODEL_MAP_PATH: configPath,
      C_THRU_NO_UPDATE: '1',
      C_THRU_SESSION_SCOPED_MODE: '1',
      C_THRU_SKIP_PREPULL: '1',
      CLAUDE_PROXY_STARTUP_PROBE: '0',
      CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
      OLLAMA_URL: 'http://127.0.0.1:11434',
      ...extraEnv,
    },
    cwd: tmpRoot,
  });

  let parsed = null;
  try { parsed = JSON.parse((result.stdout || '').trim()); } catch {}

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '', json: parsed };
}

function proxyBindDenied(result) {
  return result.code !== 0 && /(?:claude-proxy failed to bind: EPERM|listen EPERM)/.test(result.stderr || '');
}

async function main() {
  console.log('c-thru target launch tests\n');

  console.log('1. Unmatched labels ignore targets.default during launcher backend selection');
  {
    const result = runCthru({
      modelArg: 'claude-sonnet-5',
      // This case checks BACKEND SELECTION (legacy claude label → the anthropic
      // backend, not targets.default). The selected backend is only observable via
      // the direct base URL, so opt out of the default proxy-always (C_THRU_PROXY_ALWAYS,
      // now on by default for per-agent routing) — otherwise the URL is just the proxy
      // and hides which backend was chosen. Proxy-always itself is exercised by case 2.
      extraEnv: { C_THRU_PROXY_ALWAYS: '0' },
      backends: {
        anthropic: { kind: 'anthropic', url: 'https://anthropic.example' },
        ignored_default: { kind: 'ollama', url: 'http://127.0.0.1:11434' },
      },
      targets: {
        default: { backend: 'ignored_default' },
      },
    });
    assert(result.code === 0, `launcher exits 0 for unmatched legacy label (got ${result.code})`);
    assert(result.json?.anthropic_base_url === 'https://anthropic.example',
      `legacy anthropic autodetect wins over targets.default, direct mode (got ${JSON.stringify(result.json?.anthropic_base_url)})`);
    assert((result.json?.args || []).some(arg => arg === '--model=claude-sonnet-5' || arg === 'claude-sonnet-5'),
      'forwarded args preserve unmatched model label');
    assert((result.json?.args || []).includes('--append-system-prompt'),
      'normal launch still receives injected session flags');
    // Token-budget guard: system summary is paid every main-chat turn.
    // Hard cap 2500 chars (IDENTITY + fleet prose); grow only with intent.
    const args1 = result.json?.args || [];
    const aspIdx = args1.indexOf('--append-system-prompt');
    const asp = aspIdx >= 0 ? (args1[aspIdx + 1] || '') : '';
    assert(asp.length >= 400 && asp.length <= 2500,
      `system summary within budget on direct path (got ${asp.length} chars)`);
    assert(/Use specialized agents aggressively/.test(asp),
      'system summary still carries fleet aggression policy');
  }

  console.log('\n2. Explicit target ids stay proxy-owned end-to-end');
  {
    const result = runCthru({
      modelArg: 'explicit-target',
      backends: {
        anthropic: { kind: 'anthropic', url: 'https://provider.example' },
        default_ollama: { kind: 'ollama', url: 'http://127.0.0.1:11434' },
      },
      targets: {
        default: { backend: 'default_ollama' },
        'explicit-target': { backend: 'anthropic', model: 'provider-model' },
      },
    });
    if (proxyBindDenied(result)) {
      console.log('  SKIP  explicit target proxy mediation (sandbox denied loopback bind)');
    } else {
      assert(result.code === 0, `launcher exits 0 for explicit target id (got ${result.code})`);
      assert(typeof result.json?.anthropic_base_url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/s\/\d+$/.test(result.json.anthropic_base_url),
        `explicit target uses proxy mediation instead of direct provider URL (got ${JSON.stringify(result.json?.anthropic_base_url)})`);
      assert((result.json?.args || []).some(arg => arg === '--model=explicit-target' || arg === 'explicit-target'),
        'forwarded args preserve explicit target label');
      const args2 = result.json?.args || [];
      const aspIdx2 = args2.indexOf('--append-system-prompt');
      const asp2 = aspIdx2 >= 0 ? (args2[aspIdx2 + 1] || '') : '';
      assert(asp2.length >= 400 && asp2.length <= 2500,
        `system summary within budget on proxy path (got ${asp2.length} chars)`);
      assert(/Use specialized agents aggressively/.test(asp2),
        'proxy-path system summary still carries fleet aggression policy');
    }
  }

  console.log('\n3. Native Claude Code subcommands pass through (no session inject)');
  {
    const result = runCthru({
      args: ['agents', '--help'],
      // Valid minimal map (native path now runs after config validate)
      backends: { local: { kind: 'ollama', url: 'http://127.0.0.1:11434' } },
      targets: { default: { backend: 'local' } },
    });
    const args = result.json?.args || [];
    assert(result.code === 0, `agents passthrough exits 0 (got ${result.code}; stderr: ${(result.stderr || '').slice(0, 200)})`);
    assert(JSON.stringify(args) === JSON.stringify(['agents', '--help']),
      `agents --help preserves argv exactly (got ${JSON.stringify(args)})`);
    assert(!args.some(arg => ['--append-system-prompt', '--settings', '--agents', '--model', '--dangerously-skip-permissions'].includes(arg) || /^--model=/.test(arg)),
      `agents passthrough has no session-injected flags (got ${JSON.stringify(args)})`);
  }

  console.log('\n3b. Native agents --model grok: proxy + re-insert model (not bare Anthropic)');
  {
    const result = runCthru({
      args: ['agents', '--model', 'grok', '--json'],
      backends: {
        xai: { kind: 'anthropic', url: 'https://api.x.ai', format: 'anthropic' },
      },
      model_routes: { grok: { endpoint: 'xai', name: 'grok-4.5' } },
    });
    const args = result.json?.args || [];
    if (proxyBindDenied(result)) {
      console.log('  SKIP  agents --model grok proxy path (sandbox denied loopback bind)');
    } else {
      assert(result.code === 0, `agents --model grok exits 0 (got ${result.code}; stderr: ${(result.stderr || '').slice(0, 240)})`);
      // Brand proxy path re-inserts --model and may inject minimal SessionStart --settings
      // (port resurrection only — not full fleet).
      assert(args[0] === 'agents', `args start with agents (got ${JSON.stringify(args)})`);
      const modelIdx = args.indexOf('--model');
      assert(modelIdx > 0 && args[modelIdx + 1] === 'grok',
        `agents re-inserts --model grok (got ${JSON.stringify(args)})`);
      assert(args.includes('--json'), `forwards --json (got ${JSON.stringify(args)})`);
      const settingsIdx = args.indexOf('--settings');
      if (settingsIdx >= 0) {
        const settingsRaw = args[settingsIdx + 1] || '';
        let settingsObj = null;
        try { settingsObj = JSON.parse(settingsRaw); } catch (_) { /* ignore */ }
        assert(settingsObj && settingsObj.hooks && settingsObj.hooks.SessionStart,
          `minimal --settings carries SessionStart (got ${settingsRaw.slice(0, 200)})`);
        assert(settingsObj.hooks.StopFailure,
          `minimal brand --settings also carries StopFailure (got ${settingsRaw.slice(0, 200)})`);
        assert(!settingsObj.hooks.UserPromptSubmit && !settingsObj.hooks.PreCompact,
          'native brand agents does not inject full fleet hooks');
        assert(!args.includes('--append-system-prompt') && !args.includes('--agents'),
          `no fleet --append-system-prompt/--agents (got ${JSON.stringify(args)})`);
      }
      assert(typeof result.json?.anthropic_base_url === 'string' &&
        /^http:\/\/127\.0\.0\.1:\d+/.test(result.json.anthropic_base_url),
        `agents --model grok sets proxy ANTHROPIC_BASE_URL (got ${JSON.stringify(result.json?.anthropic_base_url)})`);
      assert(/via proxy/.test(result.stderr || ''),
        `stderr notes proxy routing (got ${(result.stderr || '').slice(0, 300)})`);
      assert(/no fleet/.test(result.stderr || ''),
        `stderr notes no fleet inject on native subcmd (got ${(result.stderr || '').slice(0, 400)})`);
      assert(/c-thru list/.test(result.stderr || ''),
        `stderr points at c-thru list for status (got ${(result.stderr || '').slice(0, 400)})`);
      const proxyInfoLines = (result.stderr || '').split('\n').filter(l => /via proxy/.test(l));
      assert(proxyInfoLines.length === 1,
        `single via-proxy info line (got ${proxyInfoLines.length}: ${JSON.stringify(proxyInfoLines)})`);
    }
  }

  console.log('\n3c. Native agents keeps Claude-native --model sonnet (no forced proxy message)');
  {
    const result = runCthru({
      args: ['agents', '--model', 'sonnet', '--json'],
      backends: { local: { kind: 'ollama', url: 'http://127.0.0.1:11434' } },
      targets: { default: { backend: 'local' } },
    });
    const args = result.json?.args || [];
    assert(result.code === 0, `agents --model sonnet exits 0 (got ${result.code})`);
    assert(JSON.stringify(args) === JSON.stringify(['agents', '--model', 'sonnet', '--json']),
      `agents forwards Claude-native --model sonnet (got ${JSON.stringify(args)})`);
    assert(!/stripped --model 'sonnet'/.test(result.stderr || ''),
      `stderr does not warn for sonnet (got ${(result.stderr || '').slice(0, 200)})`);
  }

  console.log('\n4. Additional native subcommands pass through untouched');
  {
    const result = runCthru({
      args: ['mcp', 'list'],
      backends: { local: { kind: 'ollama', url: 'http://127.0.0.1:11434' } },
      targets: { default: { backend: 'local' } },
    });
    const args = result.json?.args || [];
    assert(result.code === 0, `mcp passthrough exits 0 (got ${result.code})`);
    assert(JSON.stringify(args) === JSON.stringify(['mcp', 'list']),
      `mcp passthrough preserves argv exactly (got ${JSON.stringify(args)})`);
    assert(!args.some(arg => ['--append-system-prompt', '--settings', '--agents', '--model', '--dangerously-skip-permissions'].includes(arg) || /^--model=/.test(arg)),
      `mcp passthrough has no session-injected flags (got ${JSON.stringify(args)})`);
  }

  console.log('\n3. ollama-sentinel auth_token preserves injected OAuth (does not export placeholder)');
  {
    // apply_provider_block treats auth_token=="ollama" as a sentinel: it must NOT
    // export a placeholder ANTHROPIC_AUTH_TOKEN, since that would shadow Claude
    // Code's keychain OAuth on Anthropic-fallback hops. Seed a pre-existing OAuth
    // token and route through an ollama backend; the child must still see the
    // original token, not 'ollama'/a placeholder.
    const result = runCthru({
      // An unmatched label falls through to targets.default (the only target
      // exempt from the "named targets require .model" validator rule).
      modelArg: 'ollama-route',
      extraEnv: { ANTHROPIC_AUTH_TOKEN: 'fake-oauth' },
      backends: {
        // kind:ollama → apply_ollama_client_block passes the literal "ollama"
        // sentinel to apply_provider_block, exercising the no-export branch.
        local_ollama: { kind: 'ollama', url: 'http://127.0.0.1:11434' },
      },
      targets: {
        default: { backend: 'local_ollama' },
      },
    });
    assert(result.code === 0, `launcher exits 0 for ollama-sentinel route (got ${result.code})`);
    assert(result.json?.anthropic_auth_token === 'fake-oauth',
      `injected OAuth preserved through ollama sentinel (expected 'fake-oauth', got ${JSON.stringify(result.json?.anthropic_auth_token)})`);
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
