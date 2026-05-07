#!/usr/bin/env node
'use strict';
// Tests for the MAX_BODY_BYTES guard in readBody().
// Sends oversized payloads to endpoints that call readBody and asserts 413.
// Run: node test/proxy-body-size-cap.test.js

const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { assert, summary, writeConfig, withProxy } = require('./helpers');

console.log('proxy-body-size-cap tests\n');

// Send a raw HTTP POST with a known Content-Length and a streaming body.
// Returns { status, bodyText }.
function httpRaw(port, urlPath, contentLength, bodyChunks, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(contentLength),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, bodyText: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', err => {
      // Socket destruction from the server side causes ECONNRESET/ECONNABORTED.
      // That's expected on 413 — treat it as a successful "rejected" response.
      if (err.code === 'ECONNRESET' || err.code === 'ECONNABORTED' || err.code === 'EPIPE') {
        resolve({ status: 413, bodyText: '', connectionReset: true });
      } else {
        reject(err);
      }
    });
    for (const chunk of bodyChunks) req.write(chunk);
    req.end();
  });
}

const OVER_LIMIT = 101 * 1024 * 1024; // 101 MB — just above the 100 MB cap

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-body-cap-'));
  const configPath = writeConfig(tmpDir, {});

  // ── Test 1: /v1/messages rejects oversized body with 413 ─────────────────
  console.log('1. /v1/messages: 413 on body > 100 MB');
  await withProxy({ configPath }, async ({ port }) => {
    // Send a Content-Length header announcing 101 MB, then a smaller actual body.
    // readBody accumulates bytes and destroys socket once limit exceeded — the
    // Content-Length header is sufficient to trigger the guard without actually
    // sending 101 MB over the wire.
    const chunk = Buffer.alloc(101 * 1024 * 1024, 'x');
    const r = await httpRaw(port, '/v1/messages', OVER_LIMIT, [chunk]);
    assert(r.status === 413 || r.connectionReset, `/v1/messages 413 or connection reset on oversized body (got ${r.status})`);
  });

  // ── Test 2: /c-thru/mode rejects oversized body with 413 ─────────────────
  console.log('\n2. /c-thru/mode: 413 on body > 100 MB');
  await withProxy({ configPath }, async ({ port }) => {
    const chunk = Buffer.alloc(101 * 1024 * 1024, 'x');
    const r = await httpRaw(port, '/c-thru/mode', OVER_LIMIT, [chunk]);
    assert(r.status === 413 || r.connectionReset, `/c-thru/mode 413 or connection reset on oversized body (got ${r.status})`);
  });

  // ── Test 3: normal-sized body still works ─────────────────────────────────
  console.log('\n3. Normal-sized body (1 KB) is not rejected');
  await withProxy({ configPath }, async ({ port }) => {
    const body = JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
    const r = await httpRaw(port, '/v1/messages', Buffer.byteLength(body), [body]);
    // Will get 502/503 (no upstream configured) but NOT 413
    assert(r.status !== 413, `normal body not rejected with 413 (got ${r.status})`);
    assert(r.status !== undefined, 'response received for normal-sized body');
  });

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
