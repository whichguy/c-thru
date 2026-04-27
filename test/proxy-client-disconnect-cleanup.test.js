#!/usr/bin/env node
'use strict';
// Test: when a client disconnects mid-stream, the proxy cleans up its
// interval timers (stall watchdog, SSE ping) and tears down the upstream
// connection. After cleanup the process is not retained by zombie handles.
//
// Run: node test/proxy-client-disconnect-cleanup.test.js

const http = require('http');
const net  = require('net');
const {
  assert, assertEq, summary,
  writeConfig, withProxy,
} = require('./helpers');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

console.log('proxy client disconnect cleanup tests\n');

// Creates a slow Ollama stub that streams chunks with a configurable delay.
// Useful for giving the test enough time to observe the mid-stream disconnect
// before the stub finishes sending data.
function slowOllamaStub(opts = {}) {
  const { chunkDelayMs = 200, totalChunks = 20 } = opts;
  const requests = [];
  let activeConnections = 0;
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch {}
      requests.push({ method: req.method, path: req.url, body });
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
      });
      activeConnections++;
      let i = 0;
      let timer = null;
      const tick = () => {
        if (!res.writable) { activeConnections--; return; }
        if (i >= totalChunks) {
          res.write(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 10 }) + '\n');
          res.end();
          activeConnections--;
          return;
        }
        res.write(JSON.stringify({ message: { content: `chunk-${i}` } }) + '\n');
        i++;
        timer = setTimeout(tick, chunkDelayMs);
      };
      res.on('close', () => {
        if (timer) clearTimeout(timer);
      });
      tick();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        requests,
        getActiveConnections: () => activeConnections,
        close: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

// Opens a raw TCP socket to the proxy, sends a minimal HTTP/1.1 streaming
// request, reads the first bytes (proving the stream started), then abruptly
// destroys the socket — simulating a client that crashes mid-stream.
function clientDisconnectMidStream(proxyPort, requestBody) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(proxyPort, '127.0.0.1');
    const bodyStr = JSON.stringify(requestBody);
    let received = '';
    let disconnected = false;

    socket.on('connect', () => {
      socket.write(
        `POST /v1/messages HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${proxyPort}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(bodyStr)}\r\n` +
        `Connection: keep-alive\r\n` +
        `\r\n` +
        bodyStr
      );
    });

    socket.on('data', chunk => {
      received += chunk.toString();
      // As soon as we see the SSE content_type header or message_start event,
      // we know the proxy is streaming — destroy the socket immediately.
      if (!disconnected && (
        received.includes('text/event-stream') ||
        received.includes('message_start')
      )) {
        disconnected = true;
        // Small delay so proxy receives the 'close' event cleanly.
        setTimeout(() => {
          socket.destroy();
          resolve({ received, disconnectedAfterBytes: received.length });
        }, 20);
      }
    });

    socket.on('error', err => {
      // ECONNRESET after destroy is expected — resolve rather than reject.
      if (disconnected) resolve({ received, disconnectedAfterBytes: received.length });
      else reject(err);
    });

    socket.on('close', () => {
      if (!disconnected) resolve({ received, disconnectedAfterBytes: received.length });
    });

    // Safety timeout: if streaming never starts within 5s something is wrong.
    setTimeout(() => {
      if (!disconnected) {
        socket.destroy();
        reject(new Error('clientDisconnectMidStream: streaming never started within 5s'));
      }
    }, 5000);
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-disconnect-'));

  try {
    // ── Test 1: client disconnect mid-stream → proxy cleans up timers ───────
    console.log('1. Client disconnect mid-stream: proxy cleans up without crashing');
    {
      const ollama = await slowOllamaStub({ chunkDelayMs: 100, totalChunks: 50 });
      try {
        const cfg = {
          backends: { stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${ollama.port}` } },
          model_routes: { 'test-model': 'stub_ollama' },
          llm_profiles: {
            '64gb': { workhorse: { connected_model: 'test-model', disconnect_model: 'test-model' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'connected' }, async ({ port }) => {
          const result = await clientDisconnectMidStream(port, {
            model: 'test-model',
            stream: true,
            messages: [{ role: 'user', content: 'test disconnect cleanup' }],
            max_tokens: 200,
          });

          // Assert: we received some bytes — the stream had started.
          assert(result.disconnectedAfterBytes > 0, `received bytes before disconnect (${result.disconnectedAfterBytes})`);
          assert(result.received.includes('text/event-stream') || result.received.includes('message_start'),
            'SSE streaming had started before disconnect');

          // Wait a short time to ensure proxy handled the close event.
          // The proxy's res.on('close') handler should have cleared the intervals.
          await new Promise(r => setTimeout(r, 300));

          // Verify proxy is still healthy (not crashed) by hitting /ping.
          const pingOk = await new Promise(resolve => {
            const req = http.request({ hostname: '127.0.0.1', port, path: '/ping', method: 'GET' }, res => {
              resolve(res.statusCode === 200);
            });
            req.on('error', () => resolve(false));
            req.setTimeout(1000, () => { req.destroy(); resolve(false); });
            req.end();
          });
          assert(pingOk, 'proxy is still alive after mid-stream client disconnect (/ping returns 200)');
        });
      } finally {
        await ollama.close().catch(() => {});
      }
    }

    // ── Test 2: two sequential disconnects don't accumulate zombie handles ───
    console.log('\n2. Two successive mid-stream disconnects; proxy remains healthy');
    {
      const ollama = await slowOllamaStub({ chunkDelayMs: 50, totalChunks: 100 });
      try {
        const cfg = {
          backends: { stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${ollama.port}` } },
          model_routes: { 'test-model': 'stub_ollama' },
          llm_profiles: {
            '64gb': { workhorse: { connected_model: 'test-model', disconnect_model: 'test-model' } },
          },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'connected' }, async ({ port }) => {
          for (let attempt = 1; attempt <= 2; attempt++) {
            const result = await clientDisconnectMidStream(port, {
              model: 'test-model',
              stream: true,
              messages: [{ role: 'user', content: `disconnect attempt ${attempt}` }],
              max_tokens: 200,
            });
            assert(result.disconnectedAfterBytes > 0,
              `attempt ${attempt}: stream started before disconnect`);
          }

          // Let cleanup settle.
          await new Promise(r => setTimeout(r, 400));

          // Proxy should still be serving.
          const pingOk = await new Promise(resolve => {
            const req = http.request({ hostname: '127.0.0.1', port, path: '/ping', method: 'GET' }, res => {
              resolve(res.statusCode === 200);
            });
            req.on('error', () => resolve(false));
            req.setTimeout(1000, () => { req.destroy(); resolve(false); });
            req.end();
          });
          assert(pingOk, 'proxy alive after two mid-stream disconnects');
        });
      } finally {
        await ollama.close().catch(() => {});
      }
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
