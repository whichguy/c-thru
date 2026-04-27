#!/usr/bin/env node
'use strict';
// SSE fidelity tests for the Ollama → Anthropic translation path.
// Verifies the state machine in forwardOllama (claude-proxy) emits the right
// event sequence for thinking-mode models, lazy block opening, mode-conditional
// route resolution, and proper terminal frames on edge cases.
//
// Run: node test/proxy-streaming-ollama.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpStream, ollamaStubBackend,
} = require('./helpers');

console.log('proxy streaming (Ollama → Anthropic SSE) tests\n');

function buildConfig(stubPort) {
  return {
    backends: { stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${stubPort}` } },
    model_routes: { 'test-model': 'stub_ollama' },
    llm_profiles: {
      '128gb': {
        workhorse: { connected_model: 'test-model', disconnect_model: 'test-model' },
      },
    },
  };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-ollama-stream-'));

  try {
    // ── Test 1: thinking-mode model → two blocks (thinking, text) ───────────
    console.log('1. thinking-mode chunks → block-0 thinking, block-1 text');
    {
      const stub = await ollamaStubBackend([
        { message: { content: '', thinking: 'Let me ' } },
        { message: { content: '', thinking: 'consider...' } },
        { message: { content: 'Hello', thinking: '' } },
        { message: { content: '!', thinking: '' } },
        { done: true, done_reason: 'stop', prompt_eval_count: 4, eval_count: 4 },
      ]);
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'test-model', stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 50,
          });
          assertEq(r.status, 200, 'status 200');
          const types = r.events.map(e => e.event);
          assertEq(types[0], 'message_start', 'first event = message_start');
          assertEq(types[types.length - 1], 'message_stop', 'last event = message_stop');

          // Block-ordering check: walk events in arrival order. The FIRST
          // content_block_start must be thinking, the SECOND must be text.
          // (Indexing alone is tautological since the state machine assigns
          // monotonic indices — we need to verify the *order* of arrival.)
          const blockStarts = r.events.filter(e => e.event === 'content_block_start');
          assertEq(blockStarts.length, 2, 'two content_block_start events (thinking, then text)');
          assertEq(blockStarts[0].data.content_block.type, 'thinking',
            'first content_block_start is thinking (arrives before text)');
          assertEq(blockStarts[0].data.index, 0, 'thinking block gets index 0');
          assertEq(blockStarts[1].data.content_block.type, 'text',
            'second content_block_start is text (arrives after thinking)');
          assertEq(blockStarts[1].data.index, 1, 'text block gets index 1');

          // And the deltas must arrive in matching order: thinking_delta(s)
          // for index 0, then text_delta(s) for index 1, never interleaved.
          const deltaOrder = r.events
            .filter(e => e.event === 'content_block_delta')
            .map(e => e.data.delta?.type);
          const thinkingEnd = deltaOrder.lastIndexOf('thinking_delta');
          const textStart = deltaOrder.indexOf('text_delta');
          assert(thinkingEnd < textStart && textStart >= 0,
            `all thinking_delta events precede all text_delta events (got order: ${deltaOrder.join(',')})`);

          // Thinking deltas use thinking_delta type
          const thinkingDeltas = r.events.filter(
            e => e.event === 'content_block_delta' && e.data.delta?.type === 'thinking_delta'
          );
          assert(thinkingDeltas.length === 2, `2 thinking_delta events (got ${thinkingDeltas.length})`);

          // Text deltas use text_delta type
          const textDeltas = r.events.filter(
            e => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta'
          );
          assert(textDeltas.length === 2, `2 text_delta events (got ${textDeltas.length})`);

          // Two block stops, one per block
          const stops = r.events.filter(e => e.event === 'content_block_stop');
          assertEq(stops.length, 2, 'exactly 2 content_block_stop events');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 2: pure-text model → only text block, index 0 ──────────────────
    console.log('\n2. pure-text chunks → single text block at index 0');
    {
      const stub = await ollamaStubBackend([
        { message: { content: 'Hello' } },
        { message: { content: ' world' } },
        { done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 2 },
      ]);
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'test-model', stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 50,
          });
          const blockStarts = r.events.filter(e => e.event === 'content_block_start');
          assertEq(blockStarts.length, 1, 'exactly one content_block_start (no thinking block)');
          assertEq(blockStarts[0].data.content_block.type, 'text', 'block is type text');
          assertEq(blockStarts[0].data.index, 0, 'text block at index 0');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 3: stop_reason maps from done_reason ───────────────────────────
    console.log('\n3. stop_reason: length → max_tokens');
    {
      const stub = await ollamaStubBackend([
        { message: { content: 'truncated' } },
        { done: true, done_reason: 'length', prompt_eval_count: 5, eval_count: 1 },
      ]);
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'test-model', stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 50,
          });
          const messageDelta = r.events.find(e => e.event === 'message_delta');
          assert(messageDelta, 'message_delta emitted');
          assertEq(messageDelta.data.delta.stop_reason, 'max_tokens',
            'stop_reason mapped from done_reason=length to max_tokens');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 4: usage in message_delta has all four fields ──────────────────
    console.log('\n4. message_delta usage includes cache_creation_input_tokens / cache_read_input_tokens');
    {
      const stub = await ollamaStubBackend([
        { message: { content: 'ok' } },
        { done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 1 },
      ]);
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'test-model', stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 50,
          });
          const messageDelta = r.events.find(e => e.event === 'message_delta');
          const usage = messageDelta.data.usage;
          assertEq(usage.input_tokens, 7, 'input_tokens populated from prompt_eval_count');
          assertEq(usage.output_tokens, 1, 'output_tokens populated from eval_count');
          assertEq(usage.cache_creation_input_tokens, 0, 'cache_creation_input_tokens present (0)');
          assertEq(usage.cache_read_input_tokens, 0, 'cache_read_input_tokens present (0)');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 5: each response gets a unique message_id ──────────────────────
    console.log('\n5. message_start.id is unique per response (not static msg_ollama)');
    {
      const stub = await ollamaStubBackend([
        { message: { content: 'one' } },
        { done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 },
      ]);
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r1 = await httpStream(port, 'POST', '/v1/messages', {
            model: 'test-model', stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 50,
          });
          const r2 = await httpStream(port, 'POST', '/v1/messages', {
            model: 'test-model', stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 50,
          });
          const id1 = r1.events.find(e => e.event === 'message_start').data.message.id;
          const id2 = r2.events.find(e => e.event === 'message_start').data.message.id;
          assert(id1.startsWith('msg_'), 'id has msg_ prefix');
          assert(id1 !== 'msg_ollama', 'id is not the static msg_ollama placeholder');
          assert(id1 !== id2, 'two requests get distinct ids');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── Test 6: every SSE frame has event: prefix on the wire ───────────────
    // Direct raw-body assertion. Walks the SSE wire format frame by frame,
    // splits on \n\n, asserts each non-empty frame contains BOTH "event:" and
    // "data:" lines. This catches the case where the proxy emits a bare
    // "data: {...}" without an "event:" header — the previous parser-based
    // assertion was tautological because the parser tolerates missing
    // event-headers (sets event=null).
    console.log('\n6. every SSE wire frame has both event: and data: lines');
    {
      const stub = await ollamaStubBackend([
        { message: { content: 'a' } }, { message: { content: 'b' } },
        { done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 2 },
      ]);
      try {
        const configPath = writeConfig(tmpDir, buildConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'connected' }, async ({ port }) => {
          const r = await httpStream(port, 'POST', '/v1/messages', {
            model: 'test-model', stream: true,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 50,
          });
          assert(typeof r.rawBody === 'string' && r.rawBody.length > 0, 'rawBody captured');
          const frames = r.rawBody.split(/\r?\n\r?\n/).filter(f => f.trim());
          assert(frames.length > 0, `at least one frame received (got ${frames.length})`);
          for (const frame of frames) {
            const lines = frame.split(/\r?\n/);
            const hasEventLine = lines.some(l => l.startsWith('event:'));
            const hasDataLine  = lines.some(l => l.startsWith('data:'));
            assert(hasEventLine && hasDataLine,
              `frame has both event: and data: lines (frame: ${JSON.stringify(frame.slice(0, 80))})`);
          }
        });
      } finally { await stub.close().catch(() => {}); }
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  summary();
}

main().catch(e => { console.error(e); process.exit(1); });
