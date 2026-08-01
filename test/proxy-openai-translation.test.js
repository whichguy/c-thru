#!/usr/bin/env node
'use strict';
// Offline Responses-API translation tests through the real proxy dispatch path.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { stubBackend, writeConfig, httpJson, httpStream, withProxy } = require('./helpers');
const {
  OPENAI_QUOTA_SENTENCE,
  XAI_CREDIT_SENTENCE,
  XAI_REMEDIATION_SENTENCE,
  liveOutcomeLine,
  classifyOpenAIBillingBlock,
  classifyXaiBillingBlock,
} = require('./provider-live-prerequisites');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}

const OPENAI_MODEL = 'gpt-test';
const CLAUDE_CORRELATION_HEADERS = {
  'x-claude-code-session-id': 'session-openai-canary',
  'x-claude-code-agent-id': 'agent-openai-canary',
  'x-claude-code-parent-agent-id': 'parent-openai-canary',
};

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

  console.log('0. Provider billing prerequisite classifiers are exact and hermetic');
  assert(classifyOpenAIBillingBlock({
    status: 429,
    json: { error: { code: 'insufficient_quota', message: OPENAI_QUOTA_SENTENCE } },
  }) === 'OpenAI insufficient_quota', 'OpenAI exact insufficient_quota response is blocked');
  assert(classifyOpenAIBillingBlock({
    status: 429,
    json: { type: 'error', error: { type: 'rate_limit_error', message: `OpenAI error: ${OPENAI_QUOTA_SENTENCE}` } },
  }) === 'OpenAI insufficient_quota', 'OpenAI proxied exact quota sentence is blocked');
  assert(classifyOpenAIBillingBlock({
    status: 429,
    json: { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for requests per minute.' } },
  }) === null, 'unrelated OpenAI 429 remains a failure');
  assert(classifyOpenAIBillingBlock({
    status: 403,
    json: { error: { code: 'insufficient_quota', message: OPENAI_QUOTA_SENTENCE } },
  }) === null, 'OpenAI billing body with an unverified status remains a failure');

  const xaiBillingBody = {
    code: 'permission-denied',
    error: `Your team test-team ${XAI_CREDIT_SENTENCE} To continue making API requests, ${XAI_REMEDIATION_SENTENCE}`,
  };
  assert(classifyXaiBillingBlock({ status: 403, json: xaiBillingBody }) ===
    'xAI permission-denied spending/credit limit', 'xAI exact permission-denied spending response is blocked');
  assert(classifyXaiBillingBlock({
    status: 403,
    json: { code: 'permission-denied', error: 'This API key is not authorized for the requested model.' },
  }) === null, 'unrelated xAI 403 remains a failure');
  assert(classifyXaiBillingBlock({ status: 429, json: xaiBillingBody }) === null,
    'xAI billing body with an unverified status remains a failure');
  assert(
    liveOutcomeLine('OpenAI', 'proxy openai live shapes', 'blocked', 'insufficient quota') ===
      'C_THRU_LIVE_OUTCOME|provider=OpenAI|suite=proxy_openai_live_shapes|status=blocked|reason=insufficient_quota',
    'live provider outcome is a delimiter-safe machine-readable line'
  );
  let badOutcomeRejected = false;
  try { liveOutcomeLine('openai', 'suite', 'maybe', 'reason'); } catch (e) {
    badOutcomeRejected = e instanceof TypeError;
  }
  assert(badOutcomeRejected, 'unknown live provider outcome status is rejected');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-openai-'));
  const responsesLogPath = path.join(tmp, 'responses-proxy.log');
  const stub = await stubBackend();
  const configPath = writeConfig(tmp, buildOpenAIConfig(stub.port));
  try {
    await withProxy({
      configPath,
      profile: '16gb',
      env: { CLAUDE_PROXY_LOG_FILE: responsesLogPath },
    }, async ({ port }) => {
      // 1. Sampling params ---------------------------------------------------
      console.log('1. Sampling params map to Responses fields');
      const captured1 = {};
      stub.setHandler(jsonHandler(response([{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }]), captured1));
      const r1 = await httpJson(port, 'POST', '/v1/messages', request({ system: 'system', temperature: 0.2, top_p: 0.7,
        max_tokens: 123, messages: [{ role: 'user', content: 'hello' }], stream: false }),
      CLAUDE_CORRELATION_HEADERS);
      assert(r1.status === 200 && r1.json?.content?.[0]?.text === 'ok', 'non-streaming response translated');
      assert(captured1.value?.temperature === 0.2 && captured1.value?.top_p === 0.7
        && captured1.value?.max_output_tokens === 123, 'temperature/top_p/max_tokens mapped');
      assert(captured1.value?.instructions === 'system' && captured1.value?.input?.[0]?.content?.[0]?.type === 'input_text', 'system and typed text input mapped');
      const openaiHeaders = stub.requests[stub.requests.length - 1]?.headers || {};
      for (const name of Object.keys(CLAUDE_CORRELATION_HEADERS)) {
        assert(!Object.prototype.hasOwnProperty.call(openaiHeaders, name),
          `OpenAI upstream does not receive ${name}`);
      }

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
        assert(captured.value?.parallel_tool_calls === undefined,
          `tool_choice ${tool_choice.type} preserves provider parallel default`);
      }
      for (const [type, name] of [
        ['auto', undefined],
        ['any', undefined],
        ['tool', 'weather'],
      ]) {
        const captured = {};
        stub.setHandler(jsonHandler(response([{
          type: 'message',
          content: [{ type: 'output_text', text: 'ok' }],
        }]), captured));
        const r = await httpJson(port, 'POST', '/v1/messages', request({
          messages: [{ role: 'user', content: 'one tool only' }],
          tools: [{
            name: 'weather',
            description: 'forecast',
            input_schema: { type: 'object', properties: {} },
            ...(type === 'tool' ? { strict: true } : {}),
          }],
          tool_choice: {
            type,
            ...(name ? { name } : {}),
            disable_parallel_tool_use: true,
          },
          stream: false,
        }));
        assert(r.status === 200, `${type} single-tool request succeeds`);
        assert(captured.value?.parallel_tool_calls === false,
          `${type} disable_parallel_tool_use maps to parallel_tool_calls:false`);
        if (type === 'tool') {
          assert(captured.value?.tools?.[0]?.strict === true,
            'generic Responses preserves explicit strict:true');
        }
      }

      console.log('\n2a. Thinking modes map deliberately or surface a gap');
      for (const testCase of [
        {
          name: 'enabled budget',
          body: { thinking: { type: 'enabled', budget_tokens: 512 } },
          expected: { effort: 'low', summary: 'auto' },
          gap: 'thinking.budget_tokens',
        },
        {
          name: 'adaptive medium omitted',
          body: {
            thinking: { type: 'adaptive', display: 'omitted' },
            output_config: { effort: 'medium' },
          },
          expected: { effort: 'medium' },
          gap: 'thinking.type:adaptive',
        },
        {
          name: 'disabled',
          body: {
            thinking: { type: 'disabled' },
            output_config: { effort: 'high' },
          },
          expected: undefined,
          gap: 'thinking.type:disabled',
        },
        {
          name: 'xhigh effort',
          body: { output_config: { effort: 'xhigh' } },
          expected: { effort: 'xhigh', summary: 'auto' },
          gap: null,
        },
        {
          name: 'max effort',
          body: { output_config: { effort: 'max' } },
          expected: { effort: 'max', summary: 'auto' },
          gap: null,
        },
        {
          name: 'unknown effort',
          body: { output_config: { effort: 'ultra' } },
          expected: { effort: 'high', summary: 'auto' },
          gap: 'output_config.effort',
        },
      ]) {
        const captured = {};
        stub.setHandler(jsonHandler(response([{
          type: 'message',
          content: [{ type: 'output_text', text: 'ok' }],
        }]), captured));
        const result = await httpJson(port, 'POST', '/v1/messages', request({
          messages: [{ role: 'user', content: testCase.name }],
          ...testCase.body,
          stream: false,
        }));
        assert(
          JSON.stringify(captured.value?.reasoning) ===
            JSON.stringify(testCase.expected),
          `${testCase.name} has the expected Responses reasoning policy`,
        );
        const gaps = (result.headers['x-c-thru-translation-gap'] || '')
          .split(',')
          .filter(Boolean);
        assert(
          testCase.gap
            ? gaps.includes(testCase.gap)
            : !gaps.includes('output_config.effort'),
          testCase.gap
            ? `${testCase.name} exposes ${testCase.gap}`
            : `${testCase.name} preserves effort without a translation gap`,
        );
      }

      // 2b. Multi-turn request history -------------------------------------
      console.log('\n2b. Multi-turn tool and image history preserves item order');
      const capturedHistory = {};
      const privateUserId = 'claude-session-private-123';
      stub.setHandler(jsonHandler(response([
        { type: 'message', content: [{ type: 'output_text', text: 'history accepted' }] },
      ]), capturedHistory));
      const history = await httpJson(port, 'POST', '/v1/messages', request({
        metadata: { user_id: privateUserId },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect this image.' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'iVBORw0KGgoAAAANSUhEUg==',
                },
              },
              { type: 'text', text: 'Then run both tools.' },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Starting.' },
              { type: 'tool_use', id: 'call_weather', name: 'weather', input: { city: 'LA' } },
              { type: 'tool_use', id: 'call_math', name: 'add', input: { a: 2, b: 2 } },
              { type: 'text', text: 'Waiting for both results.' },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_weather',
                content: 'weather lookup failed',
                is_error: true,
              },
              {
                type: 'tool_result',
                tool_use_id: 'call_math',
                content: [
                  { type: 'text', text: '4' },
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: 'iVBORw0KGgoAAAANSUhEUg==',
                    },
                  },
                ],
              },
              { type: 'text', text: 'Continue with what you have.' },
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
              },
            ],
          },
        ],
        stream: false,
      }));
      const expectedHistoryInput = [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Inspect this image.' },
            {
              type: 'input_image',
              image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
              detail: 'auto',
            },
            { type: 'input_text', text: 'Then run both tools.' },
          ],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'input_text', text: 'Starting.' }],
        },
        {
          type: 'function_call',
          call_id: 'call_weather',
          name: 'weather',
          arguments: '{"city":"LA"}',
        },
        {
          type: 'function_call',
          call_id: 'call_math',
          name: 'add',
          arguments: '{"a":2,"b":2}',
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'input_text', text: 'Waiting for both results.' }],
        },
        {
          type: 'function_call_output',
          call_id: 'call_weather',
          output: 'weather lookup failed',
        },
        {
          type: 'function_call_output',
          call_id: 'call_math',
          output: [
            { type: 'input_text', text: '4' },
            {
              type: 'input_image',
              image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
              detail: 'auto',
            },
          ],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Continue with what you have.' }],
        },
      ];
      assert(history.status === 200 && history.json?.content?.[0]?.text === 'history accepted',
        'multi-turn history succeeds through the Responses dispatch path');
      assert(JSON.stringify(capturedHistory.value?.input) === JSON.stringify(expectedHistoryInput),
        'messages, parallel calls, outputs, and image retain exact block order');
      const historyGaps = (history.headers['x-c-thru-translation-gap'] || '').split(',').filter(Boolean);
      assert(historyGaps.includes('tool_result.is_error'),
        'tool_result.is_error is preserved as an explicit protocol gap');
      assert(historyGaps.includes('document'),
        'unsupported document block is recorded as an explicit translation gap');
      assert(!historyGaps.includes('tool_use') && !historyGaps.includes('tool_result') &&
        !historyGaps.includes('image') && !historyGaps.includes('tool_result:unmatched'),
        'supported history blocks and matched parallel call IDs do not report false gaps');
      const expectedPromptCacheKey = crypto.createHash('sha256')
        .update('c-thru-responses-prompt-cache-v1\0', 'utf8')
        .update(privateUserId, 'utf8')
        .digest('hex');
      assert(capturedHistory.value?.prompt_cache_key === expectedPromptCacheKey &&
        !JSON.stringify(capturedHistory.value).includes(privateUserId),
        'metadata.user_id becomes a bounded hash and the raw identifier is not sent upstream');

      const capturedNextTurn = {};
      stub.setHandler(jsonHandler(response([
        { type: 'message', content: [{ type: 'output_text', text: 'next turn accepted' }] },
      ]), capturedNextTurn));
      const nextTurn = await httpJson(port, 'POST', '/v1/messages', request({
        metadata: { user_id: privateUserId },
        messages: [{ role: 'user', content: 'A later turn.' }],
        stream: false,
      }));
      assert(nextTurn.status === 200 &&
        capturedNextTurn.value?.prompt_cache_key === capturedHistory.value?.prompt_cache_key,
        'prompt_cache_key is deterministic across turns for Responses cache affinity');

      // 2c. Encrypted reasoning round-trip ----------------------------------
      console.log('\n2c. Encrypted reasoning is requested, cached, and replayed');
      const encryptedReasoning = {
        id: 'rs_private_parallel',
        type: 'reasoning',
        status: 'completed',
        summary: [],
        encrypted_content: 'opaque-encrypted-reasoning',
      };
      const reasoningCalls = [
        {
          type: 'function_call',
          call_id: 'call_reason_weather',
          name: 'weather',
          arguments: '{"city":"SF"}',
        },
        {
          type: 'function_call',
          call_id: 'call_reason_math',
          name: 'add',
          arguments: '{"a":6,"b":7}',
        },
      ];
      const reasoningTools = [
        {
          name: 'weather',
          description: 'Get weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
        {
          name: 'add',
          description: 'Add numbers',
          input_schema: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'number' } },
          },
        },
      ];
      const capturedReasoningFirst = {};
      stub.setHandler(jsonHandler(
        response([encryptedReasoning, ...reasoningCalls]),
        capturedReasoningFirst,
      ));
      const reasoningFirst = await httpJson(port, 'POST', '/v1/messages', request({
        metadata: { user_id: 'reasoning-user-a' },
        tools: reasoningTools,
        messages: [{ role: 'user', content: 'Use both tools.' }],
        stream: false,
      }));
      assert(
        JSON.stringify(capturedReasoningFirst.value?.include) ===
          JSON.stringify(['reasoning.encrypted_content']),
        'tool requests ask the Responses endpoint for encrypted reasoning',
      );
      assert(
        reasoningFirst.status === 200 &&
          reasoningFirst.json?.content?.map(block => block.id).join(',') ===
            'call_reason_weather,call_reason_math',
        'parallel function calls return stable Anthropic tool_use IDs',
      );

      const capturedReasoningSecond = {};
      stub.setHandler(jsonHandler(response([
        { type: 'message', content: [{ type: 'output_text', text: 'Both complete.' }] },
      ]), capturedReasoningSecond));
      const reasoningSecond = await httpJson(port, 'POST', '/v1/messages', request({
        metadata: { user_id: 'reasoning-user-a' },
        tools: reasoningTools,
        messages: [
          { role: 'user', content: 'Use both tools.' },
          { role: 'assistant', content: reasoningFirst.json.content },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_reason_weather',
                content: 'sunny',
              },
              {
                type: 'tool_result',
                tool_use_id: 'call_reason_math',
                content: '13',
              },
            ],
          },
        ],
        stream: false,
      }));
      const expectedReasoningReplay = [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Use both tools.' }],
        },
        encryptedReasoning,
        reasoningCalls[0],
        reasoningCalls[1],
        {
          type: 'function_call_output',
          call_id: 'call_reason_weather',
          output: 'sunny',
        },
        {
          type: 'function_call_output',
          call_id: 'call_reason_math',
          output: '13',
        },
      ];
      assert(
        reasoningSecond.status === 200 &&
          reasoningSecond.json?.content?.[0]?.text === 'Both complete.',
        'the tool-result turn succeeds after encrypted reasoning replay',
      );
      assert(
        JSON.stringify(capturedReasoningSecond.value?.input) ===
          JSON.stringify(expectedReasoningReplay),
        'one opaque reasoning item is replayed immediately before both matching parallel calls',
      );
      assert(
        capturedReasoningSecond.value.input.filter(
          item => item?.type === 'reasoning' &&
            item.encrypted_content === encryptedReasoning.encrypted_content,
        ).length === 1,
        'shared parallel-call reasoning is replayed exactly once',
      );

      const capturedOtherUser = {};
      stub.setHandler(jsonHandler(response([
        { type: 'message', content: [{ type: 'output_text', text: 'Other user complete.' }] },
      ]), capturedOtherUser));
      const otherUser = await httpJson(port, 'POST', '/v1/messages', request({
        metadata: { user_id: 'reasoning-user-b' },
        tools: reasoningTools,
        messages: [
          { role: 'user', content: 'Use both tools.' },
          { role: 'assistant', content: reasoningFirst.json.content },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_reason_weather',
                content: 'rainy',
              },
              {
                type: 'tool_result',
                tool_use_id: 'call_reason_math',
                content: '99',
              },
            ],
          },
        ],
        stream: false,
      }));
      assert(
        otherUser.status === 200 &&
          !capturedOtherUser.value.input.some(item => item?.type === 'reasoning'),
        'encrypted reasoning is never replayed across metadata.user_id boundaries',
      );

      // 2d. Lossy output translation is observable -------------------------
      console.log('\n2d. Malformed and unknown response items report translation gaps');
      stub.setHandler(jsonHandler(response([
        {
          type: 'function_call',
          call_id: 'call_bad_json',
          name: 'broken',
          arguments: '{not-json',
        },
        { type: 'future_response_item', payload: 'opaque' },
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'visible text survives' },
            { type: 'future_response_part', payload: 'opaque' },
          ],
        },
      ])));
      const lossyOutput = await httpJson(port, 'POST', '/v1/messages', request({
        messages: [{ role: 'user', content: 'Exercise unknown output shapes.' }],
        stream: false,
      }));
      const outputGaps = (lossyOutput.headers['x-c-thru-translation-gap'] || '')
        .split(',')
        .filter(Boolean);
      assert(
        lossyOutput.json?.content?.some(block =>
          block?.type === 'tool_use' &&
          block.id === 'call_bad_json' &&
          JSON.stringify(block.input) === '{}') &&
          lossyOutput.json?.content?.some(block =>
            block?.type === 'text' && block.text === 'visible text survives'),
        'supported output survives beside malformed and unknown response content',
      );
      assert(
        outputGaps.includes('function_call.arguments') &&
          outputGaps.includes('response_item:future_response_item') &&
          outputGaps.includes('response_part:future_response_part'),
        'every lossy output shape is named in x-c-thru-translation-gap',
      );

      // 3. Streaming SSE -----------------------------------------------------
      console.log('\n3. Responses SSE reassembly');
      stub.setHandler((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const emit = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        emit({ type: 'response.created' });
        emit({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } });
        emit({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text' } });
        emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' });
        emit({ type: 'response.future_content.delta', output_index: 0, delta: 'not representable' });
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
      const responsesLog = fs.readFileSync(responsesLogPath, 'utf8');
      assert(
        responsesLog.includes('c-thru [responses.stream.unknown_event]') &&
          responsesLog.includes('"type":"response.future_content.delta"'),
        'unknown streaming event types are recorded for provider-drift diagnosis',
      );

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
      assert(
        refusalDelta.events.find(e => e.event === 'content_block_start')
          ?.data?.content_block?.type === 'text' &&
          !refusalDelta.events.some(e =>
            e.data?.content_block?.type === 'refusal'),
        'streamed refusal uses an Anthropic text content block',
      );
      assert(
        JSON.stringify(
          refusalDelta.events.find(e => e.event === 'message_delta')
            ?.data?.delta?.stop_details,
        ) === JSON.stringify({
          type: 'refusal',
          category: null,
          explanation: null,
        }),
        'streamed refusal terminates with Anthropic stop_details',
      );

      console.log('\n3b.1 Whole and terminal-only refusal text is emitted once');
      for (const variant of ['whole-part', 'terminal-only']) {
        const text = `Cannot comply: ${variant}.`;
        const terminal = response([{
          type: 'message',
          content: [{ type: 'refusal', refusal: text }],
        }]);
        stub.setHandler((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const emit = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          if (variant === 'whole-part') {
            emit({
              type: 'response.output_item.added',
              output_index: 0,
              item: { type: 'message' },
            });
            emit({
              type: 'response.content_part.added',
              output_index: 0,
              content_index: 0,
              part: { type: 'refusal', refusal: text },
            });
            emit({
              type: 'response.content_part.done',
              output_index: 0,
              content_index: 0,
            });
          }
          emit({ type: 'response.completed', response: terminal });
          res.end();
          return true;
        });
        const wholeRefusal = await httpStream(
          port,
          'POST',
          '/v1/messages',
          request({
            messages: [{ role: 'user', content: variant }],
            stream: true,
          }),
        );
        assert(
          wholeRefusal.events
            .filter(e => e.event === 'content_block_delta')
            .map(e => e.data?.delta?.text)
            .join('') === text,
          `${variant} refusal text is emitted exactly once`,
        );
        assert(
          wholeRefusal.events.filter(e =>
            e.event === 'content_block_start').length === 1 &&
            wholeRefusal.events.find(e => e.event === 'content_block_start')
              ?.data?.content_block?.type === 'text',
          `${variant} refusal uses one Anthropic text block`,
        );
        assert(
          wholeRefusal.events.find(e => e.event === 'message_delta')
            ?.data?.delta?.stop_reason === 'refusal',
          `${variant} refusal terminates with refusal stop_reason`,
        );
      }

      // 3c. xAI whole-function-call streaming -------------------------------
      console.log('\n3c. Whole function-call chunks emit one JSON delta');
      for (const argumentsEvent of ['added', 'done']) {
        const callId = `call_whole_${argumentsEvent}`;
        const fullArguments = `{"source":"${argumentsEvent}"}`;
        const completeCall = {
          type: 'function_call',
          call_id: callId,
          name: 'lookup',
          arguments: fullArguments,
        };
        stub.setHandler((req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const emit = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          emit({
            type: 'response.output_item.added',
            output_index: 0,
            item: argumentsEvent === 'added'
              ? completeCall
              : {
                type: 'function_call',
                call_id: callId,
                name: 'lookup',
              },
          });
          emit({
            type: 'response.output_item.done',
            output_index: 0,
            item: argumentsEvent === 'done'
              ? completeCall
              : {
                type: 'function_call',
                call_id: callId,
                name: 'lookup',
              },
          });
          emit({
            type: 'response.completed',
            response: response([completeCall]),
          });
          res.end();
          return true;
        });
        const wholeCall = await httpStream(
          port,
          'POST',
          '/v1/messages',
          request({
            messages: [{ role: 'user', content: `whole call from ${argumentsEvent}` }],
            stream: true,
          }),
        );
        const jsonDeltas = wholeCall.events.filter(
          event => event.event === 'content_block_delta' &&
            event.data?.delta?.type === 'input_json_delta',
        );
        const toolStarts = wholeCall.events.filter(
          event => event.event === 'content_block_start' &&
            event.data?.content_block?.type === 'tool_use',
        );
        const toolStops = wholeCall.events.filter(
          event => event.event === 'content_block_stop',
        );
        assert(
          jsonDeltas.length === 1 &&
            jsonDeltas[0].data.delta.partial_json === fullArguments,
          `${argumentsEvent} whole-call arguments emit exactly one full input_json_delta`,
        );
        assert(
          toolStarts.length === 1 &&
            toolStarts[0].data.content_block.id === callId &&
            toolStarts[0].data.content_block.name === 'lookup',
          `${argumentsEvent} whole-call stream keeps the function identity`,
        );
        assert(
          wholeCall.events.indexOf(toolStarts[0]) <
            wholeCall.events.indexOf(jsonDeltas[0]) &&
            wholeCall.events.indexOf(jsonDeltas[0]) <
              wholeCall.events.indexOf(toolStops[0]),
          `${argumentsEvent} whole-call JSON arrives between block start and stop`,
        );
        assert(
          wholeCall.events.find(event => event.event === 'message_delta')
            ?.data?.delta?.stop_reason === 'tool_use',
          `${argumentsEvent} whole-call stream terminates with tool_use`,
        );
      }

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
        if (name === 'refusal') {
          assert(
            r.json?.content?.[0]?.type === 'text' &&
              r.json.content[0].text === 'no' &&
              !r.json.content.some(block => block?.type === 'refusal'),
            'non-stream refusal uses ordinary Anthropic text content',
          );
          assert(
            JSON.stringify(r.json?.stop_details) === JSON.stringify({
              type: 'refusal',
              category: null,
              explanation: null,
            }),
            'non-stream refusal includes Anthropic stop_details',
          );
        } else {
          assert(r.json?.stop_details === null,
            `non-stream ${name} carries null stop_details`);
        }
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
      assert(
        httpError.json?.error?.message?.includes('Responses endpoint "openai_stub" error: slow down'),
        'Responses error text identifies the configured endpoint without claiming OpenAI',
      );
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
        usage: {
          input_tokens: 4,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens: 7,
          output_tokens_details: { reasoning_tokens: 5 },
        },
      })));
      const usage = await httpJson(port, 'POST', '/v1/messages', request({ messages: [{ role: 'user', content: 'x' }], stream: false }));
      assert(usage.json?.usage?.output_tokens === 7 && usage.headers['x-c-thru-thinking-tokens'] === '5', 'output_tokens excludes reasoning subset and header reports it');
      assert(usage.json?.usage?.cache_read_input_tokens === 3 &&
        usage.json?.usage?.cache_creation_input_tokens === 0,
        'non-stream cached input tokens map to Anthropic cache usage fields');

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
