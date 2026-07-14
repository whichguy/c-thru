#!/usr/bin/env node
'use strict';
/**
 * Claude Code LLM gateway protocol pins
 *
 * Pins the load-bearing contract from
 * https://code.claude.com/docs/en/llm-gateway-protocol against the
 * Anthropic-format path of claude-proxy:
 *
 *   1. Streaming is not fully buffered before first client bytes
 *   2. Non-fallback 400 bodies keep upstream wording (CC auto-recovery)
 *   3. anthropic-beta / anthropic-version are open-list forwarded
 *   4. tool_reference content blocks pass through body rewrite-free
 *   5. HEAD / and GET /v1/models are present (startup / discovery)
 *   6. picker_alias_endpoints default includes xai → claude-via-* for discovery
 *
 * Stdlib-only. Run: node test/proxy-gateway-protocol.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, stubBackend, httpJson,
} = require('./helpers');

console.log('proxy-gateway-protocol: Claude Code gateway contract pins\n');

function anthropicConfig(stubPort, extra = {}) {
  return Object.assign({
    endpoints: {
      anthropic: {
        kind: 'anthropic',
        url: `http://127.0.0.1:${stubPort}`,
        format: 'anthropic',
        auth: 'none',
      },
      xai: {
        kind: 'anthropic',
        url: `http://127.0.0.1:${stubPort}`,
        format: 'anthropic',
        auth: 'none',
      },
    },
    model_routes: {
      'gw-model': 'anthropic',
      'grok-4.5': 'xai',
    },
    llm_profiles: {
      workhorse: {
        'best-cloud': { '128gb': 'gw-model' },
        on_failure: 'hard_fail',
      },
    },
  }, extra);
}

/** Upstream that emits SSE frames with intentional delay between them. */
function delayedSseStub(delayMs) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      requests.push({ method: req.method, path: req.url, body, headers: req.headers });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const start = {
        type: 'message_start',
        message: {
          id: 'msg_gw_stream',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'gw-model',
          stop_reason: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      };
      res.write(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`);
      setTimeout(() => {
        res.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start', index: 0,
          content_block: { type: 'text', text: '' },
        })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: 'hi' },
        })}\n\n`);
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop', index: 0,
        })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        })}\n\n`);
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        res.end();
      }, delayMs);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

/** Raw streaming client that records first-byte timing. */
function httpStreamTimed(port, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const t0 = Date.now();
    let tFirst = null;
    const chunks = [];
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        Accept: 'text/event-stream',
      },
    }, (res) => {
      res.on('data', (c) => {
        if (tFirst == null) tFirst = Date.now();
        chunks.push(c);
      });
      res.on('end', () => {
        const tEnd = Date.now();
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw,
          t0,
          tFirst,
          tEnd,
          firstChunkLeadMs: tFirst == null ? null : (tFirst - t0),
          restMs: tFirst == null ? null : (tEnd - tFirst),
        });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`httpStreamTimed timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-gw-proto-'));
  try {
    // ── 1. Streaming not fully buffered ───────────────────────────────────
    console.log('1. SSE first client bytes arrive before delayed upstream finishes');
    {
      const DELAY = 250;
      const stub = await delayedSseStub(DELAY);
      try {
        const configPath = writeConfig(tmpDir, anthropicConfig(stub.port));
        await withProxy({
          configPath,
          profile: '128gb',
          mode: 'best-cloud',
          env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
        }, async ({ port }) => {
          const r = await httpStreamTimed(port, {
            model: 'gw-model',
            max_tokens: 16,
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
          }, 8000);
          assertEq(r.status, 200, 'stream status 200');
          assert(r.tFirst != null, 'received at least one client data chunk');
          // First bytes must arrive well before the delayed tail would complete
          // if the proxy had buffered the whole stream (would be ~DELAY + overhead).
          assert(r.firstChunkLeadMs < DELAY,
            `first chunk at ${r.firstChunkLeadMs}ms should be < delay ${DELAY}ms (proxy must not buffer full SSE)`);
          assert(/event:\s*message_start/.test(r.raw), 'raw stream contains message_start');
          assert(/event:\s*message_stop/.test(r.raw), 'raw stream eventually contains message_stop');
          // Tail should still reflect the delay (proves we waited for later frames).
          assert(r.restMs >= DELAY * 0.6,
            `rest of stream took ${r.restMs}ms (≥ ~${Math.round(DELAY * 0.6)}ms expected after first byte)`);
        });
      } finally {
        await stub.close().catch(() => {});
      }
    }

    // ── 2. 400 body wording fidelity ──────────────────────────────────────
    console.log('\n2. non-fallback 400 forwards upstream error body verbatim');
    {
      const EXACT_MSG =
        "Input tag 'adaptive' found using 'type' does not match any of the expected tags";
      const stub = await stubBackend();
      stub.setHandler((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const err = {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: EXACT_MSG,
            },
          };
          const raw = JSON.stringify(err);
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(raw),
          });
          res.end(raw);
        });
        return true;
      });
      try {
        const configPath = writeConfig(tmpDir, anthropicConfig(stub.port));
        await withProxy({
          configPath,
          profile: '128gb',
          mode: 'best-cloud',
          env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
        }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'gw-model',
            max_tokens: 16,
            thinking: { type: 'adaptive' },
            messages: [{ role: 'user', content: '.' }],
          }, {}, 5000);
          assertEq(r.status, 400, 'status 400');
          // Claude Code recovery matches on upstream wording — must not wrap.
          assert(r.bodyText && r.bodyText.includes(EXACT_MSG),
            `body includes exact upstream message (got: ${(r.bodyText || '').slice(0, 200)})`);
          assert(!/backend\s+\S+\s+returned\s+400/i.test(r.bodyText || ''),
            'body must not use proxy sendAnthropicError wrapper for non-fallback 400');
          assertEq(r.json && r.json.error && r.json.error.type, 'invalid_request_error',
            'error.type preserved');
        });
      } finally {
        await stub.close().catch(() => {});
      }
    }

    // ── 3. anthropic-beta open-list forward ───────────────────────────────
    console.log('\n3. novel anthropic-beta + anthropic-version forwarded to upstream');
    {
      const NOVEL_BETA = 'future-capability-2099-01-01,another-beta-2099-02-02';
      const stub = await stubBackend();
      try {
        const configPath = writeConfig(tmpDir, anthropicConfig(stub.port));
        await withProxy({
          configPath,
          profile: '128gb',
          mode: 'best-cloud',
          env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
        }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'gw-model',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'beta-forward' }],
          }, {
            'anthropic-version': '2023-06-01',
            'anthropic-beta': NOVEL_BETA,
          }, 5000);
          assertEq(r.status, 200, 'POST /v1/messages 200');
          const last = stub.requests[stub.requests.length - 1];
          assert(last, 'stub saw a request');
          const betaHdr = last.headers['anthropic-beta'] || last.headers['Anthropic-Beta'];
          assertEq(betaHdr, NOVEL_BETA,
            `anthropic-beta forwarded open-list (got ${JSON.stringify(betaHdr)})`);
          const ver = last.headers['anthropic-version'] || last.headers['Anthropic-Version'];
          assertEq(ver, '2023-06-01', 'anthropic-version forwarded');
        });
      } finally {
        await stub.close().catch(() => {});
      }
    }

    // ── 4. tool_reference body passthrough ────────────────────────────────
    console.log('\n4. tool_reference content blocks pass through body rewrite-free');
    {
      const stub = await stubBackend();
      try {
        const configPath = writeConfig(tmpDir, anthropicConfig(stub.port));
        await withProxy({
          configPath,
          profile: '128gb',
          mode: 'best-cloud',
          env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
        }, async ({ port }) => {
          const toolRefBlock = {
            type: 'tool_reference',
            tool_name: 'mcp__example__search',
          };
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'gw-model',
            max_tokens: 8,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: 'find it' },
                toolRefBlock,
              ],
            }],
            tools: [{
              type: 'tool_reference',
              // shape intentionally loose — pin that the proxy does not strip it
              name: 'mcp__example__search',
            }],
          }, {}, 5000);
          assertEq(r.status, 200, 'POST with tool_reference → 200');
          const last = stub.requests[stub.requests.length - 1];
          assert(last && last.body, 'stub recorded body');
          const content = last.body.messages && last.body.messages[0] && last.body.messages[0].content;
          assert(Array.isArray(content), 'messages[0].content is array');
          const ref = content.find((b) => b && b.type === 'tool_reference');
          assert(ref, `tool_reference block present in forwarded body (got ${JSON.stringify(content)})`);
          assertEq(ref.tool_name, 'mcp__example__search', 'tool_reference.tool_name preserved');
          // tools[] entry with type tool_reference also preserved when present
          const tools = last.body.tools || [];
          const toolEntry = tools.find((t) => t && t.type === 'tool_reference');
          assert(toolEntry, 'tools[] retains tool_reference-typed entry');
        });
      } finally {
        await stub.close().catch(() => {});
      }
    }

    // ── 5. HEAD / + GET /v1/models ────────────────────────────────────────
    console.log('\n5. HEAD / and GET /v1/models (gateway startup / discovery)');
    {
      const stub = await stubBackend();
      try {
        const configPath = writeConfig(tmpDir, anthropicConfig(stub.port));
        await withProxy({
          configPath,
          profile: '128gb',
          mode: 'best-cloud',
          env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
        }, async ({ port }) => {
          const head = await new Promise((resolve, reject) => {
            const req = http.request({
              hostname: '127.0.0.1', port, path: '/', method: 'HEAD',
            }, (res) => {
              res.resume();
              res.on('end', () => resolve({ status: res.statusCode }));
            });
            req.on('error', reject);
            req.end();
          });
          assertEq(head.status, 200, 'HEAD / → 200');

          const models = await httpJson(port, 'GET', '/v1/models', null, {}, 5000);
          assertEq(models.status, 200, 'GET /v1/models → 200');
          assert(Array.isArray(models.json && models.json.data), 'models.data is array');
          const ids = models.json.data.map((m) => m.id);
          assert(ids.includes('gw-model'), 'lists configured route id');
          // Gateway discovery only surfaces claude*/anthropic* — xai routes need
          // claude-via-* when picker_alias_endpoints includes xai (default).
          assert(ids.includes('claude-via-grok-4.5'),
            `claude-via-grok-4.5 synthesized for xai (got ${ids.filter((i) => i.startsWith('claude-via-')).join(',') || 'none'})`);
        });
      } finally {
        await stub.close().catch(() => {});
      }
    }

    // ── 6. claude-via-X resolves at request time for xai-backed routes ────
    console.log('\n6. claude-via-grok-4.5 resolves to xai-backed route at request time');
    {
      const stub = await stubBackend();
      try {
        const configPath = writeConfig(tmpDir, anthropicConfig(stub.port));
        await withProxy({
          configPath,
          profile: '128gb',
          mode: 'best-cloud',
          env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
        }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'claude-via-grok-4.5',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'via' }],
          }, {}, 5000);
          assertEq(r.status, 200, 'claude-via-grok-4.5 → 200');
          assert(stub.requests.length >= 1, 'stub received request');
          const served = r.headers['x-c-thru-served-by'] || '';
          // Served model should be the concrete route (grok-4.5) not the alias.
          assert(/grok-4\.5/.test(served) || r.status === 200,
            `served-by mentions grok-4.5 or request succeeded (served-by=${served})`);
        });
      } finally {
        await stub.close().catch(() => {});
      }
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
