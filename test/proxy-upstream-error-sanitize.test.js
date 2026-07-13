#!/usr/bin/env node
'use strict';
// Integration: gzip-compressed Anthropic 429 bodies must surface as clean
// error.message through the proxy — never raw compressed bytes.
//
// Run: node test/proxy-upstream-error-sanitize.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const { assert, assertEq, summary, writeConfig, withProxy, httpJson } = require('./helpers');

console.log('proxy upstream error sanitize (gzip 429)\n');

function gzip429Stub() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const payload = JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Number of request tokens has exceeded your rate limit',
        },
      });
      const gz = zlib.gzipSync(Buffer.from(payload, 'utf8'));
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': gz.length,
      });
      res.end(gz);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

function binary429Stub() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.from([0x1f, 0x8b, 0xff, 0x00, 0x80, 0x81, 0x82, 0x00, 0x01]);
      res.writeHead(429, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': raw.length,
      });
      res.end(raw);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

function buildConfig(stubPort) {
  return {
    backends: {
      stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    model_routes: {
      'err-model': 'stub',
    },
    // No fallback chain — original 429 must reach the client.
    llm_profiles: {
      workhorse: {
        'best-cloud': { '128gb': 'err-model' },
        on_failure: 'hard_fail',
      },
    },
  };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-err-sanitize-'));

  try {
    // ── gzip JSON 429 ──────────────────────────────────────────────────────
    console.log('1. gzip-compressed Anthropic 429 JSON → clean error.message');
    {
      const stub = await gzip429Stub();
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy(
          {
            configPath,
            profile: '128gb',
            mode: 'best-cloud',
            env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
          },
          async ({ port }) => {
            const res = await httpJson(
              port,
              'POST',
              '/v1/messages',
              {
                model: 'err-model',
                max_tokens: 16,
                messages: [{ role: 'user', content: 'hi' }],
              },
              {},
              8000
            );
            assertEq(res.status, 429, 'status is 429');
            const msg = res.body && res.body.error && res.body.error.message;
            assert(typeof msg === 'string' && msg.length > 0, 'error.message is a non-empty string');
            assert(
              /rate limit/i.test(msg),
              'error.message mentions rate limit (got ' + JSON.stringify(msg) + ')'
            );
            assert(
              !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(msg),
              'error.message has no C0 control characters'
            );
            assert(
              !msg.includes('\u001f'),
              'error.message is not raw gzip bytes'
            );
            assert(
              res.body.error.type === 'rate_limit_error',
              'error.type is rate_limit_error (got ' + (res.body.error && res.body.error.type) + ')'
            );
          }
        );
      } finally {
        await stub.close().catch(() => {});
      }
    }

    // ── binary non-JSON 429 ────────────────────────────────────────────────
    console.log('\n2. binary non-JSON 429 → clean status-ish message, no C0 controls');
    {
      const bin = await binary429Stub();
      try {
        const configPath = writeConfig(tmpDir, buildConfig(bin.port));
        await withProxy(
          {
            configPath,
            profile: '128gb',
            mode: 'best-cloud',
            env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
          },
          async ({ port }) => {
            const res = await httpJson(
              port,
              'POST',
              '/v1/messages',
              {
                model: 'err-model',
                max_tokens: 16,
                messages: [{ role: 'user', content: 'hi' }],
              },
              {},
              8000
            );
            assertEq(res.status, 429, 'binary stub status is 429');
            const msg = res.body && res.body.error && res.body.error.message;
            assert(typeof msg === 'string' && msg.length > 0, 'binary body still yields a message');
            assert(
              !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(msg),
              'binary-derived message has no C0 controls (got ' + JSON.stringify(msg) + ')'
            );
            assert(
              /backend |upstream returned|non-text|429|rate/i.test(msg),
              'binary message is a clean status-ish string (got ' + JSON.stringify(msg) + ')'
            );
          }
        );
      } finally {
        await bin.close().catch(() => {});
      }
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }

  process.exit(summary() === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
