#!/usr/bin/env node
'use strict';
// Phase A dynamic-classifier tests.
// Verifies: off by default, on with env var, role surfaces in headers + journal,
// cold-start skip, cache hit, soft-fail on classifier errors.
//
// Run: node test/proxy-classify.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, stubBackend, classifierStub,
} = require('./helpers');

console.log('proxy classifier (Phase A observe-only) tests\n');

function readJournalAll(dir, capability) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const day of fs.readdirSync(dir)) {
    const file = path.join(dir, day, `${capability}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-classify-'));
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

    const send = (port, model, content = 'hello world') =>
      httpJson(port, 'POST', '/v1/messages', {
        model,
        messages: [{ role: 'user', content }],
        max_tokens: 5,
      }, {}, 5000);

    // ── Test 1: classifier disabled by default — no headers, no calls ──────
    console.log('1. CLAUDE_PROXY_CLASSIFY unset → no classifier headers');
    {
      const cls = await classifierStub();
      try {
        await withProxy({
          configPath, profile: '128gb', mode: 'connected',
          env: { CLAUDE_PROXY_CLASSIFY_OLLAMA_URL: `http://127.0.0.1:${cls.port}` },
        }, async ({ port }) => {
          const r = await send(port, 'workhorse');
          assertEq(r.status, 200, 'request 200');
          assertEq(r.headers['x-c-thru-classified-role'], undefined,
            'no x-c-thru-classified-role when disabled');
          assertEq(cls.requests.length, 0, 'classifier stub NOT called when disabled');
        });
      } finally { await cls.close().catch(() => {}); }
    }

    // ── Test 2: enabled — first request skipped (cold start) ───────────────
    console.log('\n2. CLAUDE_PROXY_CLASSIFY=1 — first request: cold-start skip');
    {
      const cls = await classifierStub({ role: 'coder', confidence: 0.9 });
      try {
        await withProxy({
          configPath, profile: '128gb', mode: 'connected',
          env: {
            CLAUDE_PROXY_CLASSIFY: '1',
            CLAUDE_PROXY_CLASSIFY_OLLAMA_URL: `http://127.0.0.1:${cls.port}`,
          },
        }, async ({ port }) => {
          const r = await send(port, 'workhorse', 'first request');
          assertEq(r.status, 200, 'first request status 200');
          // Cold-start: classifier-skipped header set, no role header
          assertEq(r.headers['x-c-thru-classifier-skipped'], 'cold_start',
            'cold-start skip flagged in header');
          assertEq(r.headers['x-c-thru-classified-role'], undefined,
            'no role on cold-start request');
          assertEq(cls.requests.length, 0, 'classifier not called on first request');
        });
      } finally { await cls.close().catch(() => {}); }
    }

    // ── Test 3: enabled — second+ requests get classified, headers populated ─
    console.log('\n3. enabled: second request gets classified, headers populated');
    {
      const cls = await classifierStub({ role: 'debugger', confidence: 0.92 });
      try {
        await withProxy({
          configPath, profile: '128gb', mode: 'connected',
          env: {
            CLAUDE_PROXY_CLASSIFY: '1',
            CLAUDE_PROXY_CLASSIFY_OLLAMA_URL: `http://127.0.0.1:${cls.port}`,
          },
        }, async ({ port }) => {
          await send(port, 'workhorse', 'first call'); // burns the cold-start
          const r = await send(port, 'workhorse', 'why is this failing');
          assertEq(r.status, 200, 'second request status 200');
          assertEq(r.headers['x-c-thru-classified-role'], 'debugger',
            'role surfaces in header');
          assertEq(r.headers['x-c-thru-classifier-confidence'], '0.92',
            'confidence surfaces in header');
          assertEq(cls.requests.length, 1, 'classifier called exactly once (cold-start consumed first)');
          // Verify the classifier received the user prompt as input
          const cReq = cls.requests[0].body;
          assert(cReq && typeof cReq.prompt === 'string' && cReq.prompt.includes('why is this failing'),
            `classifier received user prompt (got: ${cReq?.prompt?.slice(0, 100)})`);
        });
      } finally { await cls.close().catch(() => {}); }
    }

    // ── Test 4: cache hit — same prompt classified once ────────────────────
    console.log('\n4. cache: identical prompt classifies once across multiple requests');
    {
      const cls = await classifierStub({ role: 'logic', confidence: 0.7 });
      try {
        await withProxy({
          configPath, profile: '128gb', mode: 'connected',
          env: {
            CLAUDE_PROXY_CLASSIFY: '1',
            CLAUDE_PROXY_CLASSIFY_OLLAMA_URL: `http://127.0.0.1:${cls.port}`,
          },
        }, async ({ port }) => {
          await send(port, 'workhorse', 'cold start dummy');         // skipped
          const r1 = await send(port, 'workhorse', 'identical prompt for cache test');
          const r2 = await send(port, 'workhorse', 'identical prompt for cache test');
          const r3 = await send(port, 'workhorse', 'identical prompt for cache test');
          // All three (post-cold-start) should report role=logic
          assertEq(r1.headers['x-c-thru-classified-role'], 'logic', 'r1 role');
          assertEq(r2.headers['x-c-thru-classified-role'], 'logic', 'r2 role');
          assertEq(r3.headers['x-c-thru-classified-role'], 'logic', 'r3 role');
          // Classifier stub should have been called once (the first non-cold-start)
          assertEq(cls.requests.length, 1, 'classifier called exactly once for 3 identical prompts');
        });
      } finally { await cls.close().catch(() => {}); }
    }

    // ── Test 5: classifier failure soft-fails (request unaffected) ─────────
    console.log('\n5. broken classifier response → soft-fail, request still 200');
    {
      const cls = await classifierStub({ broken: true });
      try {
        await withProxy({
          configPath, profile: '128gb', mode: 'connected',
          env: {
            CLAUDE_PROXY_CLASSIFY: '1',
            CLAUDE_PROXY_CLASSIFY_OLLAMA_URL: `http://127.0.0.1:${cls.port}`,
          },
        }, async ({ port }) => {
          await send(port, 'workhorse', 'cold start');
          const r = await send(port, 'workhorse', 'malformed classifier returns broken json');
          assertEq(r.status, 200, 'request still 200 despite classifier error');
          // Outer Ollama envelope is invalid JSON → response_invalid
          // (parse_failed is for valid envelope but malformed inner role JSON)
          assertEq(r.headers['x-c-thru-classifier-skipped'], 'response_invalid',
            'classifier-skipped header set with response_invalid reason');
          assertEq(r.headers['x-c-thru-classified-role'], undefined,
            'no role header when classifier broken');
        });
      } finally { await cls.close().catch(() => {}); }
    }

    // ── Test 6: classifier output recorded in journal entry ────────────────
    console.log('\n6. journal entry includes classified_role + classifier_confidence');
    {
      const cls = await classifierStub({ role: 'reviewer', confidence: 0.88 });
      const journalDir6 = path.join(tmpDir, 'journal-classify');
      try {
        await withProxy({
          configPath, profile: '128gb', mode: 'connected',
          env: {
            CLAUDE_PROXY_CLASSIFY: '1',
            CLAUDE_PROXY_CLASSIFY_OLLAMA_URL: `http://127.0.0.1:${cls.port}`,
            CLAUDE_PROXY_JOURNAL: '1',
            CLAUDE_PROXY_JOURNAL_DIR: journalDir6,
          },
        }, async ({ port }) => {
          await send(port, 'workhorse', 'cold start');                         // cold-start skipped
          await send(port, 'workhorse', 'review my pull request please');     // classifier called
          await new Promise(r => setTimeout(r, 200));
          const entries = readJournalAll(journalDir6, 'workhorse');
          assert(entries.length >= 2, `2 journal entries written (got ${entries.length})`);
          // First entry: cold-start skip
          const firstEntry = entries[0];
          assertEq(firstEntry.classifier_skipped, 'cold_start', 'first entry has cold_start');
          assertEq(firstEntry.classified_role, null, 'first entry has null role');
          // Second entry: classified
          const secondEntry = entries[1];
          assertEq(secondEntry.classified_role, 'reviewer', 'second entry has classified role');
          assertEq(secondEntry.classifier_confidence, 0.88, 'second entry has confidence');
          assertEq(secondEntry.classifier_skipped, null, 'second entry not skipped');
        });
      } finally { await cls.close().catch(() => {}); }
    }

    // ── Test 7: classifier returns invalid role → parse_failed ─────────────
    console.log('\n7. invalid role returned by classifier → parse_failed');
    {
      // role='not_a_real_role' is not in CLASSIFY_ROLES → _classifyParseResponse
      // returns null → skipped='parse_failed'
      const cls = await classifierStub({ role: 'not_a_real_role', confidence: 0.5 });
      try {
        await withProxy({
          configPath, profile: '128gb', mode: 'connected',
          env: {
            CLAUDE_PROXY_CLASSIFY: '1',
            CLAUDE_PROXY_CLASSIFY_OLLAMA_URL: `http://127.0.0.1:${cls.port}`,
          },
        }, async ({ port }) => {
          await send(port, 'workhorse', 'cold start');
          const r = await send(port, 'workhorse', 'this prompt will be misclassified');
          assertEq(r.status, 200, 'request still 200');
          assertEq(r.headers['x-c-thru-classifier-skipped'], 'parse_failed',
            'invalid role → parse_failed (rejected by allowlist)');
          assertEq(r.headers['x-c-thru-classified-role'], undefined, 'no role header');
        });
      } finally { await cls.close().catch(() => {}); }
    }

  } finally {
    await stub.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
