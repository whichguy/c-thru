#!/usr/bin/env node
'use strict';
// Phase A journaling tests: opt-in record-only capture to JSONL.
// Verifies: off by default, on with env var, scrubbing, INCLUDE/EXCLUDE filters,
// schema, failure isolation.
//
// Run: node test/proxy-journal.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, httpStream, stubBackend, ollamaStubBackend,
} = require('./helpers');

console.log('proxy journal Phase A tests\n');

function readJournal(dir, capability) {
  // Walk YYYY-MM-DD subdir(s) and return all JSONL entries for the capability
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  for (const day of fs.readdirSync(dir)) {
    const file = path.join(dir, day, `${capability}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      try { entries.push(JSON.parse(line)); } catch {}
    }
  }
  return entries;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-journal-'));
  const stub = await stubBackend();

  try {
    const config = {
      backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
      model_routes: { 'test-model': 'stub' },
      llm_profiles: {
        '128gb': {
          workhorse: { connected_model: 'test-model', disconnect_model: 'test-model' },
          coder:     { connected_model: 'test-model', disconnect_model: 'test-model' },
        },
      },
    };
    const configPath = writeConfig(tmpDir, config);

    const send = (port, model) => httpJson(port, 'POST', '/v1/messages', {
      model,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 5,
    }, { 'x-api-key': 'sk-secret-must-not-leak' }, 5000);

    // ── Test 1: journaling disabled by default — no files written ──────────
    console.log('1. default off — no journal directory created');
    const journalDir1 = path.join(tmpDir, 'journal-off');
    await withProxy({
      configPath, profile: '128gb', mode: 'connected',
      env: { CLAUDE_PROXY_JOURNAL_DIR: journalDir1 /* CLAUDE_PROXY_JOURNAL not set */ },
    }, async ({ port }) => {
      await send(port, 'workhorse');
      await new Promise(r => setTimeout(r, 200)); // let async append settle
      assertEq(fs.existsSync(journalDir1), false,
        'journal dir not created when CLAUDE_PROXY_JOURNAL unset');
    });

    // ── Test 2: enabled — entry written with expected schema ───────────────
    console.log('\n2. CLAUDE_PROXY_JOURNAL=1 — entry written with schema');
    const journalDir2 = path.join(tmpDir, 'journal-on');
    await withProxy({
      configPath, profile: '128gb', mode: 'connected',
      env: { CLAUDE_PROXY_JOURNAL: '1', CLAUDE_PROXY_JOURNAL_DIR: journalDir2 },
    }, async ({ port }) => {
      await send(port, 'workhorse');
      await new Promise(r => setTimeout(r, 200));
      const entries = readJournal(journalDir2, 'workhorse');
      assert(entries.length >= 1, `at least 1 journal entry written (got ${entries.length})`);
      const e = entries[0];
      assertEq(e.schema_version, 1, 'schema_version = 1');
      assertEq(e.capability, 'workhorse', 'capability captured');
      assertEq(e.mode, 'connected', 'mode captured');
      assertEq(e.served_by, 'test-model', 'served_by captured');
      assertEq(e.endpoint, '/v1/messages', 'endpoint captured');
      assert(typeof e.id === 'string' && e.id.startsWith('j_'), 'id has j_ prefix');
      assert(typeof e.ts_iso === 'string' && e.ts_iso.endsWith('Z'), 'ts_iso is ISO8601');
      assert(typeof e.latency_ms === 'number', 'latency_ms numeric');
      assert(e.request && typeof e.request === 'object', 'request body captured');
      assertEq(e.request.model, 'workhorse', 'request.model is original client model');
      assert(Array.isArray(e.request.messages), 'request.messages is array');
      assert(e.response && typeof e.response === 'object', 'response body captured');
    });

    // ── Test 3: auth scrubbing — x-api-key not in entry ────────────────────
    console.log('\n3. auth headers stripped from journal');
    {
      const entries = readJournal(journalDir2, 'workhorse');
      const e = entries[entries.length - 1];
      const blob = JSON.stringify(e);
      // Bodies are journaled; but headers should not be. The scrub is on headers, not bodies.
      // Verify NO header leak — the entry shape doesn't include headers, but check the secret didn't end up in some captured field
      assert(!blob.includes('sk-secret-must-not-leak'),
        'scrubbing: secret API key absent from journal entry');
    }

    // ── Test 4: INCLUDE filter — only matching capabilities recorded ───────
    console.log('\n4. INCLUDE filter limits to specified capabilities');
    const journalDir4 = path.join(tmpDir, 'journal-include');
    await withProxy({
      configPath, profile: '128gb', mode: 'connected',
      env: {
        CLAUDE_PROXY_JOURNAL: '1',
        CLAUDE_PROXY_JOURNAL_DIR: journalDir4,
        CLAUDE_PROXY_JOURNAL_INCLUDE: 'coder',
      },
    }, async ({ port }) => {
      await send(port, 'workhorse');
      await send(port, 'coder');
      await new Promise(r => setTimeout(r, 200));
      const wh = readJournal(journalDir4, 'workhorse');
      const cd = readJournal(journalDir4, 'coder');
      assertEq(wh.length, 0, 'workhorse not captured (not in INCLUDE)');
      assert(cd.length >= 1, `coder captured (got ${cd.length})`);
    });

    // ── Test 5: EXCLUDE filter — specified capabilities skipped ────────────
    console.log('\n5. EXCLUDE filter skips specified capabilities');
    const journalDir5 = path.join(tmpDir, 'journal-exclude');
    await withProxy({
      configPath, profile: '128gb', mode: 'connected',
      env: {
        CLAUDE_PROXY_JOURNAL: '1',
        CLAUDE_PROXY_JOURNAL_DIR: journalDir5,
        CLAUDE_PROXY_JOURNAL_EXCLUDE: 'workhorse',
      },
    }, async ({ port }) => {
      await send(port, 'workhorse');
      await send(port, 'coder');
      await new Promise(r => setTimeout(r, 200));
      const wh = readJournal(journalDir5, 'workhorse');
      const cd = readJournal(journalDir5, 'coder');
      assertEq(wh.length, 0, 'workhorse skipped via EXCLUDE');
      assert(cd.length >= 1, `coder captured (got ${cd.length})`);
    });

    // ── Test 5b: SSE journaling — stream events captured in entry ───────────
    console.log('\n5b. streaming response: stream_events captured');
    {
      // Use a SEPARATE tmpdir so the config file rewrite doesn't pollute the
      // shared `configPath` used by other tests.
      const sseTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-journal-sse-'));
      const journalDir5b = path.join(sseTmpDir, 'journal-sse');
      const { streamingStubBackend, httpStream } = require('./helpers');
      const sseStub = await streamingStubBackend([
        { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'test-model', stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]);
      try {
        const sseConfig = {
          backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${sseStub.port}` } },
          model_routes: { 'sse-model': 'stub' },
          llm_profiles: {
            '128gb': { workhorse: { connected_model: 'sse-model', disconnect_model: 'sse-model' } },
          },
        };
        const sseConfigPath = writeConfig(sseTmpDir, sseConfig);
        await withProxy({
          configPath: sseConfigPath, profile: '128gb', mode: 'connected',
          env: { CLAUDE_PROXY_JOURNAL: '1', CLAUDE_PROXY_JOURNAL_DIR: journalDir5b },
        }, async ({ port }) => {
          await httpStream(port, 'POST', '/v1/messages', {
            model: 'workhorse', stream: true,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
          });
          await new Promise(r => setTimeout(r, 300));
          const entries = readJournal(journalDir5b, 'workhorse');
          assert(entries.length >= 1, `streaming entry written (got ${entries.length})`);
          const e = entries[0];
          assertEq(e.stream, true, 'stream:true in entry');
          assert(Array.isArray(e.stream_events), `stream_events is array (got ${typeof e.stream_events})`);
          assert(e.stream_events.length > 0, `stream_events captured (got ${e.stream_events.length})`);
          assertEq(e.stream_events_truncated, false, 'not truncated for small stream');
        });
      } finally {
        await sseStub.close().catch(() => {});
        try { fs.rmSync(sseTmpDir, { recursive: true, force: true }); } catch {}
      }
    }

    // ── Test 7: non-streaming Ollama — journal entry written ──────────────────
    console.log('\n7. non-streaming Ollama: journal entry written with stream:false and response object');
    {
      const ollamaTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-journal-ollama-ns-'));
      const journalDir7 = path.join(ollamaTmpDir, 'journal-ollama-ns');
      const ollamaStub = await ollamaStubBackend([
        { message: { content: 'hello from ollama', thinking: '' } },
        { done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 5 },
      ]);
      try {
        const ollamaConfig = {
          backends: { stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${ollamaStub.port}` } },
          model_routes: { 'ollama-model': 'stub_ollama' },
          llm_profiles: {
            '128gb': {
              workhorse: { connected_model: 'ollama-model', disconnect_model: 'ollama-model' },
            },
          },
        };
        const ollamaConfigPath = writeConfig(ollamaTmpDir, ollamaConfig);
        await withProxy({
          configPath: ollamaConfigPath, profile: '128gb', mode: 'connected',
          env: { CLAUDE_PROXY_JOURNAL: '1', CLAUDE_PROXY_JOURNAL_DIR: journalDir7 },
        }, async ({ port }) => {
          await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,
          }, {}, 5000);
          await new Promise(r => setTimeout(r, 300));
          const entries = readJournal(journalDir7, 'workhorse');
          assert(entries.length >= 1, `Ollama non-stream: at least 1 journal entry written (got ${entries.length})`);
          const e = entries[0];
          assertEq(e.stream, false, 'Ollama non-stream: stream:false in entry');
          assertEq(e.served_by, 'ollama-model', 'Ollama non-stream: served_by matches model');
          assert(e.response !== null && typeof e.response === 'object',
            'Ollama non-stream: response is a non-null object');
        });
      } finally {
        await ollamaStub.close().catch(() => {});
        try { fs.rmSync(ollamaTmpDir, { recursive: true, force: true }); } catch {}
      }
    }

    // ── Test 8: streaming Ollama — journal entry written ──────────────────────
    console.log('\n8. streaming Ollama: journal entry written with stream:true');
    {
      const ollamaStreamTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-journal-ollama-s-'));
      const journalDir8 = path.join(ollamaStreamTmpDir, 'journal-ollama-s');
      const ollamaStreamStub = await ollamaStubBackend([
        { message: { content: 'hi', thinking: '' } },
        { done: true, done_reason: 'stop', prompt_eval_count: 2, eval_count: 3 },
      ]);
      try {
        const ollamaStreamConfig = {
          backends: { stub_ollama: { kind: 'ollama', url: `http://127.0.0.1:${ollamaStreamStub.port}` } },
          model_routes: { 'ollama-stream-model': 'stub_ollama' },
          llm_profiles: {
            '128gb': {
              workhorse: { connected_model: 'ollama-stream-model', disconnect_model: 'ollama-stream-model' },
            },
          },
        };
        const ollamaStreamConfigPath = writeConfig(ollamaStreamTmpDir, ollamaStreamConfig);
        await withProxy({
          configPath: ollamaStreamConfigPath, profile: '128gb', mode: 'connected',
          env: { CLAUDE_PROXY_JOURNAL: '1', CLAUDE_PROXY_JOURNAL_DIR: journalDir8 },
        }, async ({ port }) => {
          await httpStream(port, 'POST', '/v1/messages', {
            model: 'workhorse', stream: true,
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
          });
          await new Promise(r => setTimeout(r, 300));
          const entries = readJournal(journalDir8, 'workhorse');
          assert(entries.length >= 1, `Ollama stream: at least 1 journal entry written (got ${entries.length})`);
          const e = entries[0];
          assertEq(e.stream, true, 'Ollama stream: stream:true in entry');
          assertEq(e.served_by, 'ollama-stream-model', 'Ollama stream: served_by matches model');
        });
      } finally {
        await ollamaStreamStub.close().catch(() => {});
        try { fs.rmSync(ollamaStreamTmpDir, { recursive: true, force: true }); } catch {}
      }
    }

    // ── Test 6: failure isolation — read-only journal dir doesn't break request ──
    console.log('\n6. journal write failure does not break user request');
    // Use a path that's not writable (a file pretending to be a dir)
    const blockerFile = path.join(tmpDir, 'journal-readonly');
    fs.writeFileSync(blockerFile, '');  // file, not directory; mkdir will fail
    await withProxy({
      configPath, profile: '128gb', mode: 'connected',
      env: { CLAUDE_PROXY_JOURNAL: '1', CLAUDE_PROXY_JOURNAL_DIR: blockerFile },
    }, async ({ port }) => {
      const r = await send(port, 'workhorse');
      assertEq(r.status, 200, 'request succeeded despite journal write failure');
    });

  } finally {
    await stub.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
