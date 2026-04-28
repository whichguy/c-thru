#!/usr/bin/env node
'use strict';
// End-to-end tests: invokes c-thru directly as a subprocess with -p (non-interactive).
// Tests the full stack: c-thru → proxy spawn → Ollama → response.
//
// Requires: Ollama running at localhost:11434 with qwen3:1.7b pulled.
// Skips gracefully when Ollama is unreachable.
//
// Run with: node test/proxy-e2e.test.js

const http         = require('http');
const { execFile } = require('child_process');
const path         = require('path');

const { assert, assertEq, summary } = require('./helpers');

console.log('proxy-e2e integration tests (c-thru -p)\n');

// ── Constants ──────────────────────────────────────────────────────────────

const REPO_ROOT      = path.join(__dirname, '..');
const C_THRU         = path.join(REPO_ROOT, 'tools', 'c-thru');
const E2E_MODEL      = 'qwen3:1.7b';    // smallest available; already pulled
const E2E_TIMEOUT_MS = 60_000;          // real inference can take up to 60s

const IDENTITY_PROMPT = 'what is your model name, where were you born, model id and who is your maker?';

// ── Helpers ────────────────────────────────────────────────────────────────

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
    const proc = execFile(C_THRU, args, { timeout: E2E_TIMEOUT_MS }, (err, stdout, stderr) => {
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
    assert(r.stdout.trim().length > 0, 'direct route: stdout is non-empty');
    console.log(`  response: ${r.stdout.trim().slice(0, 120)}…`);
  }

  // ── Test 2: offline mode ───────────────────────────────────────────────────
  console.log('\n2. Offline mode (--mode offline forces local model)');
  {
    const r = await runCThru(E2E_MODEL, ['--mode', 'offline']);
    assertEq(r.exitCode, 0, `offline: exit code 0 (got ${r.exitCode})`);
    assert(r.stdout.trim().length > 0, 'offline: stdout is non-empty');
    console.log(`  response: ${r.stdout.trim().slice(0, 120)}…`);
  }

  // ── Test 3: default route (no explicit model) ──────────────────────────────
  console.log('\n3. Default route (c-thru -p "..." — no --model flag)');
  {
    const r = await new Promise((resolve, reject) => {
      const args = ['-p', IDENTITY_PROMPT];
      execFile(C_THRU, args, { timeout: E2E_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err && err.killed) { reject(new Error(`timed out.\nstderr: ${stderr.slice(0, 500)}`)); return; }
        resolve({ exitCode: err ? (err.code || 1) : 0, stdout, stderr });
      });
    });
    assertEq(r.exitCode, 0, `default route: exit code 0 (got ${r.exitCode})`);
    assert(r.stdout.trim().length > 0, 'default route: stdout is non-empty');
    console.log(`  response: ${r.stdout.trim().slice(0, 120)}…`);
  }

  const failed = summary();
  if (_skipped) console.log(`(${_skipped} skipped)`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
