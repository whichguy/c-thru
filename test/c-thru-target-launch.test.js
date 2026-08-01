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
node -e 'console.log(JSON.stringify({args: process.argv.slice(1), anthropic_base_url: process.env.ANTHROPIC_BASE_URL || null, anthropic_api_key: process.env.ANTHROPIC_API_KEY || null, anthropic_auth_token: process.env.ANTHROPIC_AUTH_TOKEN || null, claude_code_oauth_token: process.env.CLAUDE_CODE_OAUTH_TOKEN || null}))' -- "$@"
`;
  fs.writeFileSync(stubPath, script, 'utf8');
  fs.chmodSync(stubPath, 0o755);
}

function runCthru({ modelArg, args, extraEnv = {}, captureProxyEnv = false, ...config }) {
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

  let proxyEnvCapturePath = null;
  let proxyEnvPreloadPath = null;
  if (captureProxyEnv) {
    proxyEnvCapturePath = path.join(tmpRoot, 'proxy-env.json');
    proxyEnvPreloadPath = path.join(tmpRoot, 'capture-proxy-env.cjs');
    fs.writeFileSync(proxyEnvPreloadPath, `'use strict';
const fs = require('fs');
if (/(?:^|\\/)claude-proxy$/.test(process.argv[1] || '')) {
  fs.writeFileSync(process.env.C_THRU_TEST_PROXY_ENV_CAPTURE, JSON.stringify({
    anthropic_api_key: process.env.ANTHROPIC_API_KEY || null,
    anthropic_auth_token: process.env.ANTHROPIC_AUTH_TOKEN || null,
    claude_code_oauth_token: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
  }));
}
`, 'utf8');
  }

  const cthruArgs = args || ['--model', modelArg];
  const launchEnv = {
    ...process.env,
    HOME: homeDir,
    CLAUDE_DIR: claudeDir,
    CLAUDE_CONFIG_DIR: claudeDir,
    PATH: `${fakeBin}:${process.env.PATH}`,
    CLAUDE_MODEL_MAP_PATH: configPath,
    C_THRU_NO_UPDATE: '1',
    C_THRU_NO_MARKETPLACE_UPDATE: '1',
    C_THRU_SESSION_SCOPED_MODE: '1',
    C_THRU_SKIP_PREPULL: '1',
    CLAUDE_PROXY_STARTUP_PROBE: '0',
    CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
    OLLAMA_URL: 'http://127.0.0.1:11434',
    ...extraEnv,
  };
  if (captureProxyEnv) {
    const inheritedNodeOptions = launchEnv.NODE_OPTIONS || '';
    launchEnv.NODE_OPTIONS = `${inheritedNodeOptions} --require=${proxyEnvPreloadPath}`.trim();
    launchEnv.C_THRU_TEST_PROXY_ENV_CAPTURE = proxyEnvCapturePath;
  }
  const result = spawnSync(CTHRU, cthruArgs, {
    encoding: 'utf8',
    env: launchEnv,
    cwd: tmpRoot,
  });

  let parsed = null;
  try { parsed = JSON.parse((result.stdout || '').trim()); } catch {}
  let proxyEnv = null;
  if (proxyEnvCapturePath) {
    try { proxyEnv = JSON.parse(fs.readFileSync(proxyEnvCapturePath, 'utf8')); } catch {}
  }

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    json: parsed,
    proxyEnv,
  };
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
    // Hard cap 2700 chars (IDENTITY + fleet prose); grow only with intent.
    const args1 = result.json?.args || [];
    const aspIdx = args1.indexOf('--append-system-prompt');
    const asp = aspIdx >= 0 ? (args1[aspIdx + 1] || '') : '';
    assert(asp.length >= 400 && asp.length <= 2700,
      `system summary within budget on direct path (got ${asp.length} chars)`);
    assert(/first substantive action MUST be an Agent delegation/.test(asp) &&
      /Never substitute generic built-in agent types/.test(asp),
    'system summary carries the mandatory named-specialist delegation policy');
  }

  console.log('\n1b. Full launcher preserves legacy Bash pattern selection before shared traversal');
  {
    const result = runCthru({
      modelArg: 'posix-model-7',
      extraEnv: { C_THRU_PROXY_ALWAYS: '0' },
      backends: {
        posix_cloud: { kind: 'anthropic', url: 'https://posix-pattern.example' },
      },
      model_routes: {
        're:^posix-model-[[:digit:]]$': 'posix_cloud',
      },
    });
    assert(result.code === 0,
      `launcher exits 0 for legacy Bash-ERE route (got ${result.code}; stderr: ${(result.stderr || '').slice(0, 240)})`);
    assert(result.json?.anthropic_base_url === 'https://posix-pattern.example',
      `legacy Bash-ERE selection reaches the shared target resolver (got ${JSON.stringify(result.json?.anthropic_base_url)})`);
    assert((result.json?.args || []).some(arg => arg === '--model=posix-model-7' || arg === 'posix-model-7'),
      'legacy-pattern launch preserves the requested model argument');
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
      assert(asp2.length >= 400 && asp2.length <= 2700,
        `system summary within budget on proxy path (got ${asp2.length} chars)`);
      assert(/first substantive action MUST be an Agent delegation/.test(asp2) &&
        /Never substitute generic built-in agent types/.test(asp2),
      'proxy-path system summary carries the mandatory named-specialist delegation policy');
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
        // Hook commands must be durable (never under deleted c-thru-session.* shadows).
        const ssCmd = settingsObj.hooks.SessionStart?.[0]?.hooks?.[0]?.command || '';
        assert(ssCmd && !ssCmd.includes('c-thru-session.'),
          `SessionStart command is durable, not ephemeral (got ${ssCmd})`);
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

  // B2: ambient-only ANTHROPIC_API_KEY — never invent proxied-placeholder by default.
  // C_THRU_NO_OAUTH_INJECT=1 blocks host keychain so we exercise ensure_proxy_client_api_key
  // rather than inject_subscription_oauth_from_store filling AUTH_TOKEN from the machine.
  // args:[] forces the transparent path that calls ensure_proxy_client_api_key.
  const b2OllamaCfg = {
    backends: {
      local_ollama: { kind: 'ollama', url: 'http://127.0.0.1:11434' },
    },
    targets: {
      default: { backend: 'local_ollama' },
    },
  };

  console.log('\n5. ambient-only API_KEY (B2): no invent when neither credential present');
  {
    const result = runCthru({
      args: [],
      ...b2OllamaCfg,
      extraEnv: {
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        C_THRU_NO_OAUTH_INJECT: '1',
      },
    });
    if (proxyBindDenied(result)) {
      console.log('  SKIP  B2 no-invent (proxy bind EPERM in this environment)');
    } else {
      assert(result.code === 0, `launcher exits 0 with no ambient creds (got ${result.code}; stderr=${(result.stderr || '').slice(0, 200)})`);
      assert(result.json?.anthropic_api_key == null || result.json?.anthropic_api_key === '',
        `API_KEY not invented (got ${JSON.stringify(result.json?.anthropic_api_key)})`);
      assert(result.json?.anthropic_api_key !== 'proxied-placeholder',
        'API_KEY must not be proxied-placeholder by default');
    }
  }

  console.log('\n6. ambient-only API_KEY (B2): caller-set real key preserved');
  {
    const result = runCthru({
      args: [],
      ...b2OllamaCfg,
      extraEnv: {
        ANTHROPIC_API_KEY: 'sk-ant-ambient-test-key',
        ANTHROPIC_AUTH_TOKEN: '',
        C_THRU_NO_OAUTH_INJECT: '1',
      },
    });
    if (proxyBindDenied(result)) {
      console.log('  SKIP  B2 ambient key (proxy bind EPERM in this environment)');
    } else {
      assert(result.code === 0, `launcher exits 0 with ambient API_KEY (got ${result.code})`);
      assert(result.json?.anthropic_api_key === 'sk-ant-ambient-test-key',
        `ambient API_KEY preserved (got ${JSON.stringify(result.json?.anthropic_api_key)})`);
    }
  }

  console.log('\n7. ambient-only API_KEY (B2): AUTH_TOKEN set → no placeholder invent');
  {
    const result = runCthru({
      args: [],
      ...b2OllamaCfg,
      extraEnv: {
        ANTHROPIC_AUTH_TOKEN: 'fake-oauth-b2',
        ANTHROPIC_API_KEY: '',
        C_THRU_NO_OAUTH_INJECT: '1',
      },
    });
    if (proxyBindDenied(result)) {
      console.log('  SKIP  B2 auth-token path (proxy bind EPERM in this environment)');
    } else {
      assert(result.code === 0, `launcher exits 0 with AUTH_TOKEN (got ${result.code})`);
      assert(result.json?.anthropic_auth_token === 'fake-oauth-b2',
        `AUTH_TOKEN preserved (got ${JSON.stringify(result.json?.anthropic_auth_token)})`);
      assert(result.json?.anthropic_api_key == null || result.json?.anthropic_api_key === '',
        `API_KEY empty when AUTH_TOKEN set (got ${JSON.stringify(result.json?.anthropic_api_key)})`);
    }
  }

  console.log('\n8. ambient-only API_KEY (B2): explicit placeholder opt-in still works');
  {
    const result = runCthru({
      args: [],
      ...b2OllamaCfg,
      extraEnv: {
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        C_THRU_NO_OAUTH_INJECT: '1',
        C_THRU_PROXY_PLACEHOLDER_KEY: '1',
      },
    });
    if (proxyBindDenied(result)) {
      console.log('  SKIP  B2 placeholder opt-in (proxy bind EPERM in this environment)');
    } else {
      assert(result.code === 0, `launcher exits 0 with placeholder opt-in (got ${result.code})`);
      assert(result.json?.anthropic_api_key === 'proxied-placeholder',
        `opt-in placeholder exported (got ${JSON.stringify(result.json?.anthropic_api_key)})`);
    }
  }

  console.log('\n9. ambient-only API_KEY (B2): caller key preserved when AUTH_TOKEN also set');
  {
    // Collar set both — do not wipe API_KEY just because AUTH_TOKEN is present.
    const result = runCthru({
      args: [],
      ...b2OllamaCfg,
      extraEnv: {
        ANTHROPIC_API_KEY: 'sk-ant-collar-both',
        ANTHROPIC_AUTH_TOKEN: 'fake-oauth-both',
        C_THRU_NO_OAUTH_INJECT: '1',
      },
    });
    if (proxyBindDenied(result)) {
      console.log('  SKIP  B2 both-set preserve (proxy bind EPERM in this environment)');
    } else {
      assert(result.code === 0, `launcher exits 0 with both collar creds (got ${result.code})`);
      assert(result.json?.anthropic_auth_token === 'fake-oauth-both',
        `AUTH_TOKEN preserved (got ${JSON.stringify(result.json?.anthropic_auth_token)})`);
      assert(result.json?.anthropic_api_key === 'sk-ant-collar-both',
        `caller API_KEY preserved alongside AUTH_TOKEN (got ${JSON.stringify(result.json?.anthropic_api_key)})`);
    }
  }

  console.log('\n10. ambient-only API_KEY (B2): placeholder value cleared when AUTH_TOKEN present');
  {
    // Collar exported the legacy placeholder string + a Bearer → clear placeholder, keep token.
    const result = runCthru({
      args: [],
      ...b2OllamaCfg,
      extraEnv: {
        ANTHROPIC_API_KEY: 'proxied-placeholder',
        ANTHROPIC_AUTH_TOKEN: 'fake-oauth-clear-ph',
        C_THRU_NO_OAUTH_INJECT: '1',
      },
    });
    if (proxyBindDenied(result)) {
      console.log('  SKIP  B2 placeholder clear (proxy bind EPERM in this environment)');
    } else {
      assert(result.code === 0, `launcher exits 0 with AUTH_TOKEN + placeholder ambient (got ${result.code})`);
      assert(result.json?.anthropic_api_key == null || result.json?.anthropic_api_key === '',
        `placeholder cleared when AUTH_TOKEN set (got ${JSON.stringify(result.json?.anthropic_api_key)})`);
      assert(result.json?.anthropic_auth_token === 'fake-oauth-clear-ph',
        `AUTH_TOKEN preserved (got ${JSON.stringify(result.json?.anthropic_auth_token)})`);
    }
  }

  console.log('\n11. explicit subscription auth mode removes a competing ambient API key');
  {
    const result = runCthru({
      args: [],
      ...b2OllamaCfg,
      captureProxyEnv: true,
      extraEnv: {
        ANTHROPIC_API_KEY: 'sk-ant-must-not-reach-child',
        ANTHROPIC_AUTH_TOKEN: 'fake-subscription-bearer',
        C_THRU_ANTHROPIC_AUTH_MODE: 'subscription',
        C_THRU_NO_OAUTH_INJECT: '1',
      },
    });
    if (proxyBindDenied(result)) {
      console.log('  SKIP  explicit subscription mode (proxy bind EPERM in this environment)');
    } else {
      assert(result.code === 0, `subscription mode launches with Bearer auth (got ${result.code})`);
      assert(result.json?.anthropic_auth_token === 'fake-subscription-bearer',
        `subscription mode preserves Bearer auth (got ${JSON.stringify(result.json?.anthropic_auth_token)})`);
      assert(result.json?.anthropic_api_key == null || result.json?.anthropic_api_key === '',
        `subscription mode strips the ambient API key (got ${JSON.stringify(result.json?.anthropic_api_key)})`);
      assert(result.proxyEnv?.anthropic_api_key == null || result.proxyEnv?.anthropic_api_key === '',
        `subscription mode strips the API key before proxy start (got ${JSON.stringify(result.proxyEnv?.anthropic_api_key)})`);
      assert(result.proxyEnv?.anthropic_auth_token === 'fake-subscription-bearer',
        `subscription Bearer reaches proxy start (got ${JSON.stringify(result.proxyEnv?.anthropic_auth_token)})`);
    }
  }

  console.log('\n12. explicit API auth mode removes competing subscription credentials');
  {
    const result = runCthru({
      args: [],
      ...b2OllamaCfg,
      captureProxyEnv: true,
      extraEnv: {
        ANTHROPIC_API_KEY: 'sk-ant-explicit-api-mode',
        ANTHROPIC_AUTH_TOKEN: 'fake-bearer-must-not-reach-child',
        CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-must-not-reach-child',
        C_THRU_ANTHROPIC_AUTH_MODE: 'api',
      },
    });
    if (proxyBindDenied(result)) {
      console.log('  SKIP  explicit API mode (proxy bind EPERM in this environment)');
    } else {
      assert(result.code === 0, `API mode launches with API-key auth (got ${result.code})`);
      assert(result.json?.anthropic_api_key === 'sk-ant-explicit-api-mode',
        `API mode preserves the API key (got ${JSON.stringify(result.json?.anthropic_api_key)})`);
      assert(result.json?.anthropic_auth_token == null || result.json?.anthropic_auth_token === '',
        `API mode strips competing Bearer auth (got ${JSON.stringify(result.json?.anthropic_auth_token)})`);
      assert(result.json?.claude_code_oauth_token == null || result.json?.claude_code_oauth_token === '',
        `API mode strips competing Claude OAuth auth (got ${JSON.stringify(result.json?.claude_code_oauth_token)})`);
      assert(result.proxyEnv?.anthropic_api_key === 'sk-ant-explicit-api-mode',
        `API key reaches proxy start (got ${JSON.stringify(result.proxyEnv?.anthropic_api_key)})`);
      assert(result.proxyEnv?.anthropic_auth_token == null || result.proxyEnv?.anthropic_auth_token === '',
        `API mode strips Bearer auth before proxy start (got ${JSON.stringify(result.proxyEnv?.anthropic_auth_token)})`);
      assert(result.proxyEnv?.claude_code_oauth_token == null || result.proxyEnv?.claude_code_oauth_token === '',
        `API mode strips Claude OAuth before proxy start (got ${JSON.stringify(result.proxyEnv?.claude_code_oauth_token)})`);
    }
  }

  console.log('\n13. invalid explicit auth mode fails before Claude launch');
  {
    const result = runCthru({
      args: [],
      ...b2OllamaCfg,
      extraEnv: { C_THRU_ANTHROPIC_AUTH_MODE: 'surprise' },
    });
    assert(result.code === 2, `invalid auth mode exits 2 (got ${result.code})`);
    assert(/expected auto, subscription, or api/.test(result.stderr || ''),
      `invalid auth mode reports accepted values (got ${(result.stderr || '').slice(0, 200)})`);
  }

  console.log('\n14. explicit API auth mode fails closed without an API key');
  {
    const result = runCthru({
      modelArg: 'claude-sonnet-5',
      extraEnv: {
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: 'fake-bearer-must-be-cleared',
        C_THRU_ANTHROPIC_AUTH_MODE: 'api',
        C_THRU_PROXY_ALWAYS: '0',
      },
      backends: {
        anthropic: { kind: 'anthropic', url: 'https://anthropic.example' },
      },
    });
    assert(result.code === 2, `API mode without a key exits 2 (got ${result.code})`);
    assert(/requires ANTHROPIC_API_KEY/.test(result.stderr || ''),
      `API mode without a key reports the missing credential (got ${(result.stderr || '').slice(0, 200)})`);
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
