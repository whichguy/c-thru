#!/usr/bin/env node
'use strict';
// Tests for Gemini/Vertex endpoint routing in claude-proxy.
//
// Run: node test/proxy-gemini-routing.test.js

const fs   = require('fs');
const http = require('http');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeConfig, writeConfigFresh, httpJson, withProxy } = require('./helpers');

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

// Start a programmable Gemini stub that records every request and responds
// with whatever the active handler returns. The handler default emits a
// minimal Gemini non-streaming success.
function geminiStub() {
  const requests = [];
  let handler = (req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: 'ok' }] },
        finishReason: 'STOP'
      }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
    }));
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        lastRequest: () => requests[requests.length - 1] || null,
        setHandler: (h) => { handler = h; },
        close: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-gemini-route-'));
  let stub;
  try {
    stub = await geminiStub();

    // ── Phase 1 config: Google AI Studio endpoint with name aliasing ─────────
    // NOTE: route name swaps mirror config/model-map.json. Names use Google's
    // stable -latest aliases (gemini-pro-latest etc.) — version-pinned previews
    // get retired and would break the live e2e tests.
    const phase1Config = {
      endpoints: {
        gemini_ai: {
          format: 'gemini',
          url: `http://127.0.0.1:${stub.port}`,
          auth_env: 'GOOGLE_API_KEY',
        },
      },
      model_routes: {
        'gemini-latest': { endpoint: 'gemini_ai', name: 'gemini-pro-latest' },
        'gemini-pro':    { endpoint: 'gemini_ai', name: 'gemini-pro-latest' },
        'gemini-flash':  { endpoint: 'gemini_ai', name: 'gemini-flash-latest' },
        'gemini-fast':   { endpoint: 'gemini_ai', name: 'gemini-flash-lite-latest' },
        're:^gemini-(2|3)(\\.[0-9]+)?-.*': 'gemini_ai',
      },
    };
    const phase1Dir = fs.mkdtempSync(path.join(tmpDir, 'phase1-'));
    const phase1Path = writeConfig(phase1Dir, phase1Config);

    // ── T1. Model alias gemini-latest → endpoint + name swap ─────────────────
    console.log('\nT1. gemini-latest alias → endpoint + name swap');
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'test-key' } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
        stream: false,
      });
      const last = stub.lastRequest();
      assert(r.status === 200, 'status 200');
      assert(r.json?.content?.[0]?.text === 'ok', 'content[0].text === "ok"');
      assert(last?.path === '/v1beta/models/gemini-pro-latest:generateContent', `URL path swap (got ${last?.path})`);
      assert(last?.headers?.['x-goog-api-key'] === 'test-key', 'x-goog-api-key header set');
    });

    // ── T2. Regex route → no name swap (covers both 2.x and 3.x families) ────
    console.log('\nT2. regex route gemini-3-flash-preview → endpoint, no name swap');
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'test-key' } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-3-flash-preview',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      const last = stub.lastRequest();
      assert(r.status === 200, 'status 200');
      assert(last?.path === '/v1beta/models/gemini-3-flash-preview:generateContent', `URL path no swap (got ${last?.path})`);
    });

    // ── T2b. Regex also matches legacy 2.5 models ────────────────────────────
    console.log('\nT2b. regex also matches gemini-2.5-pro');
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'test-key' } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      const last = stub.lastRequest();
      assert(r.status === 200, 'status 200');
      assert(last?.path === '/v1beta/models/gemini-2.5-pro:generateContent', `URL path 2.5 (got ${last?.path})`);
    });

    // ── T6. Non-vertex Gemini auth uses x-goog-api-key, not Authorization ────
    console.log('\nT6. non-vertex Gemini → x-goog-api-key only');
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'test-key' } }, async ({ port }) => {
      await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      const last = stub.lastRequest();
      assert(last?.headers?.['x-goog-api-key'] === 'test-key', 'x-goog-api-key present');
      assert(!last?.headers?.['authorization'], `Authorization header absent (got ${last?.headers?.['authorization']})`);
    });

    // ── Phase 2 config: Vertex AI endpoint ───────────────────────────────────
    const phase2Config = {
      endpoints: {
        gemini_vertex: {
          format: 'gemini',
          vertex: true,
          url: `http://127.0.0.1:${stub.port}/v1/projects/test-proj/locations/us-central1/publishers/google/models`,
          auth_env: 'GOOGLE_CLOUD_TOKEN',
        },
      },
      model_routes: {
        'gemini-3-flash': 'gemini_vertex',
      },
    };
    const phase2Dir = fs.mkdtempSync(path.join(tmpDir, 'phase2-'));
    const phase2Path = writeConfig(phase2Dir, phase2Config);

    // ── T3. Vertex flag → URL skips /v1beta/models/ prefix ───────────────────
    console.log('\nT3. vertex flag → URL has no /v1beta/models/ prefix');
    await withProxy({ configPath: phase2Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_CLOUD_TOKEN: 'vertex-token' } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      const last = stub.lastRequest();
      const expected = '/v1/projects/test-proj/locations/us-central1/publishers/google/models/gemini-3-flash:generateContent';
      assert(r.status === 200, 'status 200');
      assert(last?.path === expected, `vertex URL (got ${last?.path})`);
      assert(!last?.path?.includes('/v1beta/models/'), 'no /v1beta/models/ prefix');
    });

    // ── T4. Vertex auth uses Authorization: Bearer ───────────────────────────
    console.log('\nT4. vertex flag → Authorization: Bearer, not x-goog-api-key');
    await withProxy({ configPath: phase2Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_CLOUD_TOKEN: 'vertex-token' } }, async ({ port }) => {
      await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      const last = stub.lastRequest();
      assert(last?.headers?.['authorization'] === 'Bearer vertex-token', `auth Bearer (got ${last?.headers?.['authorization']})`);
      assert(!last?.headers?.['x-goog-api-key'], `x-goog-api-key absent (got ${last?.headers?.['x-goog-api-key']})`);
    });

    // ── T5. Streaming Vertex uses :streamGenerateContent?alt=sse ─────────────
    console.log('\nT5. vertex streaming → :streamGenerateContent?alt=sse, no /v1beta/');
    stub.setHandler((req, res, body) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'hello' }] } }]
      }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        candidates: [{ content: { parts: [{ text: ' world' }] }, finishReason: 'STOP' }],
        usageMetadata: { candidatesTokenCount: 2 }
      }) + '\n\n');
      res.end();
    });
    await withProxy({ configPath: phase2Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_CLOUD_TOKEN: 'vertex-token' } }, async ({ port }) => {
      await new Promise((resolve) => {
        const req = http.request({
          port,
          method: 'POST',
          path: '/v1/messages',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          const events = [];
          let buffer = '';
          res.on('data', d => {
            buffer += d.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try { events.push(JSON.parse(line.slice(6))); } catch {}
              }
            }
          });
          res.on('end', () => {
            const last = stub.lastRequest();
            assert(last?.path?.endsWith(':streamGenerateContent?alt=sse'), `streaming URL suffix (got ${last?.path})`);
            assert(last?.path?.startsWith('/v1/projects/test-proj/'), 'vertex prefix preserved');
            assert(!last?.path?.includes('/v1beta/'), 'no /v1beta/ in streaming URL');
            assert(events.some(e => e.type === 'message_start'), 'received message_start');
            const deltas = events.filter(e => e.type === 'content_block_delta');
            assert(deltas[0]?.delta?.text === 'hello', 'first delta text');
            assert(deltas[1]?.delta?.text === ' world', 'second delta text');
            assert(events.some(e => e.type === 'message_stop'), 'received message_stop');
            resolve();
          });
        });
        req.write(JSON.stringify({
          model: 'gemini-3-flash',
          messages: [{ role: 'user', content: 'say hello' }],
          stream: true,
        }));
        req.end();
      });
    });
    // Restore default non-streaming handler for later tests / safety.
    stub.setHandler((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
      }));
    });

    // T7 from the plan was dropped: `c-thru explain --capability` resolves
    // through llm_profiles, not model_routes — `gemini-latest` is a route
    // alias, not a capability, so the explain command does not surface it.

    // ── T8. Upstream Gemini 4xx → propagated as Anthropic-shape error ────────
    console.log('\nT8. upstream 4xx from Gemini → Anthropic-shape error');
    stub.setHandler((req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 403, message: 'API key invalid', status: 'PERMISSION_DENIED' } }));
    });
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'bad-key' } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      assert(r.status === 403 || r.status === 502, `propagated upstream error status (got ${r.status})`);
      assert(r.json?.type === 'error', 'response shape is Anthropic error envelope');
      assert(/API key invalid|PERMISSION_DENIED|Gemini error/.test(r.bodyText || ''), 'error message includes upstream context');
    });

    // ── T10. Multi-turn tool roundtrip: user → tool_use → tool_result → final
    console.log('\nT10. multi-turn tool conversation (tool_use_id ↔ functionResponse.name)');
    let geminiBodyT10 = null;
    stub.setHandler((req, res, body) => {
      geminiBodyT10 = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'final answer: 42' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
      }));
    });
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        tools: [{ name: 'calc', description: 'do math', input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] } }],
        messages: [
          { role: 'user', content: 'what is x?' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_abc', name: 'calc', input: { x: 42 } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_abc', content: '42' }] },
        ],
        stream: false,
      });
      assert(r.status === 200, 'roundtrip status 200');
      assert(r.json?.content?.[0]?.text === 'final answer: 42', 'final assistant text returned');
      // Verify the Gemini request body shape
      assert(geminiBodyT10?.tools?.[0]?.functionDeclarations?.[0]?.name === 'calc', 'tool declaration mapped');
      assert(geminiBodyT10?.tools?.[0]?.functionDeclarations?.[0]?.parameters?.type === 'object', 'parameters carries input_schema');
      const turns = geminiBodyT10?.contents || [];
      assert(turns.length === 3, `3 conversation turns (got ${turns.length})`);
      assert(turns[1]?.role === 'model' && turns[1]?.parts?.[0]?.functionCall?.name === 'calc', 'assistant tool_use → model functionCall');
      const fr = turns[2]?.parts?.[0]?.functionResponse;
      assert(fr?.name === 'calc', 'tool_result → functionResponse with name resolved via tool_use_id lookup');
      assert(fr?.response != null, 'functionResponse has response object');
    });

    // ── T11. tool_choice mapping → toolConfig.functionCallingConfig ──────────
    console.log('\nT11. tool_choice mapping → Gemini toolConfig');
    const tc_cases = [
      { input: { type: 'auto' },               expected: { mode: 'AUTO' } },
      { input: { type: 'any' },                expected: { mode: 'ANY' } },
      { input: { type: 'tool', name: 'calc' }, expected: { mode: 'ANY', allowedFunctionNames: ['calc'] } },
      { input: { type: 'none' },               expected: { mode: 'NONE' } },
    ];
    for (const tc of tc_cases) {
      let captured = null;
      stub.setHandler((req, res, body) => {
        captured = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
        }));
      });
      await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
        await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-latest',
          tools: [{ name: 'calc', description: 'd', input_schema: { type: 'object' } }],
          tool_choice: tc.input,
          messages: [{ role: 'user', content: 'go' }],
          stream: false,
        });
        const cfg = captured?.toolConfig?.functionCallingConfig;
        assert(cfg?.mode === tc.expected.mode, `tool_choice ${tc.input.type} → mode ${tc.expected.mode} (got ${cfg?.mode})`);
        if (tc.expected.allowedFunctionNames) {
          assert(JSON.stringify(cfg?.allowedFunctionNames) === JSON.stringify(tc.expected.allowedFunctionNames), 'allowedFunctionNames preserved');
        } else {
          assert(!cfg?.allowedFunctionNames, 'no allowedFunctionNames when not type:tool');
        }
      });
    }

    // ── T12. JSON Schema scrubbing — oneOf/anyOf/allOf/$ref/$defs stripped ───
    console.log('\nT12. JSON Schema scrubber for input_schema');
    let capturedT12 = null;
    let respHeadersT12 = null;
    stub.setHandler((req, res, body) => {
      capturedT12 = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
      }));
    });
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        tools: [{
          name: 'lookup',
          description: 'd',
          input_schema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: {
              q: {
                oneOf: [
                  { type: 'string' },
                  { type: 'number' },
                ],
              },
              meta: {
                allOf: [
                  { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
                  { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
                ],
              },
              ref_field: { $ref: '#/$defs/SomeType' },
            },
            $defs: { SomeType: { type: 'string' } },
          },
        }],
        messages: [{ role: 'user', content: 'go' }],
        stream: false,
      });
      respHeadersT12 = r.headers;
      const params = capturedT12?.tools?.[0]?.functionDeclarations?.[0]?.parameters;
      const text = JSON.stringify(params || {});
      assert(!text.includes('oneOf'), 'oneOf removed from scrubbed schema');
      assert(!text.includes('anyOf'), 'anyOf not present');
      assert(!text.includes('allOf'), 'allOf merged away');
      assert(!text.includes('$ref'),  '$ref removed');
      assert(!text.includes('$defs'), '$defs removed');
      // oneOf collapse: q should now have type:string (first variant)
      assert(params?.properties?.q?.type === 'string', 'oneOf collapsed to first variant');
      // allOf merge: meta should have both a and b in properties; both required
      const metaProps = params?.properties?.meta?.properties || {};
      assert(metaProps.a && metaProps.b, 'allOf merged sibling properties');
      const metaReq = params?.properties?.meta?.required || [];
      assert(metaReq.includes('a') && metaReq.includes('b'), 'allOf merged required arrays');
      assert(/oneOf|allOf|\$ref|\$defs/.test(respHeadersT12?.['x-c-thru-schema-scrubbed'] || ''), `scrubbed header set (got ${respHeadersT12?.['x-c-thru-schema-scrubbed']})`);
    });

    // ── T12b. Gemini-rejected fields stripped from input_schema ──────────
    console.log('\nT12b. additionalProperties/propertyNames/const/exclusiveMin/llmGuidance/examples stripped');
    let capturedT12b = null;
    let respHeadersT12b = null;
    stub.setHandler((req, res, body) => {
      capturedT12b = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
      }));
    });
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        tools: [{
          name: 'lookup',
          description: 'd',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            propertyNames: { pattern: '^[a-z]+$' },
            llmGuidance: 'Claude Code custom field',
            properties: {
              meta:    { type: 'object', additionalProperties: { type: 'string' } },
              status:  { type: 'string', const: 'active' },
              count:   { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 100 },
              choices: { type: 'string', examples: ['a', 'b'] },
            },
          },
        }],
        messages: [{ role: 'user', content: 'go' }],
        stream: false,
      });
      respHeadersT12b = r.headers;
      const params = capturedT12b?.tools?.[0]?.functionDeclarations?.[0]?.parameters;
      const text = JSON.stringify(params || {});
      for (const f of ['additionalProperties', 'propertyNames', 'llmGuidance', 'const', 'exclusiveMinimum', 'exclusiveMaximum', 'examples']) {
        assert(!text.includes(f), `${f} stripped at every depth`);
      }
      const hdr = respHeadersT12b?.['x-c-thru-schema-scrubbed'] || '';
      for (const f of ['additionalProperties', 'propertyNames', 'llmGuidance', 'const', 'exclusiveMinimum', 'exclusiveMaximum', 'examples']) {
        assert(hdr.includes(f), `${f} in scrubbed header (got ${hdr})`);
      }
    });

    // ── T13. Streaming tool_use — Gemini functionCall → Anthropic SSE blocks
    console.log('\nT13. streaming functionCall → Anthropic tool_use SSE blocks');
    stub.setHandler((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: 'calc', args: { x: 42 }, id: 'fc_1' } }] } }]
      }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
        usageMetadata: { candidatesTokenCount: 3 }
      }) + '\n\n');
      res.end();
    });
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
      await new Promise((resolve) => {
        const req = http.request({ port, method: 'POST', path: '/v1/messages', headers: { 'Content-Type': 'application/json' } }, (res) => {
          const events = [];
          let buf = '';
          res.on('data', d => {
            buf += d.toString();
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const ln of lines) {
              if (ln.startsWith('data: ')) {
                try { events.push(JSON.parse(ln.slice(6))); } catch {}
              }
            }
          });
          res.on('end', () => {
            const start = events.find(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
            assert(!!start, 'content_block_start tool_use emitted');
            assert(start?.content_block?.name === 'calc', 'tool name = calc');
            assert(start?.content_block?.id === 'fc_1', 'Gemini-supplied id preserved');
            const delta = events.find(e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta');
            assert(!!delta, 'input_json_delta emitted');
            assert(JSON.parse(delta.delta.partial_json || '{}').x === 42, 'args streamed via partial_json');
            const stop = events.find(e => e.type === 'content_block_stop');
            assert(!!stop, 'content_block_stop emitted');
            const msgDelta = events.find(e => e.type === 'message_delta');
            assert(msgDelta?.delta?.stop_reason === 'tool_use', `stop_reason=tool_use (got ${msgDelta?.delta?.stop_reason})`);
            resolve();
          });
        });
        req.write(JSON.stringify({
          model: 'gemini-latest',
          tools: [{ name: 'calc', description: 'd', input_schema: { type: 'object' } }],
          messages: [{ role: 'user', content: 'go' }],
          stream: true,
        }));
        req.end();
      });
    });

    // ── T14. Streaming text → tool_use transition (block index increments) ───
    console.log('\nT14. streaming text-then-tool emits two distinct blocks');
    stub.setHandler((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'thinking...' }] } }]
      }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: 'calc', args: { x: 1 } } }] }, finishReason: 'STOP' }],
        usageMetadata: { candidatesTokenCount: 1 }
      }) + '\n\n');
      res.end();
    });
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
      await new Promise((resolve) => {
        const req = http.request({ port, method: 'POST', path: '/v1/messages', headers: { 'Content-Type': 'application/json' } }, (res) => {
          const events = [];
          let buf = '';
          res.on('data', d => {
            buf += d.toString();
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const ln of lines) {
              if (ln.startsWith('data: ')) { try { events.push(JSON.parse(ln.slice(6))); } catch {} }
            }
          });
          res.on('end', () => {
            const starts = events.filter(e => e.type === 'content_block_start');
            assert(starts.length === 2, `2 content_block_start events (got ${starts.length})`);
            assert(starts[0].content_block?.type === 'text', 'block 0 = text');
            assert(starts[0].index === 0, 'block 0 index = 0');
            assert(starts[1].content_block?.type === 'tool_use', 'block 1 = tool_use');
            assert(starts[1].index === 1, 'block 1 index = 1');
            const stops = events.filter(e => e.type === 'content_block_stop');
            assert(stops.length === 2, `2 content_block_stop events (got ${stops.length})`);
            const msgDelta = events.find(e => e.type === 'message_delta');
            assert(msgDelta?.delta?.stop_reason === 'tool_use', 'stop_reason=tool_use (trailing tool wins)');
            resolve();
          });
        });
        req.write(JSON.stringify({
          model: 'gemini-latest',
          tools: [{ name: 'calc', description: 'd', input_schema: { type: 'object' } }],
          messages: [{ role: 'user', content: 'go' }],
          stream: true,
        }));
        req.end();
      });
    });

    // ── T15. Non-streaming tool_use sets stop_reason=tool_use ────────────────
    console.log('\nT15. non-streaming tool_use → stop_reason=tool_use');
    stub.setHandler((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{
          content: { parts: [{ functionCall: { name: 'calc', args: { x: 1 }, id: 'g_id_xyz' } }] },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 }
      }));
    });
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        tools: [{ name: 'calc', description: 'd', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'go' }],
        stream: false,
      });
      assert(r.json?.stop_reason === 'tool_use', `stop_reason=tool_use (got ${r.json?.stop_reason})`);
      assert(r.json?.content?.[0]?.type === 'tool_use', 'content[0] is tool_use');
      assert(r.json?.content?.[0]?.id === 'g_id_xyz', 'Gemini-supplied id preserved on non-streaming');
    });

    // ── T16. functionResponse.id propagated for parallel tool_result ─────────
    console.log('\nT16. tool_result tool_use_id propagated to functionResponse.id');
    let capturedT16 = null;
    stub.setHandler((req, res, body) => {
      capturedT16 = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
      }));
    });
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
      await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        tools: [{ name: 'calc', description: 'd', input_schema: { type: 'object' } }],
        messages: [
          { role: 'user', content: 'compute' },
          { role: 'assistant', content: [
            { type: 'tool_use', id: 'tu_a', name: 'calc', input: { x: 1 } },
            { type: 'tool_use', id: 'tu_b', name: 'calc', input: { x: 2 } },
          ]},
          { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'tu_a', content: '1' },
            { type: 'tool_result', tool_use_id: 'tu_b', content: '4' },
          ]},
        ],
        stream: false,
      });
      const turns = capturedT16?.contents || [];
      const calls = turns[1]?.parts || [];
      assert(calls[0]?.functionCall?.id === 'tu_a' && calls[1]?.functionCall?.id === 'tu_b', 'functionCall.id preserved from tool_use.id');
      const resps = turns[2]?.parts || [];
      assert(resps[0]?.functionResponse?.id === 'tu_a', `functionResponse[0].id = tu_a (got ${resps[0]?.functionResponse?.id})`);
      assert(resps[1]?.functionResponse?.id === 'tu_b', `functionResponse[1].id = tu_b (got ${resps[1]?.functionResponse?.id})`);
      assert(resps[0]?.functionResponse?.name === 'calc' && resps[1]?.functionResponse?.name === 'calc', 'functionResponse.name resolved via lookup');
    });

    // ── T9. Missing GOOGLE_API_KEY env → no auth header, upstream sees no key
    console.log('\nT9. missing GOOGLE_API_KEY → no x-goog-api-key/Authorization sent');
    stub.setHandler(null);
    stub.setHandler((req, res) => {
      // Echo back whether auth was present (for assertion).
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
      }));
    });
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud' /* no GOOGLE_API_KEY */ } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      const last = stub.lastRequest();
      assert(last?.path?.includes('gemini-pro-latest'), 'request reached stub with phase1 routing');
      assert(!last?.headers?.['x-goog-api-key'], `no x-goog-api-key when env unset (got ${last?.headers?.['x-goog-api-key']})`);
      assert(!last?.headers?.['authorization'], `no Authorization fallback when env unset (got ${last?.headers?.['authorization']})`);
    });

    // ── T-thought-sig. Gemini 3+ thoughtSignature round-trips on tool_use ──
    // Turn 1: Gemini returns functionCall with thoughtSignature.
    // Turn 2: client sends tool_use back in messages; proxy must re-attach the
    //         signature to the outbound functionCall part.
    console.log('\nT-thought-sig. thoughtSignature captured + re-attached on tool_use round-trip');
    let capturedTSReq2 = null;
    let turn = 0;
    stub.setHandler((req, res, body) => {
      turn++;
      if (turn === 1) {
        // Turn 1: respond with functionCall + thoughtSignature
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{
            content: { parts: [{
              functionCall: { name: 'calc', args: { x: 1 }, id: 'gem_id_42' },
              thoughtSignature: 'SIG_FROM_GEMINI_TURN1',
            }] },
            finishReason: 'STOP'
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
        }));
      } else {
        capturedTSReq2 = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
        }));
      }
    });
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
      // Turn 1: tool definition + user prompt → triggers functionCall response
      const r1 = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        tools: [{ name: 'calc', description: 'd', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'compute' }],
        stream: false,
      });
      assert(r1.json?.content?.[0]?.type === 'tool_use', 'turn 1 returned tool_use');
      const toolId = r1.json.content[0].id;
      assert(toolId === 'gem_id_42', `tool_use.id from Gemini (got ${toolId})`);

      // Turn 2: send back tool_use + tool_result. Proxy should re-attach
      // the cached thoughtSignature to the functionCall part.
      await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        tools: [{ name: 'calc', description: 'd', input_schema: { type: 'object' } }],
        messages: [
          { role: 'user', content: 'compute' },
          { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'calc', input: { x: 1 } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: '42' }] },
        ],
        stream: false,
      });
      const turn2parts = capturedTSReq2?.contents?.[1]?.parts || [];
      const fcPart = turn2parts[0] || {};
      assert(fcPart.functionCall?.name === 'calc', 'turn 2 has functionCall for calc');
      assert(fcPart.thoughtSignature === 'SIG_FROM_GEMINI_TURN1', `thoughtSignature re-attached (got ${fcPart.thoughtSignature})`);
    });

    // ── T-leak. Ambient ANTHROPIC Bearer must NOT leak to Gemini upstream ────
    console.log('\nT-leak. incoming Bearer (ambient ANTHROPIC_API_KEY) does not leak to Gemini');
    stub.setHandler((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
      }));
    });
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'real-google-key' } }, async ({ port }) => {
      await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }, { 'Authorization': 'Bearer sk-ant-fake-leak' });
      const last = stub.lastRequest();
      const headerStr = JSON.stringify(last?.headers || {});
      assert(!headerStr.includes('sk-ant-fake-leak'), `Anthropic Bearer must not appear in any forwarded header (got: ${headerStr.slice(0, 200)})`);
      assert(last?.headers?.['x-goog-api-key'] === 'real-google-key', `x-goog-api-key set from GOOGLE_API_KEY (got ${last?.headers?.['x-goog-api-key']})`);
      assert(!last?.headers?.['authorization'], `no Authorization header forwarded (got ${last?.headers?.['authorization']})`);
    });

    // ── T-finish-reasons. Gemini finishReason → Anthropic stop_reason mapping
    console.log('\nT-finish-reasons. SAFETY/RECITATION/etc → stop_sequence=gemini_safety_block');
    const finishCases = [
      { in: 'STOP',                expectedReason: 'end_turn',      expectedSeq: null },
      { in: 'MAX_TOKENS',          expectedReason: 'max_tokens',    expectedSeq: null },
      { in: 'SAFETY',              expectedReason: 'stop_sequence', expectedSeq: 'gemini_safety_block' },
      { in: 'RECITATION',          expectedReason: 'stop_sequence', expectedSeq: 'gemini_safety_block' },
      { in: 'BLOCKLIST',           expectedReason: 'stop_sequence', expectedSeq: 'gemini_safety_block' },
      { in: 'PROHIBITED_CONTENT',  expectedReason: 'stop_sequence', expectedSeq: 'gemini_safety_block' },
      { in: 'SPII',                expectedReason: 'stop_sequence', expectedSeq: 'gemini_safety_block' },
      { in: 'OTHER',               expectedReason: 'end_turn',      expectedSeq: null },
      { in: 'NEW_REASON_FROM_GOOGLE', expectedReason: 'end_turn',   expectedSeq: null },
    ];
    for (const fc of finishCases) {
      // Non-streaming
      stub.setHandler((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: fc.in }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
        }));
      });
      await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-latest', messages: [{ role: 'user', content: 'hi' }], stream: false,
        });
        assert(r.json?.stop_reason === fc.expectedReason, `[non-stream ${fc.in}] stop_reason=${fc.expectedReason} (got ${r.json?.stop_reason})`);
        assert(r.json?.stop_sequence === fc.expectedSeq, `[non-stream ${fc.in}] stop_sequence=${fc.expectedSeq} (got ${r.json?.stop_sequence})`);
      });
      // Streaming
      stub.setHandler((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: fc.in }],
          usageMetadata: { candidatesTokenCount: 1 }
        }) + '\n\n');
        res.end();
      });
      await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
        await new Promise((resolve) => {
          const req = http.request({ port, method: 'POST', path: '/v1/messages', headers: { 'Content-Type': 'application/json' } }, (res) => {
            const events = [];
            let buf = '';
            res.on('data', d => {
              buf += d.toString();
              const lines = buf.split('\n');
              buf = lines.pop();
              for (const ln of lines) {
                if (ln.startsWith('data: ')) { try { events.push(JSON.parse(ln.slice(6))); } catch {} }
              }
            });
            res.on('end', () => {
              const md = events.find(e => e.type === 'message_delta');
              assert(md?.delta?.stop_reason === fc.expectedReason, `[stream ${fc.in}] stop_reason=${fc.expectedReason} (got ${md?.delta?.stop_reason})`);
              assert(md?.delta?.stop_sequence === fc.expectedSeq, `[stream ${fc.in}] stop_sequence=${fc.expectedSeq} (got ${md?.delta?.stop_sequence})`);
              resolve();
            });
          });
          req.write(JSON.stringify({ model: 'gemini-latest', messages: [{ role: 'user', content: 'hi' }], stream: true }));
          req.end();
        });
      });
    }

    // ── T-system-cache. cache_control on system blocks is stripped ───────────
    console.log('\nT-system-cache. system cache_control stripped before forwarding to Gemini');
    let capturedSysA = null, capturedSysB = null;
    stub.setHandler((req, res, body) => {
      if (capturedSysA === null) capturedSysA = body; else capturedSysB = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
      }));
    });
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
      // Mixed text + cache_control system blocks
      await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        system: [
          { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Be brief.' },
        ],
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      const sys = capturedSysA?.systemInstruction;
      assert(!!sys, 'systemInstruction set');
      assert(sys?.parts?.[0]?.text === 'You are helpful.\nBe brief.', `joined system text (got ${JSON.stringify(sys?.parts?.[0]?.text)})`);
      const fullBody = JSON.stringify(capturedSysA || {});
      assert(!fullBody.includes('cache_control'), 'cache_control nowhere in outbound body');
      assert(!fullBody.includes('ephemeral'), 'ephemeral marker nowhere in outbound body');

      // Edge: a system block with only cache_control and no text
      await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        system: [{ type: 'text', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      assert(capturedSysB?.systemInstruction === undefined, 'no systemInstruction when all blocks are cache_control-only');
    });

    // ── T-vertex-interp. ${VAR} interpolation in endpoint URLs at config-load
    console.log('\nT-vertex-interp. ${VAR} substitution in endpoints.*.url');
    const interpDir = fs.mkdtempSync(path.join(tmpDir, 'interp-'));
    const interpConfig = {
      endpoints: {
        gemini_vertex_test: {
          format: 'gemini',
          vertex: true,
          url: `http://127.0.0.1:${stub.port}/v1/projects/\${GOOGLE_CLOUD_PROJECT}/locations/\${GOOGLE_CLOUD_REGION}/publishers/google/models`,
          auth_env: 'GOOGLE_CLOUD_TOKEN',
        },
      },
      model_routes: { 'gemini-vertex-test': 'gemini_vertex_test' },
    };
    const interpPath = writeConfig(interpDir, interpConfig);
    stub.setHandler((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
      }));
    });
    await withProxy({ configPath: interpPath, profile: '16gb', env: {
      CLAUDE_LLM_MODE: 'best-cloud',
      GOOGLE_CLOUD_TOKEN: 'tok',
      GOOGLE_CLOUD_PROJECT: 'my-proj',
      GOOGLE_CLOUD_REGION: 'us-central1',
    } }, async ({ port }) => {
      await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-vertex-test', messages: [{ role: 'user', content: 'hi' }], stream: false,
      });
      const last = stub.lastRequest();
      assert(last?.path?.includes('/projects/my-proj/'), `project interpolated (got ${last?.path})`);
      assert(last?.path?.includes('/locations/us-central1/'), `region interpolated (got ${last?.path})`);
      assert(!last?.path?.includes('${'), `no literal \${} left in URL (got ${last?.path})`);
    });
    // Unset case: should warn (stderr) but not crash
    await withProxy({ configPath: interpPath, profile: '16gb', env: {
      CLAUDE_LLM_MODE: 'best-cloud',
      GOOGLE_CLOUD_TOKEN: 'tok',
      // GOOGLE_CLOUD_PROJECT/REGION intentionally unset
    } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-vertex-test', messages: [{ role: 'user', content: 'hi' }], stream: false,
      });
      assert(r.status > 0, 'proxy did not crash on unset interpolation vars');
      const last = stub.lastRequest();
      // Both empty → '/projects//locations//publishers/...' — interpolation produced empty segments
      assert(last?.path?.includes('/projects//locations//') || r.status >= 400, `unset vars produce empty segments (got ${last?.path}, status ${r.status})`);
    });

    // ── T-count-tokens. /v1/messages/count_tokens → Gemini :countTokens ─────
    console.log('\nT-count-tokens. /v1/messages/count_tokens routes to :countTokens with translated response');
    let countBody = null;
    stub.setHandler((req, res, body) => {
      countBody = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ totalTokens: 42 }));
    });
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'test-key' } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages/count_tokens', {
        model: 'gemini-latest',
        messages: [{ role: 'user', content: 'hello world' }],
      });
      const last = stub.lastRequest();
      assert(r.status === 200, 'count_tokens status 200');
      assert(last?.path === '/v1beta/models/gemini-pro-latest:countTokens', `:countTokens URL (got ${last?.path})`);
      assert(r.json?.input_tokens === 42, `input_tokens=42 (got ${r.json?.input_tokens})`);
      assert(r.json?.type !== 'message', 'response is not type:message (no model invocation)');
      assert(countBody?.contents?.length === 1, 'contents forwarded');
      assert(!countBody?.generationConfig, 'generationConfig stripped');
    });

    // ── T-obs-headers. G7 + G10 + G13 observability headers ─────────────────
    console.log('\nT-obs-headers. x-c-thru-beta-dropped + request-id + x-c-thru-schema-scrubbed');
    stub.setHandler((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
      }));
    });
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        tools: [{ name: 'x', description: 'd', input_schema: { type: 'object', properties: { q: { oneOf: [{ type: 'string' }, { type: 'number' }] } } } }],
        messages: [{ role: 'user', content: 'go' }],
        stream: false,
      }, { 'anthropic-beta': 'prompt-caching-2024-07-31, computer-use-2024-10-22' });
      assert(r.status === 200, 'obs-headers status 200');
      const dropped = r.headers?.['x-c-thru-beta-dropped'] || '';
      assert(/prompt-caching-2024-07-31/.test(dropped) && /computer-use-2024-10-22/.test(dropped), `beta-dropped lists both tokens (got '${dropped}')`);
      const rid = r.headers?.['request-id'] || '';
      assert(/^req_[a-f0-9]+$/i.test(rid), `request-id generated when upstream absent (got '${rid}')`);
      const scrubbed = r.headers?.['x-c-thru-schema-scrubbed'] || '';
      assert(scrubbed.length > 0, `schema-scrubbed header set when fields stripped (got '${scrubbed}')`);
    });

    // ── T-obs-rid-passthrough. Upstream-supplied request-id preserved ───────
    console.log('\nT-obs-rid-passthrough. valid incoming request-id passes through');
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-latest',
        messages: [{ role: 'user', content: 'go' }],
        stream: false,
      }, { 'request-id': 'req_deadbeef12345678' });
      assert(r.headers?.['request-id'] === 'req_deadbeef12345678', `upstream req_… preserved (got '${r.headers?.['request-id']}')`);
    });

    // ── T-models. /v1/models lists configured routes (Anthropic shape) ──────
    console.log('\nT-models. GET /v1/models -> Anthropic {data:[{type:model,id}]} from model_routes');
    await withProxy({ configPath: phase1Path, profile: '16gb', env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: 'k' } }, async ({ port }) => {
      const r = await httpJson(port, 'GET', '/v1/models');
      assert(r.status === 200, '/v1/models status 200');
      assert(Array.isArray(r.json?.data), 'data is array');
      const ids = (r.json.data || []).map(m => m.id);
      assert(ids.includes('gemini-latest'), `gemini-latest enumerated (got ${JSON.stringify(ids)})`);
      assert(ids.includes('gemini-flash'), 'gemini-flash enumerated');
      assert(!ids.some(id => id.startsWith('re:')), 'regex routes excluded');
      const first = (r.json.data || [])[0];
      assert(first?.type === 'model', 'each entry type=model');
      assert(typeof first?.created_at === 'string', 'created_at present');
    });

    // ── T-explain-model. c-thru explain --model walks model_routes ───────────
    console.log('\nT-explain-model. c-thru explain --model resolves through model_routes');
    const explainBin = path.join(__dirname, '..', 'tools', 'c-thru-explain.js');
    const result = spawnSync(process.execPath, [explainBin, '--model', 'gemini-latest'], {
      env: Object.assign({}, process.env, { CLAUDE_MODEL_MAP_PATH: phase1Path }),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert(result.status === 0, `explain --model exits 0 (got ${result.status}, stderr: ${result.stderr})`);
    const out = result.stdout || '';
    assert(/gemini_ai/.test(out), `output mentions endpoint gemini_ai (got: ${out.slice(0, 200)})`);
    assert(/gemini-pro-latest/.test(out), `output mentions name swap target (got: ${out.slice(0, 200)})`);

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
