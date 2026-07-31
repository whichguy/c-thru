#!/usr/bin/env node
'use strict';
// P4: Claude Code correlation header preserve/scrub policy.
// - preserve_claude_code_correlation: true  → forward x-claude-code-* 
// - false / non-anthropic stub default       → scrub
// Run: node test/proxy-correlation-headers.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assert, assertEq, summary,
  stubBackend, writeConfig, httpJson, spawnProxy, waitForPing,
} = require('./helpers');

console.log('proxy-correlation-headers tests\n');

const CORR = {
  'x-claude-code-session-id': 'session-corr-test',
  'x-claude-code-agent-id': 'agent-corr-test',
  'x-claude-code-parent-agent-id': 'parent-corr-test',
};

async function runCase(label, backendExtra, expectPreserve) {
  const stub = await stubBackend();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-corr-'));
  const configPath = writeConfig(tmpHome, {
    backends: {
      stub: Object.assign({
        kind: 'anthropic',
        url: `http://127.0.0.1:${stub.port}`,
      }, backendExtra || {}),
    },
    model_routes: { 'corr-model': 'stub' },
  });
  const { child, port } = await spawnProxy({
    configPath,
    tmpHome,
    env: { CLAUDE_LLM_MODE: 'best-cloud', CLAUDE_LLM_MEMORY_GB: '16' },
  });
  await waitForPing(port);
  try {
    const r = await httpJson(port, 'POST', '/v1/messages', {
      model: 'corr-model',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
    }, Object.assign({
      'x-api-key': 'test',
      'anthropic-version': '2023-06-01',
    }, CORR));
    assertEq(r.status, 200, `${label}: 200`);
    const seen = stub.requests[stub.requests.length - 1] || {};
    const h = seen.headers || {};
    for (const name of Object.keys(CORR)) {
      const present = Object.prototype.hasOwnProperty.call(h, name)
        || Object.prototype.hasOwnProperty.call(h, name.toLowerCase());
      if (expectPreserve) {
        assert(present, `${label}: upstream receives ${name}`);
      } else {
        assert(!present, `${label}: upstream does not receive ${name}`);
      }
    }
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    try { await stub.close(); } catch {}
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  console.log('1. default loopback stub scrubs correlation headers');
  await runCase('default scrub', {}, false);

  console.log('2. preserve_claude_code_correlation: true forwards headers');
  await runCase('explicit preserve', { preserve_claude_code_correlation: true }, true);

  console.log('3. preserve_claude_code_correlation: false scrubs even if set');
  await runCase('explicit scrub', { preserve_claude_code_correlation: false }, false);

  process.exit(summary() ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
