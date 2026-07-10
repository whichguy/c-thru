#!/usr/bin/env node
'use strict';
// F2 — forwardAnthropic() never wired client-disconnect to abort the upstream
// request: when the Claude Code client disconnected mid-stream, the upstream
// connection (to real Anthropic, OpenRouter, or default/modern Ollama
// /v1/messages) kept running — continuing to generate/bill tokens no client
// would ever read — with no cleanup.
//
// test/proxy-client-disconnect-cleanup.test.js already covers this for the
// LEGACY Ollama path (forwardOllamaLegacy / setupOllamaStream, via
// legacy_ollama_chat:true) but that is a structurally different function.
// This test targets forwardAnthropic directly (format:"anthropic", the
// default dispatch path for real Anthropic/OpenRouter/modern-Ollama) and
// asserts the UPSTREAM stub itself observes the connection torn down — not
// just that the proxy process stays alive.
//
// Run: node test/proxy-anthropic-disconnect-cleanup.test.js

const http = require('http');
const net  = require('net');
const {
  assert, assertEq, summary,
  writeConfig, withProxy,
} = require('./helpers');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

console.log('proxy anthropic-path client disconnect cleanup test (F2)\n');

// Anthropic-shape SSE stub that streams content_block_delta events slowly,
// giving the test time to observe streaming has started before disconnecting.
// Tracks whether the upstream connection (this stub's `res`) is torn down —
// the direct signal that the proxy called up.destroy() on client disconnect.
function slowAnthropicSseStub(opts = {}) {
  const { chunkDelayMs = 100, totalChunks = 50 } = opts;
  const requests = [];
  let upstreamClosed = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({ method: req.method, path: req.url, body });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_stub', usage: { input_tokens: 5 } },
      })}\n\n`);

      let i = 0;
      let timer = null;
      const tick = () => {
        if (!res.writable) return;
        if (i >= totalChunks) {
          res.write(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta', delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: totalChunks },
          })}\n\n`);
          res.end();
          return;
        }
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: `chunk-${i} ` },
        })}\n\n`);
        i++;
        timer = setTimeout(tick, chunkDelayMs);
      };
      // The stub's `res` shares the underlying socket with the proxy's
      // outgoing `up` request. When the proxy tears `up` down (F2 fix), this
      // socket closes and 'close' fires here — the direct observable proof
      // the upstream request was actually aborted, not just left hanging.
      res.on('close', () => { upstreamClosed = true; if (timer) clearTimeout(timer); });
      tick();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        requests,
        upstreamWasClosed: () => upstreamClosed,
        close: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

// Opens a raw TCP socket to the proxy, sends a minimal streaming
// /v1/messages request, reads the first bytes (proving the stream started),
// then abruptly destroys the socket — simulating a client that crashes
// mid-stream.
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
      if (!disconnected && (
        received.includes('text/event-stream') ||
        received.includes('message_start')
      )) {
        disconnected = true;
        // Small delay so the proxy receives the 'close' event cleanly.
        setTimeout(() => {
          socket.destroy();
          resolve({ received, disconnectedAfterBytes: received.length });
        }, 20);
      }
    });

    socket.on('error', err => {
      if (disconnected) resolve({ received, disconnectedAfterBytes: received.length });
      else reject(err);
    });

    socket.on('close', () => {
      if (!disconnected) resolve({ received, disconnectedAfterBytes: received.length });
    });

    setTimeout(() => {
      if (!disconnected) {
        socket.destroy();
        reject(new Error('clientDisconnectMidStream: streaming never started within 5s'));
      }
    }, 5000);
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-anth-disconnect-'));
  try {
    console.log('1. Client disconnect mid-stream on the default anthropic-shape path tears down the upstream');
    const stub = await slowAnthropicSseStub({ chunkDelayMs: 100, totalChunks: 50 });
    try {
      const cfg = {
        endpoints: {
          stub_anthropic: { format: 'anthropic', url: `http://127.0.0.1:${stub.port}`, auth: 'none' },
        },
        model_routes: { 'test-model': 'stub_anthropic' },
        llm_profiles: {
          '64gb': { workhorse: { connected_model: 'test-model', disconnect_model: 'test-model' } },
        },
      };
      const configPath = writeConfig(tmpDir, cfg);

      await withProxy({ configPath, profile: '64gb', mode: 'connected' }, async ({ port }) => {
        const result = await clientDisconnectMidStream(port, {
          model: 'test-model',
          stream: true,
          messages: [{ role: 'user', content: 'test anthropic-path disconnect cleanup' }],
          max_tokens: 200,
        });

        assert(result.disconnectedAfterBytes > 0, `received bytes before disconnect (${result.disconnectedAfterBytes})`);
        assert(result.received.includes('text/event-stream') || result.received.includes('message_start'),
          'SSE streaming had started before disconnect');

        // Give the proxy a moment to observe the client 'close' and tear the
        // upstream down, then verify the STUB itself saw its connection close
        // — the direct signal that up.destroy() actually ran (F2), not just
        // that the proxy process is still alive.
        await new Promise(r => setTimeout(r, 500));
        assert(stub.upstreamWasClosed(),
          'upstream connection was torn down after client disconnect (proxy stopped consuming/billing tokens)');

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
      await stub.close().catch(() => {});
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
