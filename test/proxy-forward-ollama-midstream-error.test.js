#!/usr/bin/env node
'use strict';
// Test: mid-stream malformed JSON from Ollama doesn't crash the proxy —
// parse errors are logged and skipped; well-formed chunks still reach the client.
//
// Run: node test/proxy-forward-ollama-midstream-error.test.js

const http = require('http');
const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpStream,
} = require('./helpers');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

console.log('proxy forward ollama midstream error tests\n');

// Build an Ollama-like ndjson stub that interleaves a malformed JSON line
// between valid chunks. The proxy should silently skip the bad line,
// continue, and eventually close the stream cleanly.
function malformedOllamaStub(chunks) {
  const requests = [];
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
      let i = 0;
      const tick = () => {
        if (i >= chunks.length) { res.end(); return; }
        const c = chunks[i++];
        // Allow raw strings (to inject malformed lines) or objects (serialized as JSON).
        const line = typeof c === 'string' ? c : JSON.stringify(c);
        res.write(line + '\n');
        setTimeout(tick, 5);
      };
      tick();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        requests,
        close: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-midstream-'));

  try {
    // ── Test 1: malformed line mid-stream is skipped; stream completes ──────
    console.log('1. Malformed JSON line mid-stream is skipped; stream completes');
    {
      // Mix of valid/invalid ndjson lines. The proxy processes these one-by-one
      // as they arrive from the upstream. Malformed lines must be swallowed.
      const ollama = await malformedOllamaStub([
        { message: { content: 'hello' } },               // valid text chunk
        'NOT_VALID_JSON_AT_ALL',                          // malformed — must be skipped
        { message: { content: ' world' } },               // valid text chunk after the bad one
        { done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 5 },
      ]);
      try {
        const cfg = {
          backends: { stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${ollama.port}`, legacy_ollama_chat: true } },
          model_routes: { 'test-model': 'stub_ollama' },
          llm_profiles: { '64gb': { workhorse: { connected_model: 'test-model', disconnect_model: 'test-model' } } },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'test-model',
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 50,
          }, {}, 8000);

          assertEq(r.status, 200, 'stream response status is 200 (no crash)');

          // The stream should contain at least a message_start and message_stop event.
          const eventNames = r.events.map(e => e.event);
          assert(eventNames.includes('message_start'), 'message_start event present');
          assert(eventNames.includes('message_stop'), 'message_stop event present (stream completed)');

          // Text delta events should contain content from valid chunks.
          const deltas = r.events.filter(e => e.event === 'content_block_delta');
          const allText = deltas
            .map(e => (e.data && e.data.delta && e.data.delta.text) || '')
            .join('');
          assert(allText.includes('hello') || allText.includes('world'),
            `valid text chunks arrived (got: "${allText}")`);

          // No error event from the proxy (parse errors are logged, not surfaced).
          const errEvents = r.events.filter(e => e.event === 'error');
          assert(errEvents.length === 0, `no error SSE event (parse error swallowed), got: ${JSON.stringify(errEvents)}`);
        });
      } finally {
        await ollama.close().catch(() => {});
      }
    }

    // ── Test 2: ONLY malformed lines — stream closes cleanly with no content ──
    console.log('\n2. Stream with only malformed JSON lines closes cleanly');
    {
      const ollama = await malformedOllamaStub([
        'BAD_LINE_1',
        '{ broken json',
        '}}}}',
        // No done chunk — proxy should handle graceful end via upRes.on('end')
      ]);
      try {
        const cfg = {
          backends: { stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${ollama.port}`, legacy_ollama_chat: true } },
          model_routes: { 'test-model': 'stub_ollama' },
          llm_profiles: { '64gb': { workhorse: { connected_model: 'test-model', disconnect_model: 'test-model' } } },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'test-model',
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 50,
          }, {}, 8000);

          assertEq(r.status, 200, 'response status 200 even with only malformed chunks');
          const eventNames = r.events.map(e => e.event);
          // message_start always emitted upfront; message_stop/message_delta
          // emitted by closeMessage() on upRes.end even with no valid content.
          assert(eventNames.includes('message_start'), 'message_start present');
          assert(eventNames.includes('message_stop'), 'message_stop present (stream closed gracefully)');
        });
      } finally {
        await ollama.close().catch(() => {});
      }
    }

    // ── Test 3: malformed line does not corrupt subsequent usage stats ───────
    console.log('\n3. Malformed line followed by valid done chunk — usage stats are correct');
    {
      const ollama = await malformedOllamaStub([
        { message: { content: 'hi' } },
        'THIS_IS_GARBAGE',
        { done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 3 },
      ]);
      try {
        const cfg = {
          backends: { stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${ollama.port}`, legacy_ollama_chat: true } },
          model_routes: { 'test-model': 'stub_ollama' },
          llm_profiles: { '64gb': { workhorse: { connected_model: 'test-model', disconnect_model: 'test-model' } } },
        };
        const configPath = writeConfig(tmpDir, cfg);
        await withProxy({ configPath, profile: '64gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'test-model',
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 50,
          }, {}, 8000);

          assertEq(r.status, 200, 'status 200');

          // message_delta carries the final usage. The done chunk has
          // prompt_eval_count:7, eval_count:3 so that's what we expect.
          const delta = r.events.find(e => e.event === 'message_delta');
          assert(!!delta, 'message_delta event present');
          if (delta && delta.data && delta.data.usage) {
            const usage = delta.data.usage;
            assertEq(usage.input_tokens, 7, 'input_tokens from done chunk (7)');
            assertEq(usage.output_tokens, 3, 'output_tokens from done chunk (3)');
          }
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
