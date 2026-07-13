#!/usr/bin/env node
'use strict';
// Response interpretation: compressed success bodies must reach the client
// intact (pipe + Content-Encoding). Proxy usage tee must not corrupt the pipe.
//
// Also: sibling require of upstream-error-body resolves via realpath of
// claude-proxy (session/install symlink layout).
//
// Run: node test/proxy-response-pipe.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const { assert, assertEq, summary, writeConfig, withProxy, httpJson } = require('./helpers');
const { isCompressedEncoding } = require('../tools/upstream-error-body.js');

console.log('proxy response pipe + interpretation\n');

function gzip200Stub(payloadObj) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const json = JSON.stringify(payloadObj);
      const gz = zlib.gzipSync(Buffer.from(json, 'utf8'));
      res.writeHead(200, {
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

function buildConfig(stubPort) {
  return {
    backends: {
      stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    model_routes: { 'pipe-model': 'stub' },
    llm_profiles: {
      workhorse: {
        'best-cloud': { '128gb': 'pipe-model' },
        on_failure: 'hard_fail',
      },
    },
  };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-resp-pipe-'));

  try {
    console.log('1. unit: isCompressedEncoding');
    {
      assertEq(isCompressedEncoding('gzip'), true, 'gzip is compressed');
      assertEq(isCompressedEncoding('br'), true, 'br is compressed');
      assertEq(isCompressedEncoding('identity'), false, 'identity is not compressed');
      assertEq(isCompressedEncoding(undefined), false, 'missing is not compressed');
    }

    console.log('\n2. gzip 200 success: client receives Content-Encoding + gunzippable body');
    {
      const payload = {
        id: 'msg_gz',
        type: 'message',
        role: 'assistant',
        model: 'pipe-model',
        stop_reason: 'end_turn',
        stop_sequence: null,
        content: [{ type: 'text', text: 'hello from gzip upstream' }],
        usage: { input_tokens: 3, output_tokens: 5 },
      };
      const stub = await gzip200Stub(payload);
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
            // Raw request so we can inspect encoding + body bytes
            const raw = await new Promise((resolve, reject) => {
              const body = JSON.stringify({
                model: 'pipe-model',
                max_tokens: 16,
                messages: [{ role: 'user', content: 'hi' }],
              });
              const req = http.request(
                {
                  hostname: '127.0.0.1',
                  port,
                  path: '/v1/messages',
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                  },
                },
                (res) => {
                  const chunks = [];
                  res.on('data', (c) => chunks.push(c));
                  res.on('end', () => {
                    resolve({
                      status: res.statusCode,
                      headers: res.headers,
                      buf: Buffer.concat(chunks),
                    });
                  });
                }
              );
              req.on('error', reject);
              req.setTimeout(8000, () => {
                req.destroy();
                reject(new Error('timeout'));
              });
              req.write(body);
              req.end();
            });

            assertEq(raw.status, 200, 'status 200');
            const enc = (raw.headers['content-encoding'] || '').toLowerCase();
            assertEq(enc, 'gzip', 'Content-Encoding: gzip preserved for client');
            let decoded;
            try {
              decoded = zlib.gunzipSync(raw.buf).toString('utf8');
            } catch (e) {
              assert(false, 'body is valid gzip (got ' + e.message + ')');
              return;
            }
            const obj = JSON.parse(decoded);
            assertEq(
              obj.content && obj.content[0] && obj.content[0].text,
              'hello from gzip upstream',
              'gunzipped content matches upstream payload'
            );
          }
        );
      } finally {
        await stub.close().catch(() => {});
      }
    }

    console.log('\n3. /s/<session-id> path still reaches messages (strip does not break body)');
    {
      const payload = {
        id: 'msg_s',
        type: 'message',
        role: 'assistant',
        model: 'pipe-model',
        stop_reason: 'end_turn',
        stop_sequence: null,
        content: [{ type: 'text', text: 'scoped ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      // Uncompressed success for easy httpJson parse
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        });
      });
      const stubPort = await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        server.on('error', reject);
      });
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stubPort));
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
              '/s/audit-session-1/v1/messages',
              {
                model: 'pipe-model',
                max_tokens: 8,
                messages: [{ role: 'user', content: 'hi' }],
              },
              {},
              8000
            );
            assertEq(res.status, 200, 'scoped path returns 200');
            assertEq(
              res.body && res.body.content && res.body.content[0] && res.body.content[0].text,
              'scoped ok',
              'session-prefixed URL delivers correct body'
            );
          }
        );
      } finally {
        await new Promise((r) => server.close(r));
      }
    }

    console.log('\n4. sibling module resolves from realpath of claude-proxy symlink');
    {
      const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-tools-link-'));
      const repoProxy = path.resolve(__dirname, '..', 'tools', 'claude-proxy');
      const linkProxy = path.join(toolsDir, 'claude-proxy');
      fs.symlinkSync(repoProxy, linkProxy);
      // Intentionally do NOT place upstream-error-body next to the symlink.
      const resolved = require('module').createRequire(linkProxy);
      let mod;
      try {
        // require relative to the *resolved* main path — same as Node loading the symlink.
        mod = require(path.resolve(path.dirname(fs.realpathSync(linkProxy)), 'upstream-error-body.js'));
      } catch (e) {
        assert(false, 'realpath sibling require failed: ' + e.message);
      }
      assert(typeof mod.formatUpstreamErrorMessage === 'function', 'formatUpstreamErrorMessage exported');
      try {
        fs.rmSync(toolsDir, { recursive: true, force: true });
      } catch {}
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
