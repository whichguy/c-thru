#!/usr/bin/env node
'use strict';
// Tests for Anthropic-to-Gemini translation in claude-proxy.
//
// Run: node test/proxy-gemini-translation.test.js

const fs   = require('fs');
const http = require('http');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');
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

console.log('proxy-gemini-translation tests\n');

const GEMINI_MODEL = 'gemini-3.1-pro';

function buildGeminiConfig(stubPort) {
  return {
    backends: {
      gemini_stub: { 
        format: 'gemini', 
        url: `http://127.0.0.1:${stubPort}`,
        auth: { literal: 'fake-gemini-key' }
      },
    },
    model_routes: { [GEMINI_MODEL]: 'gemini_stub' },
  };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-gemini-'));
  let stub;
  try {
    stub = await stubBackend();
    const configPath = writeConfig(tmpDir, buildGeminiConfig(stub.port));
    const env = { CLAUDE_LLM_MODE: 'connected' };

    // ── 1. Non-streaming Request Mapping ─────────────────────────────────────
    console.log('1. Non-streaming request mapping (Anthropic -> Gemini)');
    stub.setHandler((req, res) => {
      // Gemini expects POST /v1beta/models/{model}:generateContent
      if (req.url.includes(':generateContent')) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          const geminiReq = JSON.parse(body);
          
          // Verify mapping
          const systemPart = geminiReq.systemInstruction?.parts?.[0]?.text;
          const firstMsg = geminiReq.contents?.[0];
          
          if (systemPart === 'test system' && firstMsg?.role === 'user' && firstMsg?.parts?.[0]?.text === 'hello') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{
                content: { parts: [{ text: 'gemini reply' }] },
                finishReason: 'STOP'
              }],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10 }
            }));
          } else {
            res.writeHead(400);
            res.end('mapping failed');
          }
        });
        return true; // handled
      }
      return false;
    });

    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const anthropicReq = {
        model: GEMINI_MODEL,
        system: 'test system',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 100,
        stream: false
      };
      const r = await httpJson(port, 'POST', '/v1/messages', anthropicReq);
      assert(r.status === 200, 'status 200');
      assert(r.json?.content?.[0]?.text === 'gemini reply', 'received translated content');
      assert(r.json?.usage?.input_tokens === 5, 'usage input_tokens mapped');
      assert(r.json?.usage?.output_tokens === 10, 'usage output_tokens mapped');
      assert(stub.lastRequest()?.headers?.['x-goog-api-key'] === 'fake-gemini-key', 'auth header mapped to x-goog-api-key');
    });

    // ── 2. Tool Mapping ──────────────────────────────────────────────────────
    console.log('\n2. Tool mapping (Anthropic tool_use -> Gemini functionCall)');
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          const geminiReq = JSON.parse(body);
          const tool = geminiReq.tools?.[0]?.functionDeclarations?.[0];
          const call = geminiReq.contents?.[1]?.parts?.[0]?.functionCall;
          
          if (tool?.name === 'get_weather' && call?.name === 'get_weather' && call?.args?.city === 'London') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{
                content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'London' } } }] },
                finishReason: 'STOP'
              }]
            }));
          } else {
            res.writeHead(400);
            res.end('tool mapping failed');
          }
        });
        return true;
      }
      return false;
    });

    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const anthropicReq = {
        model: GEMINI_MODEL,
        messages: [
          { role: 'user', content: 'What is the weather in London?' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'get_weather', input: { city: 'London' } }] }
        ],
        tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
        stream: false
      };
      const r = await httpJson(port, 'POST', '/v1/messages', anthropicReq);
      assert(r.status === 200, 'tool status 200');
      assert(r.json?.content?.[0]?.type === 'tool_use', 'received tool_use block');
      assert(r.json?.content?.[0]?.name === 'get_weather', 'tool name matches');
    });

    // ── 3. Streaming Response Translation ────────────────────────────────────
    console.log('\n3. Streaming response translation (Gemini SSE -> Anthropic SSE)');
    stub.setHandler((req, res) => {
      if (req.url.includes(':streamGenerateContent')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'hello' }] } }]
        }) + '\n\n');
        res.write('data: ' + JSON.stringify({
          candidates: [{ content: { parts: [{ text: ' world' }] }, finishReason: 'STOP' }],
          usageMetadata: { candidatesTokenCount: 2 }
        }) + '\n\n');
        res.end();
        return true;
      }
      return false;
    });

    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const anthropicReq = {
        model: GEMINI_MODEL,
        messages: [{ role: 'user', content: 'say hello' }],
        stream: true
      };

      return new Promise((resolve) => {
        const req = http.request({
          port,
          method: 'POST',
          path: '/v1/messages',
          headers: { 'Content-Type': 'application/json' }
        }, (res) => {
          let events = [];
          let buffer = '';
          res.on('data', d => {
            buffer += d.toString();
            let lines = buffer.split('\n');
            buffer = lines.pop();
            for (let line of lines) {
              if (line.startsWith('data: ')) {
                events.push(JSON.parse(line.slice(6)));
              }
            }
          });
          res.on('end', () => {
            assert(events.some(e => e.type === 'message_start'), 'received message_start');
            const deltas = events.filter(e => e.type === 'content_block_delta');
            assert(deltas[0]?.delta?.text === 'hello', 'first delta correct');
            assert(deltas[1]?.delta?.text === ' world', 'second delta correct');
            assert(events.some(e => e.type === 'message_delta' && e.usage?.output_tokens === 2), 'received message_delta with usage');
            assert(events[events.length - 1].type === 'message_stop', 'received message_stop');
            resolve();
          });
        });
        req.write(JSON.stringify(anthropicReq));
        req.end();
      });
    });

    // ── 4. Thinking request mapping ─────────────────────────────────────────
    console.log('\n4. Thinking request mapping (Anthropic thinking -> Gemini thinkingConfig)');
    let captured4 = null;
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          captured4 = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
          }));
        });
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        thinking: { type: 'enabled', budget_tokens: 512 },
        messages: [{ role: 'user', content: 'reason about 2+2' }],
        max_tokens: 100,
        stream: false,
      });
      assert(r.status === 200, 'thinking req status 200');
      assert(captured4?.generationConfig?.thinkingConfig?.thinkingBudget === 512, 'thinkingBudget mapped to 512');
      assert(captured4?.generationConfig?.thinkingConfig?.includeThoughts === true, 'includeThoughts:true forwarded');
    });

    // ── 5. Thinking history echo ────────────────────────────────────────────
    console.log('\n5. Thinking history echo (assistant thinking block -> Gemini thought part)');
    let captured5 = null;
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          captured5 = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
          }));
        });
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        messages: [
          { role: 'user', content: 'q1' },
          { role: 'assistant', content: [
            { type: 'thinking', thinking: 'prior reasoning', signature: 'sig-abc' },
            { type: 'text', text: 'a1' },
          ] },
          { role: 'user', content: 'q2' },
        ],
        max_tokens: 100,
        stream: false,
      });
      assert(r.status === 200, 'history-echo status 200');
      const modelMsg = captured5?.contents?.find(c => c.role === 'model');
      const thoughtPart = modelMsg?.parts?.find(p => p.thought === true);
      assert(thoughtPart != null, 'history thought part emitted');
      assert(thoughtPart?.text === 'prior reasoning', 'thought part text preserved');
      assert(thoughtPart?.thoughtSignature === 'sig-abc', 'thought signature echoed back');
    });

    // ── 6. Non-streaming thinking response ──────────────────────────────────
    console.log('\n6. Non-streaming thinking response (thought parts -> thinking blocks first)');
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{
            content: { parts: [
              { text: 'analysing...', thought: true, thoughtSignature: 'sig-1' },
              { text: 'final answer' },
            ] },
            finishReason: 'STOP'
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
        }));
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        messages: [{ role: 'user', content: 'go' }],
        thinking: { type: 'enabled', budget_tokens: 256 },
        max_tokens: 100,
        stream: false,
      });
      assert(r.status === 200, 'thinking response status 200');
      assert(r.json?.content?.[0]?.type === 'thinking', 'first block is thinking');
      assert(r.json?.content?.[0]?.thinking === 'analysing...', 'thinking text preserved');
      assert(r.json?.content?.[0]?.signature === 'sig-1', 'thinking signature preserved');
      assert(r.json?.content?.[1]?.type === 'text', 'second block is text');
      assert(r.json?.content?.[1]?.text === 'final answer', 'text content preserved');
    });

    // ── 6b. Non-streaming: thoughtSignature on sibling part backfills thinking
    console.log('\n6b. Non-streaming: thoughtSignature on sibling part backfills thinking block (G6)');
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{
            content: { parts: [
              // Thought part has NO thoughtSignature; sibling text part carries it.
              { text: 'analysing...', thought: true },
              { text: 'final answer', thoughtSignature: 'sig-on-sibling' },
            ] },
            finishReason: 'STOP'
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
        }));
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        messages: [{ role: 'user', content: 'go' }],
        thinking: { type: 'enabled', budget_tokens: 256 },
        max_tokens: 100,
        stream: false,
      });
      assert(r.status === 200, '6b status 200');
      const tb = (r.json?.content || []).find(b => b.type === 'thinking');
      assert(tb?.signature === 'sig-on-sibling', `6b thinking signature backfilled from sibling (got '${tb?.signature}')`);
    });

    // ── 7. Streaming thinking response ──────────────────────────────────────
    console.log('\n7. Streaming thinking events (content_block_start/thinking_delta/signature_delta/stop)');
    stub.setHandler((req, res) => {
      if (req.url.includes(':streamGenerateContent')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'reasoning ', thought: true }] } }]
        }) + '\n\n');
        res.write('data: ' + JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'more', thought: true, thoughtSignature: 'sig-stream' }] } }]
        }) + '\n\n');
        res.write('data: ' + JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }],
          usageMetadata: { candidatesTokenCount: 3 }
        }) + '\n\n');
        res.end();
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      return new Promise((resolve) => {
        const req = http.request({
          port, method: 'POST', path: '/v1/messages',
          headers: { 'Content-Type': 'application/json' }
        }, (res) => {
          let events = [];
          let buffer = '';
          res.on('data', d => {
            buffer += d.toString();
            let lines = buffer.split('\n');
            buffer = lines.pop();
            for (let line of lines) {
              if (line.startsWith('event: ')) {
                events.push({ event: line.slice(7).trim() });
              } else if (line.startsWith('data: ')) {
                try {
                  const last = events[events.length - 1];
                  if (last) last.data = JSON.parse(line.slice(6));
                } catch {}
              }
            }
          });
          res.on('end', () => {
            const starts = events.filter(e => e.event === 'content_block_start');
            const deltas = events.filter(e => e.event === 'content_block_delta');
            const stops = events.filter(e => e.event === 'content_block_stop');
            const thinkingStart = starts.find(e => e.data?.content_block?.type === 'thinking');
            assert(thinkingStart != null, 'thinking content_block_start emitted');
            const thinkingDeltas = deltas.filter(e => e.data?.delta?.type === 'thinking_delta');
            assert(thinkingDeltas.length >= 2, 'thinking_delta events emitted (>=2)');
            const sigDelta = deltas.find(e => e.data?.delta?.type === 'signature_delta');
            assert(sigDelta != null, 'signature_delta emitted');
            assert(sigDelta?.data?.delta?.signature === 'sig-stream', 'signature_delta carries sig');
            // Ordering: signature_delta must precede the thinking block's stop
            const sigIdx = events.indexOf(sigDelta);
            const firstStop = events.indexOf(stops[0]);
            assert(sigIdx < firstStop, 'signature_delta precedes content_block_stop');
            // Thinking block index must precede text block index
            const textStart = starts.find(e => e.data?.content_block?.type === 'text');
            assert(textStart != null, 'text content_block_start emitted');
            assert(thinkingStart.data.index < textStart.data.index, 'thinking block index < text block index');
            resolve();
          });
        });
        req.write(JSON.stringify({
          model: GEMINI_MODEL,
          messages: [{ role: 'user', content: 'go' }],
          thinking: { type: 'enabled', budget_tokens: 256 },
          stream: true,
        }));
        req.end();
      });
    });

    // ── G5. tool_result.is_error -> functionResponse.response.error ─────────
    console.log('\nG5. tool_result.is_error=true -> Gemini functionResponse.response.error');
    let capturedG5 = null;
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          capturedG5 = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'retry?' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
          }));
        });
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        tools: [{ name: 'calc', description: 'd', input_schema: { type: 'object' } }],
        messages: [
          { role: 'user', content: 'compute' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_x', name: 'calc', input: { x: 1 } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_x', content: 'division by zero', is_error: true }] },
        ],
        stream: false,
      });
      const fr = capturedG5?.contents?.[2]?.parts?.[0]?.functionResponse;
      assert(fr?.name === 'calc', 'functionResponse.name resolved');
      assert(fr?.response?.error != null, `is_error=true wraps response under .error (got ${JSON.stringify(fr?.response)})`);
      assert(fr?.response?.error?.content === 'division by zero', `error payload preserved (got ${JSON.stringify(fr?.response?.error)})`);
    });

    // ── 8. Image content blocks (Anthropic image -> Gemini inlineData) ──────
    console.log('\n8. Image content block mapping (base64 -> inlineData / url -> fileData)');
    let captured8 = null;
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          captured8 = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'red square' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
          }));
        });
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      // 1x1 red PNG (base64). Tiny but valid.
      const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What color?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: tinyPng } },
          ],
        }],
        stream: false,
      });
      const parts = captured8?.contents?.[0]?.parts || [];
      assert(parts.length === 2, `2 parts mapped (got ${parts.length})`);
      assert(parts[0]?.text === 'What color?', 'text part preserved');
      assert(parts[1]?.inlineData?.mimeType === 'image/png', 'image -> inlineData.mimeType');
      assert(parts[1]?.inlineData?.data === tinyPng, 'image base64 data preserved');
    });

    // ── 8b. Image url source -> fileData ─────────────────────────────────────
    console.log('\n8b. Image url source -> fileData{fileUri}');
    let captured8b = null;
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          captured8b = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
          }));
        });
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        messages: [{
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/x.jpg', media_type: 'image/jpeg' } }],
        }],
        stream: false,
      });
      const parts = captured8b?.contents?.[0]?.parts || [];
      assert(parts[0]?.fileData?.fileUri === 'https://example.com/x.jpg', 'image url -> fileData.fileUri');
      assert(parts[0]?.fileData?.mimeType === 'image/jpeg', 'fileData.mimeType set');
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
