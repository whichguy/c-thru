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

function runCthru({ modelArg, ...config }) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-launch-'));
  const homeDir = path.join(tmpRoot, 'home');
  const fakeBin = path.join(tmpRoot, 'bin');
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.symlinkSync(path.join(__dirname, '..', 'tools'), path.join(homeDir, '.claude', 'tools'));
  makeStubClaude(fakeBin);

  const configPath = path.join(tmpRoot, 'model-map.json');
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

  const result = spawnSync(CTHRU, ['--model', modelArg], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CLAUDE_MODEL_MAP_PATH: configPath,
      CLAUDE_ROUTER_NO_UPDATE: '1',
      C_THRU_SKIP_PREPULL: '1',
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

async function main() {
  console.log('c-thru target launch tests\n');

  console.log('1. Unmatched labels ignore targets.default during launcher backend selection');
  {
    const result = runCthru({
      modelArg: 'claude-sonnet-4-6',
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
      `legacy anthropic autodetect wins over targets.default (got ${JSON.stringify(result.json?.anthropic_base_url)})`);
    assert((result.json?.args || []).some(arg => arg === '--model=claude-sonnet-4-6' || arg === 'claude-sonnet-4-6'),
      `forwarded args preserve unmatched model label (got ${JSON.stringify(result.json?.args)})`);
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
    assert(result.code === 0, `launcher exits 0 for explicit target id (got ${result.code})`);
    assert(typeof result.json?.anthropic_base_url === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(result.json.anthropic_base_url),
      `explicit target uses proxy mediation instead of direct provider URL (got ${JSON.stringify(result.json?.anthropic_base_url)})`);
    assert((result.json?.args || []).some(arg => arg === '--model=explicit-target' || arg === 'explicit-target'),
      `forwarded args preserve explicit target label (got ${JSON.stringify(result.json?.args)})`);
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
