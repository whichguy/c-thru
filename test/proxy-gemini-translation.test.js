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
  stubBackend, writeConfig, writeConfigFresh, httpJson, withProxy,
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
      // Gemini 3 family uses thinkingLevel (not thinkingBudget); budget_tokens=512 → 'low'.
      assert(captured4?.generationConfig?.thinkingConfig?.thinkingLevel === 'low', `thinkingLevel='low' for budget 512 (got ${captured4?.generationConfig?.thinkingConfig?.thinkingLevel})`);
      assert(captured4?.generationConfig?.thinkingConfig?.thinkingBudget === undefined, 'thinkingBudget NOT sent on Gemini 3 (would 400 if mixed)');
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

    // ── 9. Document content blocks (PDF base64 -> inlineData) ──────────────
    console.log('\n9. Document block (PDF base64) -> Gemini inlineData with application/pdf');
    let captured9 = null;
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          captured9 = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'document received' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
          }));
        });
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      // Minimal valid PDF header (base64). Just enough bytes to roundtrip.
      const tinyPdf = Buffer.from('%PDF-1.4\n%fakeminimal\n').toString('base64');
      await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Summarize this PDF.' },
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: tinyPdf } },
          ],
        }],
        stream: false,
      });
      const parts = captured9?.contents?.[0]?.parts || [];
      assert(parts.length === 2, `2 parts mapped (got ${parts.length})`);
      assert(parts[1]?.inlineData?.mimeType === 'application/pdf', `document -> inlineData.mimeType=application/pdf (got '${parts[1]?.inlineData?.mimeType}')`);
      assert(parts[1]?.inlineData?.data === tinyPdf, 'document base64 data preserved');
    });

    // ── G4. Lazy fire-and-forget context caching (miss -> create -> hit) ────
    console.log('\nG4. Context caching: turn 1 miss + create, turn 2 hit with prefix stripped');
    const generateRequests = [];
    let cacheCreatePayload = null;
    stub.setHandler((req, res) => {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        if (req.url.includes('/v1beta/cachedContents') && req.method === 'POST') {
          cacheCreatePayload = parsed;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            name: 'cachedContents/abc123',
            model: `models/${GEMINI_MODEL}`,
            expireTime: new Date(Date.now() + 300000).toISOString(),
          }));
          return;
        }
        if (req.url.includes(':generateContent')) {
          generateRequests.push(parsed);
          const turn = generateRequests.length;
          // Turn 2+ (cachedContent attached): surface cachedContentTokenCount.
          const usage = (turn >= 2 && parsed && parsed.cachedContent)
            ? { promptTokenCount: 100, candidatesTokenCount: 5, cachedContentTokenCount: 95 }
            : { promptTokenCount: 100, candidatesTokenCount: 5 };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: `t${turn}` }] }, finishReason: 'STOP' }],
            usageMetadata: usage,
          }));
          return;
        }
        res.writeHead(404); res.end();
      });
      return true;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const longSystem = 'You are a helpful assistant. ' + 'x'.repeat(2000);
      const reqBody = {
        model: GEMINI_MODEL,
        system: [{ type: 'text', text: longSystem, cache_control: { type: 'ephemeral', ttl: '5m' } }],
        messages: [{ role: 'user', content: 'q1' }],
        max_tokens: 100,
        stream: false,
      };

      // Turn 1
      const r1 = await httpJson(port, 'POST', '/v1/messages', reqBody);
      assert(r1.status === 200, 'G4 turn1 status 200');
      assert(r1.headers?.['x-c-thru-cache-status'] === 'miss', `G4 turn1 cache-status=miss (got '${r1.headers?.['x-c-thru-cache-status']}')`);
      assert(generateRequests[0]?.cachedContent === undefined, 'G4 turn1 outbound has no cachedContent');

      // Wait for fire-and-forget cache create to land (poll up to 1s).
      const deadline = Date.now() + 1000;
      while (cacheCreatePayload === null && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20));
      }
      assert(cacheCreatePayload !== null, 'G4 cache create POST received');
      assert(cacheCreatePayload?.ttl === '300s', `G4 cache ttl '5m' translated to '300s' (got '${cacheCreatePayload?.ttl}')`);

      // Turn 2 — same prefix, expect hit.
      const r2 = await httpJson(port, 'POST', '/v1/messages', reqBody);
      assert(r2.status === 200, 'G4 turn2 status 200');
      assert(r2.headers?.['x-c-thru-cache-status'] === 'hit', `G4 turn2 cache-status=hit (got '${r2.headers?.['x-c-thru-cache-status']}')`);
      assert(generateRequests[1]?.cachedContent === 'cachedContents/abc123', `G4 turn2 cachedContent ref attached (got '${generateRequests[1]?.cachedContent}')`);
      assert(generateRequests[1]?.systemInstruction === undefined, 'G4 turn2 systemInstruction stripped (cached)');
      assert(r2.json?.usage?.cache_read_input_tokens === 95, `G4 cache_read_input_tokens=95 (got ${r2.json?.usage?.cache_read_input_tokens})`);
      assert(r2.json?.usage?.cache_creation_input_tokens === 0, 'G4 cache_creation_input_tokens=0');

      // /ping observability: counters reflect the two turns + create.
      const ping = await httpJson(port, 'GET', '/ping');
      assert(ping.status === 200, 'G4 /ping status 200');
      const gc = ping.json?.gemini_cache;
      assert(gc != null, 'G4 /ping has gemini_cache field');
      assert(gc?.miss >= 1, `G4 /ping miss >= 1 (got ${gc?.miss})`);
      assert(gc?.hit >= 1, `G4 /ping hit >= 1 (got ${gc?.hit})`);
      assert(gc?.created >= 1, `G4 /ping created >= 1 (got ${gc?.created})`);
      assert(gc?.entries >= 1, `G4 /ping entries >= 1 (got ${gc?.entries})`);
    });

    // ── 11. Wave 1: Client disconnect tears down upstream Gemini ─────────────
    // When the Claude Code client closes mid-stream, the proxy must destroy
    // the upstream HTTPS request to Gemini. Otherwise Gemini keeps generating
    // (and billing for) tokens no client will read.
    console.log('\n11. Wave 1: client disconnect cancels upstream Gemini stream');
    const closeStub = http.createServer((sreq, sres) => {
      // Record when this upstream request socket closes.
      sreq.on('close', () => { sreq._closedAt = Date.now(); closedAt = sreq._closedAt; });
      if (sreq.url.includes(':streamGenerateContent')) {
        sres.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        // Emit one chunk then sleep — never end.
        sres.write(`data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'hi' }] } }]
        })}\n\n`);
        // Hold the connection open for 30s. Cleared when proxy disconnects.
        sreq._holdTimer = setTimeout(() => { try { sres.end(); } catch {} }, 30000);
        sreq.on('close', () => { try { clearTimeout(sreq._holdTimer); } catch {} });
        return;
      }
      sres.writeHead(200, { 'Content-Type': 'application/json' });
      sres.end('{}');
    });
    let closedAt = 0;
    await new Promise(r => closeStub.listen(0, '127.0.0.1', r));
    const closeStubPort = closeStub.address().port;
    const closeConfigPath = writeConfig(
      fs.mkdtempSync(path.join(tmpDir, 'wave1-')),
      buildGeminiConfig(closeStubPort)
    );
    try {
      await withProxy({ configPath: closeConfigPath, profile: '16gb', env }, async ({ port }) => {
        // Issue a streaming request and abort after first byte (~50ms).
        const t0 = Date.now();
        await new Promise((resolve) => {
          const reqBody = JSON.stringify({
            model: GEMINI_MODEL,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 10,
            stream: true,
          });
          const cReq = http.request({
            hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
          }, (cRes) => {
            cRes.on('data', () => {
              // Got first byte — abort the client connection.
              cReq.destroy();
              resolve();
            });
            cRes.on('end', resolve);
            cRes.on('error', resolve);
          });
          cReq.on('error', resolve);
          cReq.write(reqBody);
          cReq.end();
        });
        // Poll up to 1s for the upstream stub to observe the close.
        const deadline = Date.now() + 1000;
        while (!closedAt && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 20));
        }
        const elapsed = closedAt ? closedAt - t0 : -1;
        assert(closedAt > 0, `upstream socket closed after client disconnect (elapsed=${elapsed}ms)`);
        assert(closedAt > 0 && elapsed < 1500, `upstream closed within 1.5s of client (got ${elapsed}ms)`);
      });
    } finally {
      await new Promise(r => closeStub.close(r));
    }

    // ── 12. Wave 2: Gemini gRPC status -> Anthropic error type mapping ────────
    console.log('\n12. Wave 2: gRPC status -> Anthropic error type mapping');
    const errCases = [
      { statusCode: 400, status: 'RESOURCE_EXHAUSTED', expectType: 'rate_limit_error' },
      { statusCode: 403, status: 'PERMISSION_DENIED',  expectType: 'permission_error' },
      { statusCode: 401, status: 'UNAUTHENTICATED',    expectType: 'authentication_error' },
      { statusCode: 400, status: 'INVALID_ARGUMENT',   expectType: 'invalid_request_error' },
      { statusCode: 503, status: 'UNAVAILABLE',        expectType: 'overloaded_error' },
    ];
    for (const tc of errCases) {
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          res.writeHead(tc.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { code: tc.statusCode, status: tc.status, message: 'simulated' },
          }));
          return true;
        }
        return false;
      });
      await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: GEMINI_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 10,
          stream: false,
        });
        assert(r.json?.error?.type === tc.expectType,
          `${tc.status} (HTTP ${tc.statusCode}) -> ${tc.expectType} (got ${r.json?.error?.type})`);
      });
    }

    // 12b. Unparseable body falls through to status-code mapping.
    console.log('\n12b. Wave 2: unparseable body falls through to status-code mapping');
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('this is not json at all');
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
        stream: false,
      });
      assert(r.json?.error?.type === 'rate_limit_error',
        `unparseable 429 -> rate_limit_error via status-code fallback (got ${r.json?.error?.type})`);
    });

    // 12c. Retry-After header round-trips; 429 synthesizes ratelimit-remaining=0.
    console.log('\n12c. Wave 2: Retry-After + ratelimit-requests-remaining propagation');
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
        res.end(JSON.stringify({
          error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' },
        }));
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
        stream: false,
      });
      assert(r.headers?.['retry-after'] === '30',
        `Retry-After=30 propagated (got '${r.headers?.['retry-after']}')`);
      assert(r.headers?.['anthropic-ratelimit-requests-remaining'] === '0',
        `anthropic-ratelimit-requests-remaining=0 synthesized (got '${r.headers?.['anthropic-ratelimit-requests-remaining']}')`);
    });

    // ── 13. Wave 3: Vertex cache create uses regional URL, not /v1beta/ ──────
    console.log('\n13. Wave 3: Vertex G4 cache create -> /v1/projects/{p}/locations/{l}/cachedContents');
    let vertexCachePath = null;
    let vertexGenerateRequests = [];
    stub.setHandler((req, res) => {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        if (req.url.includes('/cachedContents') && req.method === 'POST') {
          vertexCachePath = req.url;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            name: 'projects/test-proj/locations/us-central1/cachedContents/vx9',
            model: `models/${GEMINI_MODEL}`,
            expireTime: new Date(Date.now() + 300000).toISOString(),
          }));
          return;
        }
        if (req.url.includes(':generateContent')) {
          vertexGenerateRequests.push(parsed);
          const turn = vertexGenerateRequests.length;
          const usage = (turn >= 2 && parsed && parsed.cachedContent)
            ? { promptTokenCount: 100, candidatesTokenCount: 5, cachedContentTokenCount: 95 }
            : { promptTokenCount: 100, candidatesTokenCount: 5 };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: `vt${turn}` }] }, finishReason: 'STOP' }],
            usageMetadata: usage,
          }));
          return;
        }
        res.writeHead(404); res.end();
      });
      return true;
    });
    const vertexConfig = {
      backends: {
        gemini_vertex_stub: {
          format: 'gemini',
          vertex: true,
          url: `http://127.0.0.1:${stub.port}/v1/projects/test-proj/locations/us-central1/publishers/google/models`,
          auth: { literal: 'fake-vertex-token' },
        },
      },
      model_routes: { [GEMINI_MODEL]: 'gemini_vertex_stub' },
    };
    const vertexConfigPath = writeConfig(
      fs.mkdtempSync(path.join(tmpDir, 'wave3-')),
      vertexConfig,
    );
    await withProxy({ configPath: vertexConfigPath, profile: '16gb', env }, async ({ port }) => {
      const longSystem = 'You are a helpful assistant. ' + 'y'.repeat(2000);
      const reqBody = {
        model: GEMINI_MODEL,
        system: [{ type: 'text', text: longSystem, cache_control: { type: 'ephemeral', ttl: '5m' } }],
        messages: [{ role: 'user', content: 'q1' }],
        max_tokens: 100,
        stream: false,
      };
      // Turn 1 — miss + create.
      const r1 = await httpJson(port, 'POST', '/v1/messages', reqBody);
      assert(r1.status === 200, 'Vertex G4 turn1 status 200');
      assert(r1.headers?.['x-c-thru-cache-status'] === 'miss',
        `Vertex G4 turn1 cache-status=miss (got '${r1.headers?.['x-c-thru-cache-status']}')`);
      // Wait for fire-and-forget cache create.
      const deadline = Date.now() + 1000;
      while (vertexCachePath === null && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20));
      }
      assert(vertexCachePath === '/v1/projects/test-proj/locations/us-central1/cachedContents',
        `Vertex cache create URL (got '${vertexCachePath}')`);
      // Turn 2 — hit, cachedContent attached.
      const r2 = await httpJson(port, 'POST', '/v1/messages', reqBody);
      assert(r2.headers?.['x-c-thru-cache-status'] === 'hit',
        `Vertex G4 turn2 cache-status=hit (got '${r2.headers?.['x-c-thru-cache-status']}')`);
      assert(vertexGenerateRequests[1]?.cachedContent === 'projects/test-proj/locations/us-central1/cachedContents/vx9',
        `Vertex turn2 cachedContent ref (got '${vertexGenerateRequests[1]?.cachedContent}')`);
    });

    // 13b. Vertex countTokens URL has no /v1beta/ prefix.
    console.log('\n13b. Wave 3: Vertex :countTokens URL preserves regional prefix');
    let vertexCountPath = null;
    stub.setHandler((req, res) => {
      if (req.url.includes(':countTokens')) {
        vertexCountPath = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalTokens: 42 }));
        return true;
      }
      return false;
    });
    await withProxy({ configPath: vertexConfigPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages/count_tokens', {
        model: GEMINI_MODEL,
        messages: [{ role: 'user', content: 'count me' }],
      });
      assert(r.status === 200, `Vertex countTokens status 200 (got ${r.status})`);
      assert(r.json?.input_tokens === 42, `Vertex countTokens result mapped (got ${r.json?.input_tokens})`);
      assert(vertexCountPath?.startsWith('/v1/projects/test-proj/'),
        `Vertex countTokens path has regional prefix (got '${vertexCountPath}')`);
      assert(!vertexCountPath?.includes('/v1beta/'),
        `Vertex countTokens path has no /v1beta/ (got '${vertexCountPath}')`);
      assert(vertexCountPath?.endsWith(':countTokens'),
        `Vertex countTokens path ends with :countTokens (got '${vertexCountPath}')`);
    });

    // ── 14. Wave 4: metadata.user_id propagated as x-c-thru-user-id header ───
    // Pure passthrough: request body to Gemini is unchanged; only the response
    // header is added so journals + downstream telemetry can attribute calls.
    console.log('\n14. Wave 4: metadata.user_id -> x-c-thru-user-id response header');
    let userIdGeneratePayload = null;
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try { userIdGeneratePayload = JSON.parse(body); } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }));
        });
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
        stream: false,
        metadata: { user_id: 'u123' },
      });
      assert(r.status === 200, `Wave 4 status 200 (got ${r.status})`);
      assert(r.headers?.['x-c-thru-user-id'] === 'u123',
        `x-c-thru-user-id=u123 (got '${r.headers?.['x-c-thru-user-id']}')`);
      assert(userIdGeneratePayload && userIdGeneratePayload.metadata === undefined,
        `Gemini request body has no metadata field (transparent passthrough)`);
    });

    // 14b. Absent metadata.user_id -> header absent (no spurious empty value).
    console.log('\n14b. Wave 4: no metadata.user_id -> no x-c-thru-user-id header');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
        stream: false,
      });
      assert(r.status === 200, `14b status 200 (got ${r.status})`);
      assert(r.headers?.['x-c-thru-user-id'] === undefined,
        `x-c-thru-user-id absent (got '${r.headers?.['x-c-thru-user-id']}')`);
    });

    // ── 15. Wave 4: redacted_thinking -> dropped + observability header ──────
    // Gemini cannot decrypt Anthropic-encrypted opaque blobs and would 400 if
    // forwarded. Drop is surgical: adjacent text blocks still flow through.
    console.log('\n15. Wave 4: redacted_thinking dropped + x-c-thru-redacted-thinking-dropped header');
    let redactedGeneratePayload = null;
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try { redactedGeneratePayload = JSON.parse(body); } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }));
        });
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        messages: [{
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'ENCRYPTED_BLOB_OPAQUE' },
            { type: 'text', text: 'visible reply' },
          ],
        }, {
          role: 'user',
          content: 'continue',
        }],
        max_tokens: 10,
        stream: false,
      });
      assert(r.status === 200, `15 status 200 (got ${r.status})`);
      assert(r.headers?.['x-c-thru-redacted-thinking-dropped'] === '1',
        `x-c-thru-redacted-thinking-dropped=1 (got '${r.headers?.['x-c-thru-redacted-thinking-dropped']}')`);
      const payloadStr = JSON.stringify(redactedGeneratePayload || {});
      assert(!payloadStr.includes('ENCRYPTED_BLOB_OPAQUE'),
        `encrypted blob not forwarded to Gemini`);
      const modelMsg = redactedGeneratePayload?.contents?.find(c => c.role === 'model');
      assert(modelMsg && Array.isArray(modelMsg.parts),
        `model message present in upstream payload`);
      assert(modelMsg.parts.some(p => p.text === 'visible reply'),
        `adjacent text block still forwarded (drop is surgical)`);
    });

    // ── 16. x-c-thru-resolution-chain on a route(model->backend) hop ─────────
    // GEMINI_MODEL is registered as `model_routes[GEMINI_MODEL] = "gemini_stub"`,
    // so the chain should read `req:<model> -> route(<model>->gemini_stub)`.
    console.log('\n16. x-c-thru-resolution-chain emits route hop');
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }));
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
        stream: false,
      });
      assert(r.status === 200, `16 status 200 (got ${r.status})`);
      const ch = r.headers?.['x-c-thru-resolution-chain'];
      assert(typeof ch === 'string' && ch.length > 0,
        `x-c-thru-resolution-chain present (got '${ch}')`);
      assert(ch.startsWith(`req:${GEMINI_MODEL}`),
        `chain starts with req:${GEMINI_MODEL} (got '${ch}')`);
      assert(ch.includes(`route(${GEMINI_MODEL}->gemini_stub)`),
        `chain contains route hop to gemini_stub (got '${ch}')`);
      // served-by is unchanged: still the resolved concrete model name.
      assert(r.headers?.['x-c-thru-served-by'] === GEMINI_MODEL,
        `x-c-thru-served-by=${GEMINI_MODEL} unchanged (got '${r.headers?.['x-c-thru-served-by']}')`);
    });

    // 16b. v2 alias (endpoint+name) -> chain emits alias hop with both fields.
    // writeConfigFresh: v2-alias config goes in a sibling dir so it doesn't
    // overwrite the original configPath that 15b still depends on.
    console.log('\n16b. x-c-thru-resolution-chain emits alias hop for v2 alias');
    const aliasConfigPath = writeConfigFresh(tmpDir, 'alias', {
      backends: {
        gemini_stub: {
          format: 'gemini',
          url: `http://127.0.0.1:${stub.port}`,
          auth: { literal: 'fake-gemini-key' },
        },
      },
      model_routes: {
        'gemini-pro-shortcut': { endpoint: 'gemini_stub', name: GEMINI_MODEL },
      },
    });
    await withProxy({ configPath: aliasConfigPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: 'gemini-pro-shortcut',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
        stream: false,
      });
      assert(r.status === 200, `16b status 200 (got ${r.status})`);
      const ch = r.headers?.['x-c-thru-resolution-chain'];
      assert(typeof ch === 'string' && ch.includes(`alias(gemini-pro-shortcut->gemini_stub/${GEMINI_MODEL})`),
        `chain contains alias hop (got '${ch}')`);
      // served-by is the RESOLVED concrete name, not the alias.
      assert(r.headers?.['x-c-thru-served-by'] === GEMINI_MODEL,
        `x-c-thru-served-by=${GEMINI_MODEL} resolved (got '${r.headers?.['x-c-thru-served-by']}')`);
    });

    // ── 17. thoughtsTokenCount -> x-c-thru-thinking-tokens header ─────────
    console.log('\n17. thoughtsTokenCount -> x-c-thru-thinking-tokens header');
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, thoughtsTokenCount: 42 },
        }));
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        thinking: { type: 'enabled', budget_tokens: 256 },
        messages: [{ role: 'user', content: 'go' }],
        max_tokens: 100,
        stream: false,
      });
      assert(r.status === 200, `17 status 200 (got ${r.status})`);
      assert(r.headers?.['x-c-thru-thinking-tokens'] === '42',
        `x-c-thru-thinking-tokens=42 (got '${r.headers?.['x-c-thru-thinking-tokens']}')`);
    });

    // ── 18. Budget arithmetic: max_tokens + thinkingBudget ────────────────
    console.log('\n18. Budget arithmetic — maxOutputTokens = max_tokens + thinkingBudget');
    let captured18 = null;
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          captured18 = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }));
        });
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        thinking: { type: 'enabled', budget_tokens: 500 },
        messages: [{ role: 'user', content: 'go' }],
        max_tokens: 200,
        stream: false,
      });
      assert(r.status === 200, `18 status 200 (got ${r.status})`);
      // Gemini 3 family: budget_tokens=500 → thinkingLevel='low' (≤2048).
      // approx budget for 'low' = 2048; maxOutputTokens=200+2048=2248.
      assert(captured18?.generationConfig?.maxOutputTokens === 2248,
        `maxOutputTokens=2248 (200+approxLow) (got ${captured18?.generationConfig?.maxOutputTokens})`);
      assert(captured18?.generationConfig?.thinkingConfig?.thinkingLevel === 'low',
        `thinkingLevel='low' for budget 500 (got ${captured18?.generationConfig?.thinkingConfig?.thinkingLevel})`);
      assert(captured18?.generationConfig?.thinkingConfig?.thinkingBudget === undefined,
        `thinkingBudget NOT sent (would 400 if mixed with thinkingLevel) (got ${captured18?.generationConfig?.thinkingConfig?.thinkingBudget})`);
      assert(r.headers?.['x-c-thru-thinking-budget-added'] === '2048',
        `x-c-thru-thinking-budget-added=2048 (approxLow) (got '${r.headers?.['x-c-thru-thinking-budget-added']}')`);
      assert(r.headers?.['x-c-thru-thinking-level'] === 'low',
        `x-c-thru-thinking-level=low (got '${r.headers?.['x-c-thru-thinking-level']}')`);
    });

    // ── 19. Auto-enable thinking on Gemini 3 Pro ──────────────────────────
    console.log('\n19. Auto-enable thinking on Gemini 3 Pro');
    {
      const proConfigPath = writeConfigFresh(tmpDir, 'autopro', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: {
          'gemini-pro-latest': 'gemini_stub',
          'gemini-flash-latest': 'gemini_stub',
        },
      });
      let captured19 = null;
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            captured19 = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }));
          });
          return true;
        }
        return false;
      });
      await withProxy({ configPath: proConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-pro-latest',
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 100,
          stream: false,
        });
        assert(r.status === 200, `19 status 200 (got ${r.status})`);
        // Auto-enable on Gemini 3 family → thinkingLevel='low' (default).
        assert(captured19?.generationConfig?.thinkingConfig?.thinkingLevel === 'low',
          `auto-enabled thinkingLevel='low' (got ${captured19?.generationConfig?.thinkingConfig?.thinkingLevel})`);
        assert(captured19?.generationConfig?.thinkingConfig?.thinkingBudget === undefined,
          `auto-enable does NOT send legacy thinkingBudget (got ${captured19?.generationConfig?.thinkingConfig?.thinkingBudget})`);
        assert(r.headers?.['x-c-thru-thinking-auto-enabled'] === '1',
          `x-c-thru-thinking-auto-enabled=1 (got '${r.headers?.['x-c-thru-thinking-auto-enabled']}')`);
      });

      // Negative: gemini-flash-latest is not Gemini 3 Pro -> no auto-enable.
      let captured19b = null;
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            captured19b = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }));
          });
          return true;
        }
        return false;
      });
      await withProxy({ configPath: proConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-flash-latest',
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 100,
          stream: false,
        });
        assert(r.status === 200, `19 (flash) status 200 (got ${r.status})`);
        assert(captured19b?.generationConfig?.thinkingConfig === undefined,
          `flash: no auto-enable thinkingConfig (got ${JSON.stringify(captured19b?.generationConfig?.thinkingConfig)})`);
        assert(r.headers?.['x-c-thru-thinking-auto-enabled'] === undefined,
          `flash: x-c-thru-thinking-auto-enabled absent (got '${r.headers?.['x-c-thru-thinking-auto-enabled']}')`);
      });
    }

    // ── 19b. Explicit opt-out: thinking:{type:'disabled'} on Gemini 3 Pro ──
    console.log('\n19b. Explicit thinking:{type:"disabled"} opts out of auto-enable');
    {
      const proConfigPath = writeConfigFresh(tmpDir, 'autopro_off', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { 'gemini-pro-latest': 'gemini_stub' },
      });
      let captured = null;
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            captured = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }));
          });
          return true;
        }
        return false;
      });
      await withProxy({ configPath: proConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-pro-latest',
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 100,
          stream: false,
        });
        assert(r.status === 200, `19b status 200 (got ${r.status})`);
        assert(captured?.generationConfig?.thinkingConfig === undefined,
          `opt-out: no thinkingConfig (got ${JSON.stringify(captured?.generationConfig?.thinkingConfig)})`);
        assert(r.headers?.['x-c-thru-thinking-auto-enabled'] === undefined,
          `opt-out: x-c-thru-thinking-auto-enabled absent (got '${r.headers?.['x-c-thru-thinking-auto-enabled']}')`);
      });
    }

    // ── 17b. output_tokens parity: includes thoughtsTokenCount ────────────
    console.log('\n17b. output_tokens parity — includes thoughtsTokenCount (Anthropic semantics)');
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, thoughtsTokenCount: 42 },
        }));
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        thinking: { type: 'enabled', budget_tokens: 256 },
        messages: [{ role: 'user', content: 'go' }],
        max_tokens: 100,
        stream: false,
      });
      assert(r.status === 200, `17b status 200 (got ${r.status})`);
      assert(r.json?.usage?.output_tokens === 52,
        `output_tokens=52 (10 visible + 42 thinking) (got ${r.json?.usage?.output_tokens})`);
      assert(r.json?.usage?.input_tokens === 5,
        `input_tokens=5 unaffected (got ${r.json?.usage?.input_tokens})`);
    });

    // ── 19c. Regex precision: gemini-3-flash-preview must NOT auto-enable ──
    console.log('\n19c. Regex precision — gemini-3-flash-preview is not Gemini 3 Pro');
    {
      const flashConfigPath = writeConfigFresh(tmpDir, 'flash3', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { 'gemini-3-flash-preview': 'gemini_stub' },
      });
      let captured = null;
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            captured = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }));
          });
          return true;
        }
        return false;
      });
      await withProxy({ configPath: flashConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-3-flash-preview',
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 100,
          stream: false,
        });
        assert(r.status === 200, `19c status 200 (got ${r.status})`);
        assert(captured?.generationConfig?.thinkingConfig === undefined,
          `gemini-3-flash-preview: no auto-enable (got ${JSON.stringify(captured?.generationConfig?.thinkingConfig)})`);
        assert(r.headers?.['x-c-thru-thinking-auto-enabled'] === undefined,
          `gemini-3-flash-preview: header absent (got '${r.headers?.['x-c-thru-thinking-auto-enabled']}')`);
      });

      // Positive: gemini-3.1-pro-preview DOES match.
      const proConfigPath = writeConfigFresh(tmpDir, 'pro31', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { 'gemini-3.1-pro-preview': 'gemini_stub' },
      });
      let captured2 = null;
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            captured2 = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }));
          });
          return true;
        }
        return false;
      });
      await withProxy({ configPath: proConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-3.1-pro-preview',
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 100,
          stream: false,
        });
        assert(r.status === 200, `19c (pro) status 200 (got ${r.status})`);
        assert(captured2?.generationConfig?.thinkingConfig?.thinkingLevel === 'low',
          `gemini-3.1-pro-preview auto-enables thinkingLevel='low' (got ${captured2?.generationConfig?.thinkingConfig?.thinkingLevel})`);
        assert(r.headers?.['x-c-thru-thinking-auto-enabled'] === '1',
          `gemini-3.1-pro-preview header set (got '${r.headers?.['x-c-thru-thinking-auto-enabled']}')`);
      });
    }

    // ── 20. Streaming: thoughtsTokenCount surfaces in message_delta usage ─
    console.log('\n20. Streaming — thoughtsTokenCount in message_delta.usage (header not possible mid-stream)');
    stub.setHandler((req, res) => {
      if (req.url.includes(':streamGenerateContent')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // Final SSE chunk includes finishReason + usageMetadata with thoughtsTokenCount.
        res.write('data: ' + JSON.stringify({
          candidates: [{
            content: { parts: [{ text: 'final' }] },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 12, thoughtsTokenCount: 33 },
        }) + '\n\n');
        res.end();
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      // Use raw http to read the SSE stream
      const sseBody = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          let buf = '';
          res.on('data', d => buf += d);
          res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        });
        req.on('error', reject);
        req.write(JSON.stringify({
          model: GEMINI_MODEL,
          thinking: { type: 'enabled', budget_tokens: 256 },
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 100,
          stream: true,
        }));
        req.end();
      });
      assert(sseBody.status === 200, `20 status 200 (got ${sseBody.status})`);
      const deltaMatch = sseBody.body.match(/event:\s*message_delta\s*\ndata:\s*(\{[^\n]+\})/);
      assert(deltaMatch != null, 'message_delta event present');
      let delta = null;
      try { delta = JSON.parse(deltaMatch[1]); } catch {}
      assert(delta?.usage?.output_tokens === 45,
        `streaming output_tokens=45 (12+33) (got ${delta?.usage?.output_tokens})`);
      // Custom c-thru-thinking-tokens event precedes message_delta. Anthropic's
      // usage object stays spec-compliant (output_tokens only).
      assert(delta?.usage?.thinking_output_tokens === undefined,
        `message_delta.usage stays spec-compliant — no thinking_output_tokens (got ${delta?.usage?.thinking_output_tokens})`);
      const cthruEvtMatch = sseBody.body.match(/event:\s*c-thru-thinking-tokens\s*\ndata:\s*(\{[^\n]+\})/);
      assert(cthruEvtMatch != null, 'c-thru-thinking-tokens event present');
      let evt = null;
      try { evt = JSON.parse(cthruEvtMatch[1]); } catch {}
      assert(evt?.thinking_tokens === 33,
        `c-thru-thinking-tokens event carries 33 (got ${evt?.thinking_tokens})`);
      // Ordering: custom event must precede message_delta so clients see the
      // signal as part of the same logical "stream end" cluster.
      const cthruIdx = sseBody.body.indexOf('event: c-thru-thinking-tokens');
      const deltaIdx = sseBody.body.indexOf('event: message_delta');
      assert(cthruIdx >= 0 && deltaIdx > cthruIdx,
        `c-thru-thinking-tokens precedes message_delta (cthru=${cthruIdx}, delta=${deltaIdx})`);
    });

    // ── 20b. Streaming: auto-enable + budget-added headers at writeHead ───
    console.log('\n20b. Streaming — auto-enable + budget-added headers flushed at writeHead');
    {
      const proConfigPath = writeConfigFresh(tmpDir, 'streamhead', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { 'gemini-pro-latest': 'gemini_stub' },
      });
      stub.setHandler((req, res) => {
        if (req.url.includes(':streamGenerateContent')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }) + '\n\n');
          res.end();
          return true;
        }
        return false;
      });
      await withProxy({ configPath: proConfigPath, profile: '16gb', env }, async ({ port }) => {
        const headers = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
          });
          req.on('error', reject);
          req.write(JSON.stringify({
            model: 'gemini-pro-latest',
            messages: [{ role: 'user', content: 'go' }],
            max_tokens: 200,
            stream: true,
          }));
          req.end();
        });
        assert(headers.status === 200, `20b status 200 (got ${headers.status})`);
        assert(headers.headers['x-c-thru-thinking-auto-enabled'] === '1',
          `streaming x-c-thru-thinking-auto-enabled=1 (got '${headers.headers['x-c-thru-thinking-auto-enabled']}')`);
        assert(headers.headers['x-c-thru-thinking-budget-added'] === '2048',
          `streaming x-c-thru-thinking-budget-added=2048 (approxLow) (got '${headers.headers['x-c-thru-thinking-budget-added']}')`);
      });
    }

    // ── 20c. thoughtsTokenCount absent → no thinking-tokens header noise ──
    console.log('\n20c. thoughtsTokenCount absent (Gemini LOW-thinking bug) — header omitted, output_tokens clean');
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10 },  // no thoughtsTokenCount
        }));
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        thinking: { type: 'enabled', budget_tokens: 256 },
        messages: [{ role: 'user', content: 'go' }],
        max_tokens: 100,
        stream: false,
      });
      assert(r.status === 200, `20c status 200 (got ${r.status})`);
      assert(r.headers?.['x-c-thru-thinking-tokens'] === undefined,
        `no thinking-tokens header when thoughtsTokenCount absent (got '${r.headers?.['x-c-thru-thinking-tokens']}')`);
      assert(r.json?.usage?.output_tokens === 10,
        `output_tokens=10 (visible-only, no thoughts to add) (got ${r.json?.usage?.output_tokens})`);
    });

    // ── 20d. Auto-enable without max_tokens → maxOutputTokens stays unset ─
    console.log('\n20d. Auto-enable but no max_tokens — maxOutputTokens absent, no budget-added header');
    {
      const proConfigPath = writeConfigFresh(tmpDir, 'nomax', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { 'gemini-pro-latest': 'gemini_stub' },
      });
      let captured = null;
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            captured = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }));
          });
          return true;
        }
        return false;
      });
      await withProxy({ configPath: proConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-pro-latest',
          messages: [{ role: 'user', content: 'go' }],
          stream: false,
          // no max_tokens
        });
        assert(r.status === 200, `20d status 200 (got ${r.status})`);
        assert(captured?.generationConfig?.maxOutputTokens === undefined,
          `maxOutputTokens absent when caller omits max_tokens (got ${captured?.generationConfig?.maxOutputTokens})`);
        assert(captured?.generationConfig?.thinkingConfig?.thinkingLevel === 'low',
          `auto-enable still fires (thinkingLevel='low') (got ${captured?.generationConfig?.thinkingConfig?.thinkingLevel})`);
        assert(r.headers?.['x-c-thru-thinking-budget-added'] === undefined,
          `no budget-added header when max_tokens absent (got '${r.headers?.['x-c-thru-thinking-budget-added']}')`);
        assert(r.headers?.['x-c-thru-thinking-auto-enabled'] === '1',
          `auto-enable header still set (got '${r.headers?.['x-c-thru-thinking-auto-enabled']}')`);
      });
    }

    // ── 20e. count_tokens path — auto-enable telemetry NOT leaked ─────────
    console.log('\n20e. count_tokens — auto-enable / budget-added headers must NOT leak (no model invocation)');
    {
      const proConfigPath = writeConfigFresh(tmpDir, 'counttok', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { 'gemini-pro-latest': 'gemini_stub' },
      });
      let capturedUrl = null;
      let capturedBody = null;
      stub.setHandler((req, res) => {
        if (req.url.includes(':countTokens')) {
          capturedUrl = req.url;
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            capturedBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ totalTokens: 7 }));
          });
          return true;
        }
        return false;
      });
      await withProxy({ configPath: proConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages/count_tokens', {
          model: 'gemini-pro-latest',
          messages: [{ role: 'user', content: 'count me' }],
          max_tokens: 100,
        });
        assert(r.status === 200, `20e status 200 (got ${r.status})`);
        assert(r.json?.input_tokens === 7, `input_tokens passed through (got ${r.json?.input_tokens})`);
        // generationConfig stripped: no thinkingConfig forwarded.
        assert(capturedBody?.generationConfig === undefined,
          `generationConfig absent on countTokens (got ${JSON.stringify(capturedBody?.generationConfig)})`);
        // Headers must NOT advertise auto-enable since no model invocation occurred.
        assert(r.headers?.['x-c-thru-thinking-auto-enabled'] === undefined,
          `count_tokens: auto-enable header absent (got '${r.headers?.['x-c-thru-thinking-auto-enabled']}')`);
        assert(r.headers?.['x-c-thru-thinking-budget-added'] === undefined,
          `count_tokens: budget-added header absent (got '${r.headers?.['x-c-thru-thinking-budget-added']}')`);
      });
    }

    // ── 21. budgetToThinkingLevel mapping — high budget on gemini-3.1-pro ─
    console.log('\n21. thinkingLevel mapping — high budget (16384+) on Gemini 3.1 Pro → "high"');
    let captured21 = null;
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          captured21 = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }));
        });
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,  // gemini-3.1-pro supports low/medium/high
        thinking: { type: 'enabled', budget_tokens: 16384 },
        messages: [{ role: 'user', content: 'go' }],
        max_tokens: 100,
        stream: false,
      });
      assert(r.status === 200, `21 status 200 (got ${r.status})`);
      assert(captured21?.generationConfig?.thinkingConfig?.thinkingLevel === 'high',
        `budget=16384 → thinkingLevel='high' (got ${captured21?.generationConfig?.thinkingConfig?.thinkingLevel})`);
      assert(r.headers?.['x-c-thru-thinking-level'] === 'high',
        `x-c-thru-thinking-level=high (got '${r.headers?.['x-c-thru-thinking-level']}')`);
    });

    // ── 21b. mid budget on gemini-3.1-pro → "medium" (model supports it) ──
    console.log('\n21b. thinkingLevel mapping — mid budget (4096) on Gemini 3.1 Pro → "medium"');
    let captured21b = null;
    stub.setHandler((req, res) => {
      if (req.url.includes(':generateContent')) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          captured21b = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }));
        });
        return true;
      }
      return false;
    });
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        thinking: { type: 'enabled', budget_tokens: 4096 },
        messages: [{ role: 'user', content: 'go' }],
        max_tokens: 100,
        stream: false,
      });
      assert(r.status === 200, `21b status 200 (got ${r.status})`);
      assert(captured21b?.generationConfig?.thinkingConfig?.thinkingLevel === 'medium',
        `budget=4096 on 3.1-pro → 'medium' (got ${captured21b?.generationConfig?.thinkingConfig?.thinkingLevel})`);
    });

    // ── 21c. mid budget on gemini-3-pro (no medium support) → "high" ───────
    console.log('\n21c. thinkingLevel mapping — mid budget (4096) on Gemini 3 Pro (no medium) → "high"');
    {
      const proConfigPath = writeConfigFresh(tmpDir, 'pro3medium', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { 'gemini-3-pro-preview': 'gemini_stub' },
      });
      let captured = null;
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            captured = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }));
          });
          return true;
        }
        return false;
      });
      await withProxy({ configPath: proConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-3-pro-preview',
          thinking: { type: 'enabled', budget_tokens: 4096 },
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 100,
          stream: false,
        });
        assert(r.status === 200, `21c status 200 (got ${r.status})`);
        assert(captured?.generationConfig?.thinkingConfig?.thinkingLevel === 'high',
          `gemini-3-pro doesn't support 'medium' → falls to 'high' (got ${captured?.generationConfig?.thinkingConfig?.thinkingLevel})`);
      });
    }

    // ── 21d. budget=0 on gemini-3-flash → "minimal" ───────────────────────
    console.log('\n21d. thinkingLevel mapping — budget=0 on Gemini 3 Flash → "minimal"');
    {
      const flashConfigPath = writeConfigFresh(tmpDir, 'flashminimal', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { 'gemini-3-flash-preview': 'gemini_stub' },
      });
      let captured = null;
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            captured = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }));
          });
          return true;
        }
        return false;
      });
      await withProxy({ configPath: flashConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-3-flash-preview',
          thinking: { type: 'enabled', budget_tokens: 0 },
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 100,
          stream: false,
        });
        assert(r.status === 200, `21d status 200 (got ${r.status})`);
        assert(captured?.generationConfig?.thinkingConfig?.thinkingLevel === 'minimal',
          `gemini-3-flash + budget=0 → 'minimal' (got ${captured?.generationConfig?.thinkingConfig?.thinkingLevel})`);
      });
    }

    // ── 21e. Gemini 2.5 keeps legacy thinkingBudget ───────────────────────
    console.log('\n21e. Gemini 2.5 retains legacy thinkingBudget (no thinkingLevel migration)');
    {
      const v25ConfigPath = writeConfigFresh(tmpDir, 'gemini25', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { 'gemini-2.5-pro': 'gemini_stub' },
      });
      let captured = null;
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            captured = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }));
          });
          return true;
        }
        return false;
      });
      await withProxy({ configPath: v25ConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-2.5-pro',
          thinking: { type: 'enabled', budget_tokens: 4096 },
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 200,
          stream: false,
        });
        assert(r.status === 200, `21e status 200 (got ${r.status})`);
        assert(captured?.generationConfig?.thinkingConfig?.thinkingBudget === 4096,
          `gemini-2.5-pro: legacy thinkingBudget=4096 (got ${captured?.generationConfig?.thinkingConfig?.thinkingBudget})`);
        assert(captured?.generationConfig?.thinkingConfig?.thinkingLevel === undefined,
          `gemini-2.5-pro: NO thinkingLevel (got ${captured?.generationConfig?.thinkingConfig?.thinkingLevel})`);
        assert(captured?.generationConfig?.maxOutputTokens === 4296,
          `2.5 budget arithmetic: max_tokens(200)+budget(4096)=4296 (got ${captured?.generationConfig?.maxOutputTokens})`);
        assert(r.headers?.['x-c-thru-thinking-level'] === undefined,
          `gemini-2.5: no thinking-level header (got '${r.headers?.['x-c-thru-thinking-level']}')`);
      });
    }

    // ── 22. Vertex AI thinking parity ──────────────────────────────────────
    // All thinking-related observability (auto-enable, budget arithmetic,
    // thoughtsTokenCount surfacing, output_tokens parity, streaming
    // thinking_output_tokens) is also exercised on AI Studio (gemini_ai). The
    // Vertex endpoint has a different URL prefix, different auth (Bearer
    // token instead of x-goog-api-key), and Google's forum threads on
    // thoughtsTokenCount specifically called out Vertex inconsistencies. Mirror
    // the AI Studio cases through a vertex:true backend to catch regressions.
    console.log('\n22. Vertex AI thinking parity');
    {
      const vertexThinkConfig = {
        backends: {
          gemini_vertex_stub: {
            format: 'gemini',
            vertex: true,
            url: `http://127.0.0.1:${stub.port}/v1/projects/test-proj/locations/us-central1/publishers/google/models`,
            auth: { literal: 'fake-vertex-token' },
          },
        },
        model_routes: {
          [GEMINI_MODEL]: 'gemini_vertex_stub',
          'gemini-pro-latest': 'gemini_vertex_stub',
        },
      };
      const vertexThinkConfigPath = writeConfigFresh(tmpDir, 'vertex-think', vertexThinkConfig);

      // 22a. thoughtsTokenCount surfaces via x-c-thru-thinking-tokens on Vertex.
      let captured22a = null;
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            captured22a = { url: req.url, body: JSON.parse(body) };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, thoughtsTokenCount: 77 },
            }));
          });
          return true;
        }
        return false;
      });
      await withProxy({ configPath: vertexThinkConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: GEMINI_MODEL,
          thinking: { type: 'enabled', budget_tokens: 256 },
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 100,
          stream: false,
        });
        assert(r.status === 200, `22a status 200 (got ${r.status})`);
        assert(captured22a?.url?.startsWith('/v1/projects/test-proj/'),
          `22a Vertex regional URL preserved (got '${captured22a?.url}')`);
        assert(!captured22a?.url?.includes('/v1beta/'),
          `22a Vertex URL has no /v1beta/ leak (got '${captured22a?.url}')`);
        assert(r.headers?.['x-c-thru-thinking-tokens'] === '77',
          `22a Vertex x-c-thru-thinking-tokens=77 (got '${r.headers?.['x-c-thru-thinking-tokens']}')`);
        assert(r.json?.usage?.output_tokens === 87,
          `22a Vertex output_tokens parity = 10+77 (got ${r.json?.usage?.output_tokens})`);
      });

      // 22b. Auto-enable thinking on Gemini 3 Pro through Vertex.
      let captured22b = null;
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            captured22b = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }));
          });
          return true;
        }
        return false;
      });
      await withProxy({ configPath: vertexThinkConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-pro-latest',
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 100,
          stream: false,
        });
        assert(r.status === 200, `22b status 200 (got ${r.status})`);
        assert(captured22b?.generationConfig?.thinkingConfig?.thinkingLevel === 'low',
          `22b Vertex auto-enabled thinkingLevel='low' (got ${captured22b?.generationConfig?.thinkingConfig?.thinkingLevel})`);
        assert(r.headers?.['x-c-thru-thinking-auto-enabled'] === '1',
          `22b Vertex x-c-thru-thinking-auto-enabled=1 (got '${r.headers?.['x-c-thru-thinking-auto-enabled']}')`);
        assert(r.headers?.['x-c-thru-thinking-budget-added'] === '2048',
          `22b Vertex x-c-thru-thinking-budget-added=2048 (low approx) (got '${r.headers?.['x-c-thru-thinking-budget-added']}')`);
        assert(captured22b?.generationConfig?.maxOutputTokens === 2148,
          `22b Vertex maxOutputTokens = 100 + 2048 (got ${captured22b?.generationConfig?.maxOutputTokens})`);
      });

      // 22c. Streaming on Vertex — auto-enable headers + thinking_output_tokens.
      stub.setHandler((req, res) => {
        if (req.url.includes(':streamGenerateContent')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 12, thoughtsTokenCount: 33 },
          }) + '\n\n');
          res.end();
          return true;
        }
        return false;
      });
      await withProxy({ configPath: vertexThinkConfigPath, profile: '16gb', env }, async ({ port }) => {
        const sse = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          }, (res) => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
          });
          req.on('error', reject);
          req.write(JSON.stringify({
            model: 'gemini-pro-latest',
            messages: [{ role: 'user', content: 'go' }],
            max_tokens: 100,
            stream: true,
          }));
          req.end();
        });
        assert(sse.status === 200, `22c streaming status 200 (got ${sse.status})`);
        assert(sse.headers['x-c-thru-thinking-auto-enabled'] === '1',
          `22c Vertex streaming auto-enabled header (got '${sse.headers['x-c-thru-thinking-auto-enabled']}')`);
        const deltaMatch = sse.body.match(/event:\s*message_delta\s*\ndata:\s*(\{[^\n]+\})/);
        assert(deltaMatch != null, '22c Vertex streaming message_delta present');
        let delta = null;
        try { delta = JSON.parse(deltaMatch[1]); } catch {}
        assert(delta?.usage?.output_tokens === 45,
          `22c Vertex streaming output_tokens=45 (12+33) (got ${delta?.usage?.output_tokens})`);
        assert(delta?.usage?.thinking_output_tokens === undefined,
          `22c Vertex message_delta.usage spec-compliant (got ${delta?.usage?.thinking_output_tokens})`);
        const cthruMatch = sse.body.match(/event:\s*c-thru-thinking-tokens\s*\ndata:\s*(\{[^\n]+\})/);
        assert(cthruMatch != null, '22c Vertex c-thru-thinking-tokens event present');
        const evt = (() => { try { return JSON.parse(cthruMatch[1]); } catch { return null; } })();
        assert(evt?.thinking_tokens === 33,
          `22c Vertex custom event carries 33 (got ${evt?.thinking_tokens})`);
      });

      // 22d. Vertex count_tokens path does NOT leak thinking-* telemetry.
      // Mirrors test 20e on AI Studio — the latent leak (auto-enable stamp
      // surviving when generationConfig is stripped) would also fire on
      // Vertex if the count_tokens cleanup path missed the regional URL.
      let countUrl22d = null;
      stub.setHandler((req, res) => {
        if (req.url.includes(':countTokens')) {
          countUrl22d = req.url;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ totalTokens: 11 }));
          return true;
        }
        return false;
      });
      await withProxy({ configPath: vertexThinkConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages/count_tokens', {
          model: 'gemini-pro-latest',
          messages: [{ role: 'user', content: 'count me' }],
        });
        assert(r.status === 200, `22d Vertex count_tokens status 200 (got ${r.status})`);
        assert(countUrl22d?.startsWith('/v1/projects/test-proj/'),
          `22d Vertex count_tokens regional path (got '${countUrl22d}')`);
        assert(r.headers?.['x-c-thru-thinking-auto-enabled'] === undefined,
          `22d Vertex count_tokens: no auto-enable header leak (got '${r.headers?.['x-c-thru-thinking-auto-enabled']}')`);
        assert(r.headers?.['x-c-thru-thinking-budget-added'] === undefined,
          `22d Vertex count_tokens: no budget-added header leak (got '${r.headers?.['x-c-thru-thinking-budget-added']}')`);
      });
    }

    // ── 23. Auto-synthesized claude-via-<X> resolves through /v1/messages ──
    // /v1/models exposes claude-via-<X> entries for picker consumption (T-models-
    // claude-via in routing tests). The resolveBackend code path that unwraps
    // these to <X> at request time is asserted here with a clean handler.
    console.log('\n23. claude-via-<X> request resolves to underlying <X>');
    {
      const viaConfigPath = writeConfigFresh(tmpDir, 'claude-via', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { 'gemini-flash-latest': 'gemini_stub' },
      });
      let viaUrl = null;
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            viaUrl = req.url;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }));
          });
          return true;
        }
        return false;
      });
      await withProxy({ configPath: viaConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'claude-via-gemini-flash-latest',
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 10,
        });
        assert(r.status === 200, `23 status 200 (got ${r.status})`);
        assert(viaUrl?.includes('gemini-flash-latest'),
          `23 upstream URL has underlying model (got '${viaUrl}')`);
        const chain = r.headers?.['x-c-thru-resolution-chain'] || '';
        assert(chain.includes('claude-via-gemini-flash-latest'),
          `23 chain mentions claude-via prefix (got '${chain}')`);
        assert(chain.includes('alias(claude-via-gemini-flash-latest->gemini-flash-latest)'),
          `23 chain shows claude-via unwrap (got '${chain}')`);
      });

      // Negative: claude-via-<unknown-X> with no underlying route falls through
      // (will hit Anthropic regex passthrough or 400). We just verify it doesn't
      // crash the proxy and resolveBackend returns a clean error/passthrough.
      const noViaPath = writeConfigFresh(tmpDir, 'claude-via-noroute', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { 'gemini-flash-latest': 'gemini_stub' },
      });
      stub.setHandler((req, res) => {
        // Catch-all 200 so any forwarded request gets a response (we only care
        // that the proxy doesn't hang or crash on unresolvable claude-via-*).
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return true;
      });
      await withProxy({ configPath: noViaPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'claude-via-does-not-exist',
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 10,
        });
        // Status must be a clean number — the proxy must not hang.
        assert(typeof r.status === 'number' && r.status > 0,
          `23-neg proxy did not hang on unresolvable claude-via-* (got status ${r.status})`);
      });
    }

    // ── 24. Deprecated model warning header (Task #5) ──────────────────────
    // Built-in deprecation list maps gemini-1.0-pro, gemini-1.5-* etc. to
    // current-generation advice. Surface as x-c-thru-deprecated-model on the
    // response so callers + journals can detect retired-model usage instead of
    // discovering it via 4xx after Google retires the endpoint.
    console.log('\n24. Deprecated model surfaces x-c-thru-deprecated-model header');
    {
      const depConfigPath = writeConfigFresh(tmpDir, 'deprecated', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: {
          'gemini-1.5-pro': 'gemini_stub',
          'gemini-flash-latest': 'gemini_stub',
        },
      });
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }));
          return true;
        }
        return false;
      });

      // Deprecated model: header present.
      await withProxy({ configPath: depConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-1.5-pro',
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 10,
        });
        assert(r.status === 200, `24 status 200 (got ${r.status})`);
        const dep = r.headers?.['x-c-thru-deprecated-model'];
        assert(typeof dep === 'string' && dep.length > 0,
          `24 x-c-thru-deprecated-model present (got '${dep}')`);
        assert(/gemini-1\.5|gemini-pro-latest/.test(dep),
          `24 advice text mentions migration target (got '${dep}')`);
      });

      // Current-generation model: header absent.
      await withProxy({ configPath: depConfigPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-flash-latest',
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 10,
        });
        assert(r.status === 200, `24-current status 200 (got ${r.status})`);
        assert(r.headers?.['x-c-thru-deprecated-model'] === undefined,
          `24-current: no deprecation header on -latest (got '${r.headers?.['x-c-thru-deprecated-model']}')`);
      });

      // Override: config can opt out a default deprecation.
      const optOutPath = writeConfigFresh(tmpDir, 'dep-optout', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { 'gemini-1.5-pro': 'gemini_stub' },
        deprecated_models: { 'gemini-1.5-pro': false },
      });
      await withProxy({ configPath: optOutPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-1.5-pro',
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 10,
        });
        assert(r.status === 200, `24-optout status 200 (got ${r.status})`);
        assert(r.headers?.['x-c-thru-deprecated-model'] === undefined,
          `24-optout: deprecated_models:false un-deprecates (got '${r.headers?.['x-c-thru-deprecated-model']}')`);
      });

      // Override: user-defined deprecation is respected.
      const userDepPath = writeConfigFresh(tmpDir, 'dep-user', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { 'gemini-flash-latest': 'gemini_stub' },
        deprecated_models: { 'gemini-flash-latest': 'project-policy: switch to vertex' },
      });
      await withProxy({ configPath: userDepPath, profile: '16gb', env }, async ({ port }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'gemini-flash-latest',
          messages: [{ role: 'user', content: 'go' }],
          max_tokens: 10,
        });
        assert(r.status === 200, `24-user status 200 (got ${r.status})`);
        assert(r.headers?.['x-c-thru-deprecated-model'] === 'project-policy: switch to vertex',
          `24-user: user advice surfaces verbatim (got '${r.headers?.['x-c-thru-deprecated-model']}')`);
      });
    }

    // ── 25. Multi-turn thoughtSignature roundtrip with interleaved tool_use ──
    // Validates the GEMINI_THOUGHT_SIG_CACHE handles ≥3 turns where each
    // assistant response contains a tool_use that must echo its original
    // Gemini thoughtSignature on subsequent turns. Without this, Gemini 3+
    // returns "Function call is missing a thought_signature" 400 mid-conversation.
    //
    // Turn 1: client → "search for X". Upstream returns thinking+functionCall(id=tu_1, sig=s1).
    // Turn 2: client echoes turn-1 history (thinking + tool_use) plus tool_result + new user.
    //         Outbound functionCall for tu_1 must have thoughtSignature=s1.
    //         Upstream returns thinking+functionCall(id=tu_2, sig=s2).
    // Turn 3: client echoes turn-1+turn-2 history. Outbound functionCalls for
    //         BOTH tu_1 AND tu_2 must echo their respective signatures.
    console.log('\n25. Multi-turn thoughtSignature roundtrip (3 turns, interleaved tool_use)');
    {
      const sigConfigPath = writeConfigFresh(tmpDir, 'sig-multi', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { [GEMINI_MODEL]: 'gemini_stub' },
      });
      let turn = 0;
      let capturedTurns = [];
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            turn++;
            capturedTurns.push(JSON.parse(body));
            // Turn 1 → tool_use #1; Turn 2 → tool_use #2; Turn 3 → final text.
            let respParts;
            if (turn === 1) {
              respParts = [
                { text: 'looking up first', thought: true, thoughtSignature: 'sig-tu1' },
                { functionCall: { name: 'search', args: { q: 'X' }, id: 'tu_1' }, thoughtSignature: 'sig-tu1' },
              ];
            } else if (turn === 2) {
              respParts = [
                { text: 'looking up second', thought: true, thoughtSignature: 'sig-tu2' },
                { functionCall: { name: 'search', args: { q: 'Y' }, id: 'tu_2' }, thoughtSignature: 'sig-tu2' },
              ];
            } else {
              respParts = [{ text: 'final answer combining both' }];
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{
                content: { parts: respParts },
                finishReason: turn === 3 ? 'STOP' : 'STOP',
              }],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
            }));
          });
          return true;
        }
        return false;
      });
      await withProxy({ configPath: sigConfigPath, profile: '16gb', env }, async ({ port }) => {
        // Turn 1
        const r1 = await httpJson(port, 'POST', '/v1/messages', {
          model: GEMINI_MODEL,
          messages: [{ role: 'user', content: 'search both X and Y' }],
          max_tokens: 200,
          tools: [{ name: 'search', description: 'web search', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
          thinking: { type: 'enabled', budget_tokens: 256 },
        });
        assert(r1.status === 200, `25 turn1 status 200 (got ${r1.status})`);
        const t1ToolUse = (r1.json?.content || []).find(b => b.type === 'tool_use');
        assert(t1ToolUse?.id === 'tu_1', `25 turn1 tool_use.id=tu_1 (got ${t1ToolUse?.id})`);

        // Turn 2: echo turn-1 history + tool_result, expect signature on outbound functionCall
        const r2 = await httpJson(port, 'POST', '/v1/messages', {
          model: GEMINI_MODEL,
          messages: [
            { role: 'user', content: 'search both X and Y' },
            { role: 'assistant', content: [
              { type: 'thinking', thinking: 'looking up first', signature: 'sig-tu1' },
              { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'X' } },
            ] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'result-X' }] },
          ],
          max_tokens: 200,
          tools: [{ name: 'search', description: 'web search', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
          thinking: { type: 'enabled', budget_tokens: 256 },
        });
        assert(r2.status === 200, `25 turn2 status 200 (got ${r2.status})`);
        // Verify outbound functionCall for tu_1 carries the cached signature.
        const turn2Body = capturedTurns[1];
        const turn2Contents = turn2Body?.contents || [];
        // Find the assistant turn that contains functionCall (role='model').
        const assistantTurn = turn2Contents.find(c => c.role === 'model' && (c.parts || []).some(p => p.functionCall));
        const fcPart = (assistantTurn?.parts || []).find(p => p.functionCall);
        assert(fcPart?.thoughtSignature === 'sig-tu1',
          `25 turn2 outbound functionCall(tu_1) echoes sig-tu1 (got '${fcPart?.thoughtSignature}')`);

        // Turn 3: full history (turn1 + turn2). Outbound must echo BOTH signatures.
        const r3 = await httpJson(port, 'POST', '/v1/messages', {
          model: GEMINI_MODEL,
          messages: [
            { role: 'user', content: 'search both X and Y' },
            { role: 'assistant', content: [
              { type: 'thinking', thinking: 'looking up first', signature: 'sig-tu1' },
              { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'X' } },
            ] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'result-X' }] },
            { role: 'assistant', content: [
              { type: 'thinking', thinking: 'looking up second', signature: 'sig-tu2' },
              { type: 'tool_use', id: 'tu_2', name: 'search', input: { q: 'Y' } },
            ] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'result-Y' }] },
          ],
          max_tokens: 200,
          tools: [{ name: 'search', description: 'web search', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
          thinking: { type: 'enabled', budget_tokens: 256 },
        });
        assert(r3.status === 200, `25 turn3 status 200 (got ${r3.status})`);
        const turn3Body = capturedTurns[2];
        const turn3Assistants = (turn3Body?.contents || []).filter(c => c.role === 'model');
        const turn3FCs = turn3Assistants.flatMap(a => (a.parts || []).filter(p => p.functionCall));
        const sigForId = (id) => turn3FCs.find(p => p.functionCall.id === id)?.thoughtSignature;
        assert(sigForId('tu_1') === 'sig-tu1',
          `25 turn3 functionCall(tu_1) echoes sig-tu1 (got '${sigForId('tu_1')}')`);
        assert(sigForId('tu_2') === 'sig-tu2',
          `25 turn3 functionCall(tu_2) echoes sig-tu2 (got '${sigForId('tu_2')}')`);

        // Final response: text-only completion.
        const finalText = (r3.json?.content || []).find(b => b.type === 'text');
        assert(finalText?.text?.includes('final answer'),
          `25 turn3 returns final text (got '${finalText?.text}')`);
      });
    }

    // ── 25b. thoughtSignature TTL eviction ─────────────────────────────────
    // Setting GEMINI_THOUGHT_SIG_TTL_MS=50 should expire signatures fast enough
    // that turn 2 sent after a delay omits the signature. Confirms the TTL
    // path in lookupThoughtSignature actually fires (vs. only being unit-tested).
    console.log('\n25b. thoughtSignature TTL expiry omits signature on stale turn');
    {
      const ttlConfigPath = writeConfigFresh(tmpDir, 'sig-ttl', {
        backends: { gemini_stub: { format: 'gemini', url: `http://127.0.0.1:${stub.port}`, auth: { literal: 'fake-gemini-key' } } },
        model_routes: { [GEMINI_MODEL]: 'gemini_stub' },
      });
      let ttlTurn = 0;
      let ttlCaptured = [];
      stub.setHandler((req, res) => {
        if (req.url.includes(':generateContent')) {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            ttlTurn++;
            ttlCaptured.push(JSON.parse(body));
            const respParts = ttlTurn === 1
              ? [{ functionCall: { name: 'search', args: {}, id: 'tu_ttl' }, thoughtSignature: 'sig-ttl' }]
              : [{ text: 'done' }];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              candidates: [{ content: { parts: respParts }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }));
          });
          return true;
        }
        return false;
      });
      // Force TTL = 50ms via env passed to the proxy child.
      await withProxy({
        configPath: ttlConfigPath, profile: '16gb',
        env: Object.assign({}, env, { GEMINI_THOUGHT_SIG_TTL_MS: '50' }),
      }, async ({ port }) => {
        await httpJson(port, 'POST', '/v1/messages', {
          model: GEMINI_MODEL,
          messages: [{ role: 'user', content: 'q' }],
          max_tokens: 200,
          tools: [{ name: 'search', description: 'web search', input_schema: { type: 'object', properties: {} } }],
        });
        // Wait past TTL.
        await new Promise(r => setTimeout(r, 150));
        await httpJson(port, 'POST', '/v1/messages', {
          model: GEMINI_MODEL,
          messages: [
            { role: 'user', content: 'q' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_ttl', name: 'search', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_ttl', content: 'x' }] },
          ],
          max_tokens: 200,
          tools: [{ name: 'search', description: 'web search', input_schema: { type: 'object', properties: {} } }],
        });
        const turn2 = ttlCaptured[1];
        const fcPart = (turn2?.contents || [])
          .flatMap(c => c.parts || [])
          .find(p => p.functionCall && p.functionCall.id === 'tu_ttl');
        assert(fcPart != null, '25b found outbound functionCall(tu_ttl)');
        assert(fcPart?.thoughtSignature === undefined,
          `25b post-TTL omits thoughtSignature (got '${fcPart?.thoughtSignature}')`);
      });
    }

    // 15b. No redacted_thinking -> header absent.
    console.log('\n15b. Wave 4: no redacted_thinking -> no x-c-thru-redacted-thinking-dropped header');
    await withProxy({ configPath, profile: '16gb', env }, async ({ port }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', {
        model: GEMINI_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
        stream: false,
      });
      assert(r.status === 200, `15b status 200 (got ${r.status})`);
      assert(r.headers?.['x-c-thru-redacted-thinking-dropped'] === undefined,
        `x-c-thru-redacted-thinking-dropped absent (got '${r.headers?.['x-c-thru-redacted-thinking-dropped']}')`);
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
