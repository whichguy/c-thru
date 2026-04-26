#!/usr/bin/env node
'use strict';
// SSE end-to-end tests: verify streaming responses pass through the proxy
// with correct headers, ordered events, and usage-chunk injection.
//
// Run: node test/proxy-streaming.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpStream, streamingStubBackend,
} = require('./helpers');

console.log('proxy streaming (SSE) tests\n');

function buildConfig(stubPort) {
  return {
    backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` } },
    model_routes: { 'stream-model': 'stub' },
    llm_profiles: {
      '128gb': {
        workhorse: { connected_model: 'stream-model', disconnect_model: 'stream-model' },
      },
    },
  };
}

const FULL_STREAM = [
  { event: 'message_start', data: {
      type: 'message_start',
      message: {
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [], model: 'stream-model', stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
  }},
  { event: 'content_block_start', data: {
      type: 'content_block_start', index: 0,
      content_block: { type: 'text', text: '' },
  }},
  { event: 'content_block_delta', data: {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
  }},
  { event: 'content_block_delta', data: {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: ' world' },
  }},
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 }},
  { event: 'message_delta', data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
  }},
  { event: 'message_stop', data: { type: 'message_stop' } },
];

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-stream-'));

  try {
    // ── Test 1: basic stream — events arrive in order ────────────────────────
    console.log('1. basic stream: SSE events arrive in order');
    {
      const stub = await streamingStubBackend(FULL_STREAM);
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'workhorse', stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 10,
          });
          assertEq(r.status, 200, 'status 200');
          assert(r.events.length >= 5, `received ≥5 events (got ${r.events.length})`);
          const types = r.events.map(e => e.event);
          assertEq(types[0], 'message_start', 'first event = message_start');
          assertEq(types[types.length - 1], 'message_stop', 'last event = message_stop');
          // Ordering: content_block_delta should appear after content_block_start
          const startIdx = types.indexOf('content_block_start');
          const deltaIdx = types.indexOf('content_block_delta');
          assert(startIdx < deltaIdx && startIdx >= 0, 'content_block_start before content_block_delta');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 2: streaming response has correct Content-Type ──────────────────
    console.log('\n2. streaming response Content-Type is text/event-stream');
    {
      const stub = await streamingStubBackend(FULL_STREAM);
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'workhorse', stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,
          });
          const ct = r.headers['content-type'] || '';
          assert(ct.includes('text/event-stream'), `Content-Type contains text/event-stream (got ${JSON.stringify(ct)})`);
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 3: x-c-thru-resolved-via header on streaming response ───────────
    console.log('\n3. x-c-thru-resolved-via header is set on streaming response');
    {
      const stub = await streamingStubBackend(FULL_STREAM);
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'workhorse', stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,
          });
          const hdr = r.headers['x-c-thru-resolved-via'];
          assert(typeof hdr === 'string', `header present (got ${typeof hdr})`);
          let via = null;
          try { via = JSON.parse(hdr); } catch {}
          assertEq(via?.capability, 'workhorse', 'capability=workhorse');
          assertEq(via?.served_by, 'stream-model', 'served_by=stream-model');
          assertEq(via?.mode, 'connected', 'mode=connected');
          assert(typeof via?.tier === 'string', 'tier present');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 4: usage-chunk content preserved through proxy ──────────────────
    console.log('\n4. message_start has usage; message_delta usage preserved');
    {
      const stub = await streamingStubBackend(FULL_STREAM);
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'workhorse', stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 10,
          });
          const start = r.events.find(e => e.event === 'message_start');
          assert(start && typeof start.data === 'object', 'message_start has data');
          assert(start.data.message?.usage, 'message_start.message.usage present');
          const delta = r.events.find(e => e.event === 'message_delta');
          assert(delta && delta.data.usage?.output_tokens === 2,
            `message_delta usage.output_tokens preserved (got ${JSON.stringify(delta?.data?.usage)})`);
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 5: minimal stream — just message_start + message_stop ───────────
    console.log('\n5. minimal stream: only start + stop events');
    {
      const minimal = [
        { event: 'message_start', data: {
            type: 'message_start',
            message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'stream-model',
                       stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
        }},
        { event: 'message_stop', data: { type: 'message_stop' } },
      ];
      const stub = await streamingStubBackend(minimal);
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'workhorse', stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          });
          assertEq(r.status, 200, 'minimal stream status 200');
          assert(r.events.length === 2,
            `exactly 2 events (got ${r.events.length}: ${JSON.stringify(r.events.map(e => e.event))})`);
        });
      } finally { await stub.close().catch(() => {}); }
    }

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
