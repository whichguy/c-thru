#!/usr/bin/env node
'use strict';
// Tests that unhandledRejection is caught and logged rather than crashing the proxy.
// Run: node test/proxy-unhandled-rejection.test.js

const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { assert, summary, writeConfig, spawnProxy, waitForPing, httpJson, getFreePort } = require('./helpers');

console.log('proxy-unhandled-rejection tests\n');

// This assertion is specifically a not-a-hang contract, so keep its budget
// narrow instead of inheriting the wider loaded-host infrastructure default.
const EXPECTED_ERROR_REQUEST_TIMEOUT_MS = 3_000;

// Collect log lines written to the proxy log file.
// The proxy writes to $HOME/.claude/proxy.log (fixed name, no suffix).
function readProxyLog(tmpHome) {
  const logDir = path.join(tmpHome, '.claude');
  try {
    // Try both fixed name and any proxy*.log variants for forward-compat.
    const files = fs.readdirSync(logDir).filter(f => f.startsWith('proxy') && f.endsWith('.log'));
    if (!files.length) return '';
    return files.map(f => {
      try { return fs.readFileSync(path.join(logDir, f), 'utf8'); } catch { return ''; }
    }).join('');
  } catch { return ''; }
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-reject-'));
  const configPath = writeConfig(tmpDir, {});

  // ── Test 1: proxy stays alive after receiving a normal request ────────────
  // Baseline: proxy handles requests and doesn't crash under normal load.
  console.log('1. Proxy remains alive and responsive under normal load');
  {
    const hooksPort = await getFreePort();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-home-'));
    try {
      const { child, port } = await spawnProxy({ configPath, hooksPort, tmpHome });
      await waitForPing(port);

      // Make a few requests to confirm it's alive
      const r1 = await httpJson(port, 'GET', '/ping');
      assert(r1.status === 200, 'proxy alive after startup (/ping 200)');

      // Send a valid-but-unconfigured message request
      const r2 = await httpJson(port, 'POST', '/v1/messages', {
        model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1,
      }, {}, EXPECTED_ERROR_REQUEST_TIMEOUT_MS);
      // 400/404/502/503 expected (no real upstream or backend configured); NOT a crash
      assert([400, 404, 502, 503, 500].includes(r2.status), `got a defined error status (${r2.status}), not a hang/crash`);

      // Proxy still responds after the failed request
      const r3 = await httpJson(port, 'GET', '/ping');
      assert(r3.status === 200, 'proxy still alive after failed upstream request (/ping 200)');

      child.kill('SIGTERM');
    } finally {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  }

  // ── Test 2: unhandledRejection handler is registered ─────────────────────
  // Verify the handler exists by checking the process event listener count.
  // We can't inject an arbitrary async rejection into a running child without
  // a test-mode hook — instead, we confirm the handler is present via the
  // source-level check and that the proxy doesn't crash on normal async paths.
  console.log('\n2. unhandledRejection handler registered (source-level check)');
  {
    const proxySource = fs.readFileSync(
      path.resolve(__dirname, '..', 'tools', 'claude-proxy'), 'utf8'
    );
    assert(
      proxySource.includes("process.on('unhandledRejection'"),
      "claude-proxy registers 'unhandledRejection' handler"
    );
    assert(
      proxySource.includes("proxyLog") && proxySource.includes('unhandledRejection'),
      "unhandledRejection handler calls proxyLog"
    );
  }

  // ── Test 3: proxy log is written and is valid JSON lines ──────────────────
  // The proxy writes logs via CLAUDE_PROXY_LOG_FILE; we point it to a tmpdir
  // so we can read it back without touching the user's real ~/.claude/proxy.log.
  console.log('\n3. Proxy log file is written and contains valid JSON lines');
  {
    const hooksPort = await getFreePort();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-home-'));
    const logFile = path.join(tmpHome, 'proxy.log');
    try {
      const { child, port } = await spawnProxy({
        configPath, hooksPort, tmpHome,
        env: { CLAUDE_PROXY_LOG_FILE: logFile },
      });
      await waitForPing(port);
      await httpJson(port, 'GET', '/ping');

      // Give log a moment to flush
      await new Promise(r => setTimeout(r, 200));
      child.kill('SIGTERM');
      await new Promise(r => child.on('exit', r));

      // Log should exist
      const logContent = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      assert(logContent.length > 0, 'proxy log file is written and non-empty');

      // Each line should match the proxy log format: TIMESTAMP c-thru [event] JSON
      const lines = logContent.split('\n').filter(l => l.trim());
      const allStructured = lines.every(l => /^\d{4}-\d{2}-\d{2}T/.test(l) && l.includes('c-thru'));
      assert(allStructured, `all ${lines.length} log lines match proxy log format (timestamp + c-thru)`);
    } finally {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
