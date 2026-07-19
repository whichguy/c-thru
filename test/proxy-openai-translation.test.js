#!/usr/bin/env node
'use strict';
// Offline Responses-API translation tests through the real proxy dispatch path.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { stubBackend, writeConfig, httpJson, httpStream, withProxy } = require('./helpers');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}

const OPENAI_MODEL = 'gpt-test';

function buildOpenAIConfig(stubPort) {
  return {
    endpoints: {
      openai_stub: {
        url: `http://127.0.0.1:${stubPort}`,
        format: 'openai', call_style: 'openai',
        auth: { header: 'Authorization', scheme: 'Bearer', literal: 'test-openai-key' },
      },
    },
    model_routes: { [OPENAI_MODEL]: 'openai_stub' },
  };
}

function request(body) {
  return Object.assign({ model: OPENAI_MODEL }, body);
}

function response(output, extras = {}) {
  return Object.assign({ id: 'resp_test', status: 'completed', output,
    usage: { input_tokens: 3, output_tokens: 5 } }, extras);
}

function jsonHandler(value, captured) {
  return (req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      if (captured) captured.value = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(typeof value === 'function' ? value() : value));
    });
    return true;
  };
}

async function main() {
  console.log('proxy-openai-translation tests\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-openai-'));
  const stub = await stubBackend();
  const configPath = writeConfig(tmp, buildOpenAIConfig(stub.port));
  try {
    await withProxy({ configPath, profile: '16gb', env: {} }, async ({ port }) => {
      // 1. Sampling params ---------------------------------------------------
      console.log('1. Sampling params map to Responses fields');
      const captured1 = {};
      stub.setHandler(jsonHandler(response([{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }]), captured1));
      const r1 = await httpJson(port, 'POST', '/v1/messages', request({ system: 'system', temperature: 0.2, top_p: 0.7,
        max_tokens: 123, messages: [{ role: 'user', content: 'hello' }], stream: false }));
      assert(r1.status === 200 && r1.json?.content?.[0]?.text === 'ok', 'non-streaming response translated');
      assert(captured1.value?.temperature === 0.2 && captured1.value?.top_p === 0.7
        && captured1.value?.max_output_tokens === 123, 'temperature/top_p/max_tokens mapped');
      assert(captured1.value?.instructions === 'system' && captured1.value?.input?.[0]?.content?.[0]?.type === 'input_text', 'system and typed text input mapped');

      // 2. Tools / choices / schema passthrough -----------------------------
      console.log('\n2. Flat tool schema and tool_choice mapping');
      const choices = [
        [{ type: 'auto' }, 'auto'], [{ type: 'any' }, 'required'], [{ type: 'tool', name: 'weather' }, { type: 'function', name: 'weather' }], [{ type: 'none' }, 'none'],
      ];
      for (const [tool_choice, expected] of choices) {
        const captured = {};
        stub.setHandler(jsonHandler(response([{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }]), captured));
        const schema = { type: 'object', additionalProperties: false, properties: { q: { oneOf: [{ type: 'string' }, { type: 'number' }] } } };
        const r = await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'tools' }],
          tools: [{ name: 'weather', description: 'forecast', input_schema: schema }], tool_choice, stream: false }));
        const tool = captured.value?.tools?.[0];
        assert(r.status === 200, `tool_choice ${tool_choice.type} request succeeds`);
        assert(tool?.type === 'function' && tool?.name === 'weather' && tool?.description === 'forecast'
          && JSON.stringify(tool?.parameters) === JSON.stringify(schema) && tool?.function === undefined && tool?.strict === false, `flat Responses tool for ${tool_choice.type}`);
        assert(JSON.stringify(captured.value?.tool_choice) === JSON.stringify(expected), `tool_choice ${tool_choice.type} mapped`);
      }

      // 3. Streaming SSE -----------------------------------------------------
      console.log('\n3. Responses SSE reassembly');
      stub.setHandler((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const emit = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        emit({ type: 'response.created' });
        emit({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } });
        emit({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text' } });
        emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' });
        emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: ' world' });
        emit({ type: 'response.content_part.done', output_index: 0, content_index: 0 });
        emit({ type: 'response.output_item.done', output_index: 0 });
        emit({ type: 'response.completed', response: response([{ type: 'message', content: [{ type: 'output_text', text: 'hello world' }] }]) });
        res.end(); return true;
      });
      const s3 = await httpStream(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'hi' }], stream: true }));
      assert(s3.status === 200, 'stream status 200');
      assert(s3.events.map(e => e.event).join(',') === 'message_start,content_block_start,content_block_delta,content_block_delta,content_block_stop,message_delta,message_stop', 'Anthropic SSE event order');
      assert(s3.events.filter(e => e.event === 'content_block_delta').map(e => e.data?.delta?.text).join('') === 'hello world', 'text deltas reassembled');
      assert(!s3.rawBody.includes('response.output_text.delta'), 'no raw OpenAI event names leak');

      // 3b. Refusal deltas ---------------------------------------------------
      console.log('\n3b. Refusal deltas are forwarded');
      stub.setHandler((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const emit = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        emit({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } });
        emit({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'refusal' } });
        emit({ type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'Cannot ' });
        emit({ type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'comply.' });
        emit({ type: 'response.refusal.done', output_index: 0, content_index: 0 });
        emit({ type: 'response.completed', response: response([{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot comply.' }] }]) });
        res.end(); return true;
      });
      const refusalDelta = await httpStream(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'refuse' }], stream: true }));
      assert(refusalDelta.events.filter(e => e.event === 'content_block_delta').map(e => e.data?.delta?.text).join('') === 'Cannot comply.', 'streamed refusal text is preserved');

      // 4. Finish reasons ----------------------------------------------------
      console.log('\n4. Content-aware finish reasons');
      const finishCases = [
        ['plain', response([{ type: 'message', content: [{ type: 'output_text', text: 'yes' }] }]), 'end_turn', null],
        ['tool', response([{ type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{"city":"LA"}' }]), 'tool_use', null],
        ['refusal', response([{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }]), 'refusal', null],
        ['max', response([], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 'max_tokens', null],
        ['other-incomplete', response([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }), 'stop_sequence', 'openai_content_block'],
      ];
      for (const [name, value, reason, sequence] of finishCases) {
        stub.setHandler(jsonHandler(value));
        const r = await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: name }], stream: false }));
        assert(r.json?.stop_reason === reason && r.json?.stop_sequence === sequence, `non-stream ${name} → ${reason}`);
      }
      for (const [name, item, expected] of [
        ['tool', { type: 'function_call', call_id: 'call_s', name: 'calc' }, 'tool_use'],
        ['refusal', { type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }, 'refusal'],
      ]) {
        stub.setHandler((req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item })}\n\n`);
          if (name === 'refusal') {
            res.write(`data: ${JSON.stringify({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: item.content[0] })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'response.content_part.done', output_index: 0, content_index: 0 })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0 })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'response.completed', response: response([item]) })}\n\n`);
          res.end(); return true;
        });
        const s = await httpStream(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: name }], stream: true }));
        assert(s.events.find(e => e.event === 'message_delta')?.data?.delta?.stop_reason === expected, `stream ${name} → ${expected}`);
      }

      // 5. Error mapping and pre/post-commit failed fork --------------------
      console.log('\n5. HTTP and in-band errors, including stream commitment fork');
      stub.setHandler((req, res) => { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error', code: 'rate_limit' } })); return true; });
      const httpError = await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'x' }], stream: false }));
      assert(httpError.status === 429 && httpError.json?.error?.type === 'rate_limit_error', 'HTTP OpenAI error.type passes through');
      stub.setHandler(jsonHandler({ id: 'resp_failed', status: 'failed', error: { code: 'rate_limit_exceeded', message: 'quota hit' } }));
      const failedJson = await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'x' }], stream: false }));
      assert(failedJson.status >= 400 && failedJson.json?.type === 'error' && failedJson.json?.error?.type === 'rate_limit_error', 'non-stream status:failed is Anthropic error');
      stub.setHandler((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { code: 'invalid_request', message: 'bad before start' } } })}\n\n`); return true; });
      const pre = await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'x' }], stream: true }));
      assert(pre.status >= 400 && pre.json?.type === 'error' && pre.json?.error?.type === 'invalid_request_error', 'pre-commit response.failed uses HTTP error path');
      stub.setHandler((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text' } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' })}\n\n`);
        res.end(`data: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'after start' } } })}\n\n`); return true;
      });
      const post = await httpStream(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'x' }], stream: true }));
      const postErrors = post.events.filter(e => e.event === 'error');
      assert(post.status === 200 && post.events.some(e => e.event === 'message_start') && postErrors.length === 1
        && postErrors[0].data?.type === 'error' && !post.events.some(e => e.event === 'message_stop'), 'post-commit response.failed emits exactly one terminal SSE error');

      stub.setHandler((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text' } })}\n\n`);
        res.end(`data: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'quota after start' } } })}\n\n`); return true;
      });
      const classifiedPost = await httpStream(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'x' }], stream: true }));
      const classifiedPostErrors = classifiedPost.events.filter(e => e.event === 'error');
      assert(classifiedPostErrors.length === 1 && classifiedPostErrors[0].data?.error?.type === 'rate_limit_error', 'post-commit response.failed preserves classified OpenAI error type');

      // 5b. Truncated streams are failures, never synthetic completion ------
      console.log('\n5b. Truncated SSE does not synthesize success');
      stub.setHandler((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(); return true; });
      const truncatedPre = await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'x' }], stream: true }));
      assert(truncatedPre.status >= 400 && truncatedPre.json?.type === 'error' && !truncatedPre.json?.usage, 'pre-commit truncation is Anthropic error without usage');
      stub.setHandler((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const emit = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        emit({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text' } });
        emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' });
        res.end(); return true;
      });
      const truncatedPost = await httpStream(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'x' }], stream: true }));
      assert(truncatedPost.events.some(e => e.event === 'error') && !truncatedPost.events.some(e => e.event === 'message_stop'), 'post-commit truncation emits terminal error, not message_stop');

      // 6. Usage --------------------------------------------------------------
      console.log('\n6. Reasoning tokens are observational, not additive');
      stub.setHandler(jsonHandler(response([{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }], {
        usage: { input_tokens: 4, output_tokens: 7, output_tokens_details: { reasoning_tokens: 5 } },
      })));
      const usage = await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'x' }], stream: false }));
      assert(usage.json?.usage?.output_tokens === 7 && usage.headers['x-c-thru-thinking-tokens'] === '5', 'output_tokens excludes reasoning subset and header reports it');

      stub.setHandler(jsonHandler(response([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'private chain' }] }, { type: 'message', content: [{ type: 'output_text', text: 'visible' }] }])));
      const reasoning = await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'think' }], stream: false }));
      assert((reasoning.headers['x-c-thru-translation-gap'] || '').includes('reasoning'), 'reasoning response item records translation gap');
      assert(reasoning.json?.content?.length === 1 && reasoning.json.content[0]?.text === 'visible', 'reasoning output does not leak into Anthropic content');

      // 7. Count tokens ------------------------------------------------------
      console.log('\n7. count_tokens short-circuits before /v1/responses');
      const before = stub.requests.length;
      const count = await httpJson(port, 'POST', '/v1/messages/count_tokens', request({ system: 'abcd', messages: [{ role: 'user', content: 'efgh' }]}));
      assert(count.status === 200 && count.json?.input_tokens >= 1 && count.headers['x-c-thru-count-tokens'] === 'estimate', 'count_tokens returns proxy estimate');
      assert(stub.requests.length === before, 'count_tokens never reaches generative stub endpoint');
    });

    console.log('\n8. Streaming and non-stream resilience');
    await withProxy({ configPath, profile: '16gb', env: { CLAUDE_PROXY_PING_INTERVAL_MS: '200' } }, async ({ port }) => {
      stub.setHandler((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); const emit = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`); emit({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text' } }); emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'quiet' }); setTimeout(() => { emit({ type: 'response.completed', response: response([]) }); setTimeout(() => res.end(), 350); }, 450); return true; });
      const quiet = await httpStream(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'quiet' }], stream: true }), {}, 3000);
      const events = quiet.events.map(e => e.event); assert(events.includes('ping'), 'quiet committed stream emits keepalive ping'); assert(events.lastIndexOf('ping') < events.indexOf('message_stop'), 'keepalive interval stops after normal terminal event');
      let upstreamClosed; const closed = new Promise(resolve => { upstreamClosed = resolve; });
      stub.setHandler((req, res) => { req.on('close', upstreamClosed); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'started' })}\n\n`); return true; });
      await new Promise((resolve, reject) => { const client = http.request({ hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => res.once('data', () => { res.destroy(); resolve(); })); client.on('error', reject); client.end(JSON.stringify(request({ messages: [{ role: 'user', content: 'disconnect' }], stream: true }))); });
      assert(await Promise.race([closed.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1500))]), 'client mid-stream disconnect destroys upstream promptly');
    });
    await withProxy({ configPath, profile: '16gb', env: { CLAUDE_PROXY_NONSTREAM_BODY_CAP: '1024' } }, async ({ port }) => { stub.setHandler((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response([{ type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(2048) }] }]))); return true; }); const r = await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'large' }], stream: false })); assert(r.status === 502 && r.json?.type === 'error', 'oversized non-stream response is Anthropic error'); });
    await withProxy({ configPath, profile: '16gb', env: {} }, async ({ port }) => {
      stub.setHandler((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{not json'); return true; }); let r = await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'bad json' }], stream: false })); assert(r.status === 502 && r.json?.type === 'error', 'malformed non-stream response is Anthropic error');
      stub.setHandler((req, res) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'nope' } })); return true; }); r = await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'fail' }], stream: false })); assert(r.status >= 500 && !r.json?.usage, 'pre-commit HTTP failure has no successful usage');
      stub.setHandler((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {malformed json}\n\n'); res.end(`data: ${JSON.stringify({ type: 'response.completed', response: response([]) })}\n\n`); return true; }); const s = await httpStream(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'bad SSE' }], stream: true })); assert(s.events.filter(e => e.event === 'message_delta').length === 1 && s.events.filter(e => e.event === 'message_stop').length === 1, 'malformed SSE line is ignored and terminal usage is emitted once');
    });

  } finally {
    await stub.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passed}/${passed + failed} passed${failed ? ` — ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e.stack || e); process.exit(1); });
