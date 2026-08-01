#!/usr/bin/env node
'use strict';
// Hermetic black-box coverage for encrypted Responses reasoning-cache bounds.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assert,
  summary,
  stubBackend,
  writeConfig,
  httpJson,
  terminateAndReap,
  withProxy,
} = require('./helpers');

const MODEL = 'responses-cache-test';
const USER_ID = 'responses-cache-user';
const TOOL = {
  name: 'lookup',
  description: 'Look up a value',
  input_schema: { type: 'object', properties: {} },
};

function buildConfig(port) {
  return {
    endpoints: {
      responses_stub: {
        url: `http://127.0.0.1:${port}`,
        format: 'openai',
        call_style: 'openai',
        auth: {
          header: 'Authorization',
          scheme: 'Bearer',
          literal: 'test-key',
        },
      },
    },
    model_routes: { [MODEL]: 'responses_stub' },
  };
}

function response(output) {
  return {
    id: 'resp_cache_test',
    status: 'completed',
    output,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function reasoning(id, encryptedContent) {
  return {
    id,
    type: 'reasoning',
    status: 'completed',
    summary: [],
    encrypted_content: encryptedContent,
  };
}

function jsonHandler(value, captured) {
  return (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      captured.value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    });
    return true;
  };
}

async function send(port, body) {
  return httpJson(port, 'POST', '/v1/messages', {
    model: MODEL,
    metadata: { user_id: USER_ID },
    tools: [TOOL],
    stream: false,
    ...body,
  }, {}, 2000);
}

async function seedMany(stub, port, entries) {
  const captured = {};
  const output = entries.flatMap(({ callId, item }) => [
    item,
    {
      type: 'function_call',
      call_id: callId,
      name: TOOL.name,
      arguments: '{}',
    },
  ]);
  stub.setHandler(jsonHandler(response(output), captured));
  const result = await send(port, {
    messages: [{
      role: 'user',
      content: `Call ${entries.map(entry => entry.callId).join(', ')}.`,
    }],
  });
  assert(
    result.status === 200 &&
      entries.every(entry =>
        result.json?.content?.some(block =>
          block.type === 'tool_use' && block.id === entry.callId)),
    `${entries.length} reasoning fixture(s) reach a tool-use response`,
  );
}

async function replayMany(stub, port, callIds) {
  const captured = {};
  stub.setHandler(jsonHandler(response([
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'complete' }],
    },
  ]), captured));
  const result = await send(port, {
    messages: [
      { role: 'user', content: `Call ${callIds.join(', ')}.` },
      {
        role: 'assistant',
        content: callIds.map(callId => ({
          type: 'tool_use',
          id: callId,
          name: TOOL.name,
          input: {},
        })),
      },
      {
        role: 'user',
        content: callIds.map(callId => ({
          type: 'tool_result',
          tool_use_id: callId,
          content: 'done',
        })),
      },
    ],
  });
  assert(result.status === 200, `${callIds.length} continuation call(s) succeed`);
  return captured.value;
}

function includesReasoning(requestBody, encryptedContent) {
  return requestBody?.input?.some(item =>
    item?.type === 'reasoning' &&
    item.encrypted_content === encryptedContent,
  ) === true;
}

async function withCacheProxy(configPath, env, fn) {
  await withProxy({
    configPath,
    profile: '16gb',
    readyTimeoutMs: 5000,
    env,
  }, async context => {
    try {
      await fn(context);
    } finally {
      // Test-only proxies have no durable state; reap immediately so four
      // cache-boundary cases stay well below the suite's 15-second budget.
      await terminateAndReap(context.child, 'SIGKILL');
    }
  });
}

async function main() {
  console.log('proxy-responses-reasoning-cache tests\n');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-responses-cache-'));
  const stub = await stubBackend();
  const configPath = writeConfig(tmp, buildConfig(stub.port));

  try {
    console.log('1. Invalid, zero, negative, and oversized bounds use safe defaults');
    await withCacheProxy(configPath, {
      RESPONSES_REASONING_CACHE_MAX_ENTRIES: 'not-a-number',
      RESPONSES_REASONING_CACHE_TTL_MS: '0',
      RESPONSES_REASONING_CACHE_MAX_ITEM_BYTES: '-1',
      RESPONSES_REASONING_CACHE_MAX_BYTES: String((256 * 1024 * 1024) + 1),
    }, async ({ port }) => {
      const item = reasoning('rs_defaults', 'defaults-remain-usable');
      await seedMany(stub, port, [{ callId: 'call_defaults', item }]);
      const continued = await replayMany(stub, port, ['call_defaults']);
      assert(
        includesReasoning(continued, item.encrypted_content),
        'invalid, zero, negative, and oversized cache settings do not disable replay',
      );
    });

    const smallItem = reasoning('rs_small', 'small');
    const largeItem = reasoning('rs_large', 'x'.repeat(512));
    const fifoItems = [
      reasoning('rs_fifo_1', 'a'.repeat(48)),
      reasoning('rs_fifo_2', 'b'.repeat(48)),
      reasoning('rs_fifo_3', 'c'.repeat(48)),
    ];
    const fifoBytes = Buffer.byteLength(JSON.stringify([fifoItems[0]]));
    assert(
      fifoItems.every(item =>
        Buffer.byteLength(JSON.stringify([item])) === fifoBytes),
      'FIFO fixtures have equal serialized size',
    );
    await withCacheProxy(configPath, {
      RESPONSES_REASONING_CACHE_MAX_ENTRIES: '10',
      RESPONSES_REASONING_CACHE_TTL_MS: '1500',
      RESPONSES_REASONING_CACHE_MAX_ITEM_BYTES: String(fifoBytes),
      RESPONSES_REASONING_CACHE_MAX_BYTES: String(fifoBytes * 2),
    }, async ({ port }) => {
      console.log('\n2. An oversized reasoning item is rejected');
      await seedMany(stub, port, [
        { callId: 'call_small', item: smallItem },
        { callId: 'call_large', item: largeItem },
      ]);
      const itemReplay = await replayMany(
        stub,
        port,
        ['call_small', 'call_large'],
      );
      assert(
        includesReasoning(itemReplay, smallItem.encrypted_content),
        'an item under the byte limit remains replayable',
      );
      assert(
        !includesReasoning(itemReplay, largeItem.encrypted_content),
        'an item over the byte limit is not replayed',
      );

      console.log('\n3. Aggregate-byte eviction is FIFO');
      await seedMany(stub, port, fifoItems.map((item, index) => ({
        callId: `call_fifo_${index + 1}`,
        item,
      })));
      const fifoReplay = await replayMany(
        stub,
        port,
        ['call_fifo_1', 'call_fifo_2', 'call_fifo_3'],
      );
      assert(
        !includesReasoning(fifoReplay, fifoItems[0].encrypted_content),
        'aggregate-byte pressure evicts the oldest entry',
      );
      assert(
        includesReasoning(fifoReplay, fifoItems[1].encrypted_content) &&
          includesReasoning(fifoReplay, fifoItems[2].encrypted_content),
        'aggregate-byte pressure retains the two newest entries',
      );

      console.log('\n4. TTL expiry removes stale reasoning');
      const item = reasoning('rs_ttl', 'expires-after-ttl');
      await seedMany(stub, port, [{ callId: 'call_ttl', item }]);
      const fresh = await replayMany(stub, port, ['call_ttl']);
      assert(
        includesReasoning(fresh, item.encrypted_content),
        'reasoning is replayed before its TTL',
      );
      await new Promise(resolve => setTimeout(resolve, 1700));
      const expired = await replayMany(stub, port, ['call_ttl']);
      assert(
        !includesReasoning(expired, item.encrypted_content),
        'reasoning is not replayed after its TTL',
      );
    });
  } finally {
    await stub.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  process.exit(summary() > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
