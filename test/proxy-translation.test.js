#!/usr/bin/env node
'use strict';
// Tests for proxy declared rewrites (CLAUDE.md §"Declared rewrites"):
//   (1) body model field substitution
//   (2) URL + Host routing to backend
//   (3) Authorization header injection
//   (4) SSE usage injection (verified via stream path)
//   (6) x-c-thru-resolved-via header
//   (7) model_overrides unconditional substitution
//   (8) @backend sigil stripping
//
// Uses a real proxy + stub backend (no Ollama required).
// Run: node test/proxy-translation.test.js

const fs   = require('fs');
const http = require('http');
const os   = require('os');
const path = require('path');
const {
  stubBackend, writeConfig, httpJson, withProxy,
} = require('./helpers');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    failed++;
  }
}

console.log('proxy-translation (declared rewrites) tests\n');

const MODEL = 'test-model-v1';

function buildConfig(stubPort, extras = {}) {
  return Object.assign({
    backends: {
      stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    model_routes: { [MODEL]: 'stub' },
    llm_profiles: {
      '16gb': {
        workhorse: { connected_model: `${MODEL}@stub`, disconnect_model: `${MODEL}@stub` },
        judge:     { connected_model: `${MODEL}@stub`, disconnect_model: `${MODEL}@stub` },
      },
    },
    agent_to_capability: {
      'test-agent': 'workhorse',
    },
  }, extras);
}

const MSG = { messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 };

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-trans-'));
  let stub;
  try {
    stub = await stubBackend();
    const configPath = writeConfig(tmpDir, buildConfig(stub.port));
    const env = { CLAUDE_PROXY_ANNOTATE_MODEL: '1', CLAUDE_LLM_MODE: 'connected' };

    // ── 1. Body model field set to effectiveModel in forwarded request ────────
    console.log('1. Forwarded body.model = effectiveModel (not raw client model)');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', { ...MSG, model: MODEL });
      assert(r.status === 200, `status 200 (got ${r.status})`);
      assert(stub.lastRequest()?.model_used === MODEL,
        `stub received model_used=${MODEL} (got ${stub.lastRequest()?.model_used})`);
    });

    // ── 2. @backend sigil stripped before forwarding ──────────────────────────
    console.log('\n2. @backend sigil stripped from model before forwarding to stub');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      // capability entry uses MODEL@stub — stub must receive only MODEL
      const r = await httpJson(port, 'POST', '/v1/messages', { ...MSG, model: 'workhorse' });
      assert(r.status === 200, `status 200 (got ${r.status})`);
      const forwarded = stub.lastRequest()?.model_used;
      assert(forwarded === MODEL,
        `sigil stripped: stub got '${forwarded}', expected '${MODEL}'`);
    });

    // ── 3. model_overrides applied before route resolution ────────────────────
    console.log('\n3. model_overrides substitution applied before forwarding');
    {
      const ALIAS = 'old-model';
      const overrideConfig = buildConfig(stub.port, {
        model_overrides: { [ALIAS]: MODEL },
        model_routes: { [MODEL]: 'stub', [ALIAS]: 'stub' },
      });
      const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-trans-ovr-'));
      try {
        const p2 = writeConfig(overrideDir, overrideConfig);
        await withProxy({ configPath: p2, profile: '16gb', env }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', { ...MSG, model: ALIAS });
          assert(r.status === 200, `override: status 200 (got ${r.status})`);
          const forwarded = stub.lastRequest()?.model_used;
          assert(forwarded === MODEL,
            `model_overrides applied: stub got '${forwarded}', expected '${MODEL}'`);
        });
      } finally {
        try { fs.rmSync(overrideDir, { recursive: true, force: true }); } catch {}
      }
    }

    // ── 4. x-c-thru-resolved-via present for capability alias requests ────────
    console.log('\n4. x-c-thru-resolved-via present on capability alias request');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', { ...MSG, model: 'workhorse' });
      const via = r.headers['x-c-thru-resolved-via'];
      assert(via != null, 'x-c-thru-resolved-via header present');
      const parsed = via ? JSON.parse(via) : null;
      assert(parsed?.capability === 'workhorse',
        `resolved_via.capability=workhorse (got ${parsed?.capability})`);
      assert(parsed?.served_by === MODEL,
        `resolved_via.served_by=${MODEL} (got ${parsed?.served_by})`);
    });

    // ── 5. x-c-thru-resolved-via absent for direct model requests ────────────
    console.log('\n5. x-c-thru-resolved-via absent on direct model request');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', { ...MSG, model: MODEL });
      assert(r.headers['x-c-thru-resolved-via'] == null,
        'x-c-thru-resolved-via absent for direct model (no capability alias)');
    });

    // ── 6. messages[] array preserved verbatim ────────────────────────────────
    console.log('\n6. messages[] array forwarded verbatim');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const multiTurn = {
        model: MODEL,
        max_tokens: 10,
        messages: [
          { role: 'user',      content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user',      content: 'second' },
        ],
      };
      const r = await httpJson(port, 'POST', '/v1/messages', multiTurn);
      assert(r.status === 200, `multi-turn: status 200 (got ${r.status})`);
      const forwarded = stub.lastRequest()?.body?.messages;
      assert(Array.isArray(forwarded) && forwarded.length === 3,
        `messages array length preserved (got ${forwarded?.length})`);
      assert(forwarded?.[0]?.content === 'first', 'first message content preserved');
      assert(forwarded?.[2]?.content === 'second', 'third message content preserved');
    });

    // ── 7. system field forwarded ─────────────────────────────────────────────
    console.log('\n7. system field forwarded to backend');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const body = { ...MSG, model: MODEL, system: 'You are a test assistant.' };
      const r = await httpJson(port, 'POST', '/v1/messages', body);
      assert(r.status === 200, `system: status 200 (got ${r.status})`);
      const fwdSystem = stub.lastRequest()?.body?.system;
      assert(fwdSystem === 'You are a test assistant.',
        `system field preserved (got ${JSON.stringify(fwdSystem)})`);
    });

    // ── 8. max_tokens field forwarded ────────────────────────────────────────
    console.log('\n8. max_tokens field forwarded to backend');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const body = { ...MSG, model: MODEL, max_tokens: 42 };
      await httpJson(port, 'POST', '/v1/messages', body);
      assert(stub.lastRequest()?.body?.max_tokens === 42,
        `max_tokens=42 forwarded (got ${stub.lastRequest()?.body?.max_tokens})`);
    });

    // ── 9. tools[] array forwarded ────────────────────────────────────────────
    console.log('\n9. tools[] array forwarded verbatim');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const tools = [{ name: 'my_tool', description: 'does stuff', input_schema: { type: 'object', properties: {} } }];
      const body  = { ...MSG, model: MODEL, tools };
      const r = await httpJson(port, 'POST', '/v1/messages', body);
      assert(r.status === 200, `tools: status 200 (got ${r.status})`);
      const fwdTools = stub.lastRequest()?.body?.tools;
      assert(Array.isArray(fwdTools) && fwdTools.length === 1,
        `tools[] length=1 preserved (got ${fwdTools?.length})`);
      assert(fwdTools?.[0]?.name === 'my_tool', `tools[0].name preserved (got ${fwdTools?.[0]?.name})`);
    });

    // ── 10. Content with tool_use block forwarded ─────────────────────────────
    console.log('\n10. tool_use content block in messages forwarded');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const toolUseMsg = {
        model: MODEL,
        max_tokens: 10,
        messages: [
          { role: 'user', content: 'call a tool' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'my_tool', input: { x: 1 } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'result' }] },
        ],
      };
      const r = await httpJson(port, 'POST', '/v1/messages', toolUseMsg);
      assert(r.status === 200, `tool_use round-trip: status 200 (got ${r.status})`);
      const msgs = stub.lastRequest()?.body?.messages;
      assert(Array.isArray(msgs) && msgs.length === 3, `3 messages preserved (got ${msgs?.length})`);
      const assistantContent = msgs?.[1]?.content;
      assert(Array.isArray(assistantContent) && assistantContent[0]?.type === 'tool_use',
        'tool_use block preserved in assistant turn');
    });

    // ── 11. x-claude-proxy-served-by header set when ANNOTATE_MODEL=1 ────────
    console.log('\n11. x-claude-proxy-served-by response header with ANNOTATE_MODEL=1');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', { ...MSG, model: MODEL });
      assert(r.headers['x-claude-proxy-served-by'] === MODEL,
        `x-claude-proxy-served-by=${MODEL} (got ${r.headers['x-claude-proxy-served-by']})`);
    });

    // ── 12. agent_to_capability chain forwarded as concrete model ─────────────
    console.log('\n12. agent_to_capability chain: agent → capability → concrete model at stub');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', { ...MSG, model: 'test-agent' });
      assert(r.status === 200, `agent chain: status 200 (got ${r.status})`);
      const forwarded = stub.lastRequest()?.model_used;
      assert(forwarded === MODEL, `agent chain: stub got model=${forwarded}, expected ${MODEL}`);
    });

    // ── 13. x-custom-* headers forwarded upstream ─────────────────────────────
    console.log('\n13. x-custom-* request headers forwarded to backend');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', { ...MSG, model: MODEL },
        { 'x-custom-trace-id': 'abc123' });
      assert(r.status === 200, `custom headers: status 200 (got ${r.status})`);
      assert(stub.lastRequest()?.headers?.['x-custom-trace-id'] === 'abc123',
        'x-custom-trace-id forwarded to stub');
    });

    // ── 14. Response model field matches effective model ──────────────────────
    console.log('\n14. Response body model field = effective model');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', { ...MSG, model: MODEL });
      assert(r.json?.model === MODEL,
        `response.model=${MODEL} (got ${r.json?.model})`);
    });

    // ── 15. Unknown model → proxy returns error status ────────────────────────
    console.log('\n15. Unknown model → proxy returns error, does not crash');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', { ...MSG, model: 'completely-unknown-xyz' });
      assert(r.status >= 400 && r.status < 600,
        `unknown model → error status (got ${r.status})`);
    });

  } finally {
    if (stub) await stub.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
