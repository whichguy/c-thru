#!/usr/bin/env node
'use strict';
// Cross-provider concurrent dispatch: ONE proxy, THREE live stubs (anthropic,
// ollama, gemini), three capabilities each routing to a distinct provider.
// Fire all three concurrently and assert:
//   - each provider's stub received exactly ITS OWN request (no cross-talk),
//   - each response's served_by / x-c-thru-resolved-via is the right model,
//   - NO cross-provider auth bleed: the gemini x-goog-api-key never lands on
//     the anthropic/ollama hit, and an incoming Anthropic Bearer never reaches
//     the gemini or ollama stub.
//
// This closes the "concurrent shared-proxy only hits one provider" gap: the
// requestMeta/auth state is per-request, and a regression that leaked one
// provider's auth onto another's socket under concurrency would be caught here.
//
// Run: node test/proxy-cross-provider-concurrent.test.js

const fs   = require('fs');
const os   = require('os');
const http = require('http');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson,
  stubBackend, ollamaStubBackend,
} = require('./helpers');

console.log('proxy cross-provider concurrent dispatch tests\n');

// Minimal Gemini stub: records every request, answers :generateContent with a
// non-streaming success. Mirrors the geminiStub pattern in proxy-gemini-routing.
function geminiStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'gemini ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }));
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

const HEALTHY_NDJSON = [
  { message: { content: 'ollama ok' } },
  { done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 },
];

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-xprov-'));

  try {
    console.log('1. Three capabilities → three providers, fired concurrently');
    const anth   = await stubBackend();
    const ollama = await ollamaStubBackend(HEALTHY_NDJSON);
    const gem    = await geminiStub();
    try {
      const config = {
        endpoints: {
          anthBackend:   { kind: 'anthropic', url: `http://127.0.0.1:${anth.port}` },
          ollamaBackend: { kind: 'ollama',    url: `http://127.0.0.1:${ollama.port}` },
          geminiBackend: { format: 'gemini',  url: `http://127.0.0.1:${gem.port}`, auth_env: 'GOOGLE_API_KEY' },
        },
        model_routes: {
          'anth-model':   'anthBackend',
          'ollama-model': 'ollamaBackend',
          'gemini-model': 'geminiBackend',
        },
        llm_profiles: {
          'cap-anth':   { 'best-cloud': { '128gb': 'anth-model' } },
          'cap-ollama': { 'best-cloud': { '128gb': 'ollama-model' } },
          'cap-gemini': { 'best-cloud': { '128gb': 'gemini-model' } },
        },
      };
      const configPath = writeConfig(tmpDir, config);

      // Incoming Anthropic Bearer — must be stripped/replaced per-provider and
      // never reach the gemini or ollama upstream.
      const INCOMING_BEARER = 'Bearer sk-ant-incoming-leak-canary';
      const GOOGLE_KEY = 'goog-key-canary';
      const CLAUDE_CORRELATION_HEADERS = {
        'x-claude-code-session-id': 'session-cross-provider-canary',
        'x-claude-code-agent-id': 'agent-cross-provider-canary',
        'x-claude-code-parent-agent-id': 'parent-cross-provider-canary',
      };

      await withProxy({
        configPath, profile: '128gb', mode: 'best-cloud',
        env: { CLAUDE_LLM_MODE: 'best-cloud', GOOGLE_API_KEY: GOOGLE_KEY },
      }, async ({ port }) => {
        const mk = (cap) => httpJson(port, 'POST', '/v1/messages', {
          model: cap, stream: false,
          messages: [{ role: 'user', content: `route ${cap}` }], max_tokens: 5,
        }, {
          'Authorization': INCOMING_BEARER,
          ...CLAUDE_CORRELATION_HEADERS,
        }, 8000).then(r => ({ cap, r }));

        // Concurrent fan-out across all three providers.
        const results = await Promise.all([mk('cap-anth'), mk('cap-ollama'), mk('cap-gemini')]);
        const byCap = Object.fromEntries(results.map(({ cap, r }) => [cap, r]));

        // ── Each request succeeded ───────────────────────────────────────────
        assertEq(byCap['cap-anth'].status, 200, 'cap-anth status 200');
        assertEq(byCap['cap-ollama'].status, 200, 'cap-ollama status 200');
        assertEq(byCap['cap-gemini'].status, 200, 'cap-gemini status 200');

        // ── Each provider's stub got EXACTLY its own one request ─────────────
        assertEq(anth.requests.length, 1, 'anthropic stub received exactly 1 request');
        assertEq(ollama.requests.length, 1, 'ollama stub received exactly 1 request');
        // gemini may receive only the :generateContent call (no side traffic here).
        const gemGen = gem.requests.filter(rq => (rq.path || '').includes(':generateContent'));
        assertEq(gemGen.length, 1, 'gemini stub received exactly 1 generateContent request');

        // The anthropic stub saw the anthropic model; ollama saw the ollama model.
        assertEq(anth.requests[0].body?.model, 'anth-model', 'anthropic stub got anth-model in body');
        assertEq(ollama.requests[0].body?.model, 'ollama-model', 'ollama stub got ollama-model in body');
        // gemini routing puts the model in the URL path.
        assert((gemGen[0].path || '').includes('gemini-model'),
          `gemini request path carries gemini-model (got ${gemGen[0].path})`);

        // ── served_by correct per provider (the common observable) ───────────
        for (const [cap, model] of [['cap-anth', 'anth-model'], ['cap-ollama', 'ollama-model'], ['cap-gemini', 'gemini-model']]) {
          assertEq(byCap[cap].headers['x-c-thru-served-by'], model, `${cap}: x-c-thru-served-by=${model}`);
        }
        // Every provider dispatch stamps x-c-thru-resolved-via for header parity.
        for (const [cap, model] of [['cap-anth', 'anth-model'], ['cap-ollama', 'ollama-model'], ['cap-gemini', 'gemini-model']]) {
          const via = JSON.parse(byCap[cap].headers['x-c-thru-resolved-via'] || '{}');
          assertEq(via.capability, cap, `${cap}: resolved-via.capability=${cap}`);
          assertEq(via.served_by, model, `${cap}: resolved-via.served_by=${model}`);
        }

        // ── No cross-provider auth bleed ─────────────────────────────────────
        const anthHdrs = JSON.stringify(anth.requests[0].headers || {});
        const ollamaHdrs = JSON.stringify(ollama.requests[0].headers || {});
        const gemHdrs = gemGen[0].headers || {};
        const gemHdrStr = JSON.stringify(gemHdrs);

        // (a) gemini's x-goog-api-key never appears on the anthropic / ollama hit.
        assert(!anthHdrs.includes('x-goog-api-key') && !anthHdrs.includes(GOOGLE_KEY),
          'anthropic hit has NO gemini x-goog-api-key / google key');
        assert(!ollamaHdrs.includes('x-goog-api-key') && !ollamaHdrs.includes(GOOGLE_KEY),
          'ollama hit has NO gemini x-goog-api-key / google key');
        // gemini hit DOES carry its own key (sanity: routing+auth actually wired).
        assertEq(gemHdrs['x-goog-api-key'], GOOGLE_KEY, 'gemini hit carries its own x-goog-api-key');

        // (b) incoming Anthropic Bearer canary never reaches gemini or ollama upstream.
        assert(!gemHdrStr.includes('sk-ant-incoming-leak-canary'),
          `incoming Anthropic Bearer NOT forwarded to gemini (hdrs: ${gemHdrStr.slice(0, 160)})`);
        assert(!gemHdrs['authorization'],
          `gemini hit has no Authorization header (got ${gemHdrs['authorization']})`);
        assert(!ollamaHdrs.includes('sk-ant-incoming-leak-canary'),
          'incoming Anthropic Bearer NOT forwarded to ollama');

        // (c) Claude Code correlation IDs are local routing metadata. Custom
        // Anthropic-compatible, Ollama, and Gemini providers must not receive
        // stable session/agent identifiers.
        for (const [provider, headers] of [
          ['custom-anthropic', anth.requests[0].headers || {}],
          ['ollama', ollama.requests[0].headers || {}],
          ['gemini', gemHdrs],
        ]) {
          for (const name of Object.keys(CLAUDE_CORRELATION_HEADERS)) {
            assert(!Object.prototype.hasOwnProperty.call(headers, name),
              `${provider} hit does not receive ${name}`);
          }
        }
      });
    } finally {
      await anth.close().catch(() => {});
      await ollama.close().catch(() => {});
      await gem.close().catch(() => {});
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
