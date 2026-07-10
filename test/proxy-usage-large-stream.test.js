#!/usr/bin/env node
'use strict';
// F4 — forwardAnthropic()'s usage-tee buffer used to extract token counts from
// streamed Anthropic-shape responses capped at 256KB. `message_delta` (which
// carries usage.output_tokens) is always the LAST SSE frame Anthropic emits,
// after all content — so once a stream's total bytes exceeded the cap, the
// head-capped buffer never contained it and the proxy silently recorded
// output_tokens: 0 for a successful, fully-delivered response.
//
// This drives a real streaming request through a stub whose content_block_delta
// payload alone exceeds 256KB before the trailing message_delta frame, then
// verifies the proxy's persisted usage stats record the correct (non-zero,
// exact) output_tokens rather than silently truncating to 0.
//
// Run: node test/proxy-usage-large-stream.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  stubBackend, writeConfig, httpJson, spawnProxy, waitForPing,
} = require('./helpers');

console.log('proxy usage stats — large SSE stream past the 256KB head-cap (F4)\n');

const MODEL = 'stats-large-stream-model';
// Comfortably over the proxy's 256KB head-capture cap so message_delta would
// have been truncated away by the pre-fix head-only buffer.
const PADDING_BYTES = 300 * 1024;
const EXPECTED_INPUT_TOKENS = 7;
const EXPECTED_OUTPUT_TOKENS = 4242;

function killAndWait(child, signal = 'SIGTERM') {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.on('exit', finish);
    try { child.kill(signal); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(); }, 3000);
  });
}

function cleanup(tmpHome) {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
}

async function main() {
  let state;
  try {
    const stub = await stubBackend();
    stub.setHandler((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_large', usage: { input_tokens: EXPECTED_INPUT_TOKENS } },
      })}\n\n`);
      // Emit content_block_delta frames until the total exceeds PADDING_BYTES —
      // this is what previously pushed message_delta past the 256KB head cap.
      const chunkText = 'x'.repeat(4096);
      let sent = 0;
      while (sent < PADDING_BYTES) {
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: chunkText },
        })}\n\n`);
        sent += chunkText.length;
      }
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta', delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: EXPECTED_OUTPUT_TOKENS },
      })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
      return true;
    });

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-usage-large-'));
    const statsFile = path.join(tmpHome, 'usage-stats.json');
    const configPath = writeConfig(tmpHome, {
      backends: {
        stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` },
      },
      model_routes: { [MODEL]: 'stub' },
    });
    const { child, port } = await spawnProxy({
      configPath, tmpHome,
      env: { CLAUDE_PROXY_USAGE_STATS_FILE: statsFile },
    });
    await waitForPing(port, 5000);
    state = { child, tmpHome, stub };

    console.log(`1. Streaming response with ${(PADDING_BYTES / 1024).toFixed(0)}KB of content before message_delta`);
    const r = await httpJson(port, 'POST', '/v1/messages', {
      model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 50, stream: true,
    }, {}, 15000);
    assertEq(r.status, 200, 'streaming request returned 200');

    await killAndWait(child, 'SIGTERM');

    assert(fs.existsSync(statsFile), 'stats file written after large-stream traffic');
    const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    const bm = stats.by_model && stats.by_model[MODEL];
    assert(bm, `by_model entry for ${MODEL} exists`);
    assertEq(bm.input, EXPECTED_INPUT_TOKENS, `input tokens recorded exactly (message_start is within the head cap)`);
    assertEq(bm.output, EXPECTED_OUTPUT_TOKENS,
      `output tokens recorded exactly (not silently 0 — message_delta recovered past the 256KB head cap)`);

    await stub.close();
    cleanup(tmpHome);
  } catch (e) {
    if (state) {
      try { state.child.kill('SIGKILL'); } catch {}
      try { await state.stub.close(); } catch {}
      cleanup(state.tmpHome);
    }
    throw e;
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

process.on('unhandledRejection', err => {
  console.error('unhandledRejection:', err);
  process.exit(1);
});

main().catch(err => {
  console.error(err);
  process.exit(1);
});
