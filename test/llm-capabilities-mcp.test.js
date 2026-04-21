#!/usr/bin/env node
'use strict';
// MCP JSON-RPC protocol conformance tests for llm-capabilities-mcp.js.
// Spawns the server as a subprocess and communicates via Content-Length-framed stdio.
// Run: node test/llm-capabilities-mcp.test.js

const { spawn }  = require('child_process');
const fs         = require('fs');
const http       = require('http');
const os         = require('os');
const path       = require('path');

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

const MCP_BIN = path.resolve(__dirname, '..', 'tools', 'llm-capabilities-mcp.js');

// ── MCP framing helpers ────────────────────────────────────────────────────────

function encodeMessage(obj) {
  const json = JSON.stringify(obj);
  const bytes = Buffer.from(json, 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`, 'utf8'),
    bytes,
  ]);
}

function decodeNextMessage(buffer) {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const header = buffer.slice(0, headerEnd).toString('utf8');
  const m = header.match(/Content-Length:\s*(\d+)/i);
  if (!m) return null;
  const len = Number(m[1]);
  const total = headerEnd + 4 + len;
  if (buffer.length < total) return null;
  const json = buffer.slice(headerEnd + 4, total).toString('utf8');
  return { message: JSON.parse(json), rest: buffer.slice(total) };
}

// ── Minimal stub proxy ─────────────────────────────────────────────────────────
// Answers /ping (with ok:true) and /v1/models so the MCP server can call list_models.

function startStubProxy(configPath) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, config_path: configPath }));
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'stub-model', type: 'model', owned_by: 'test' }] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, close: () => new Promise(r => server.close(r)) });
    });
    server.on('error', reject);
  });
}

// ── MCP session ────────────────────────────────────────────────────────────────

function spawnMcp(extraEnv = {}) {
  const env = Object.assign({}, process.env, {
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-home-')),
    CLAUDE_LLM_CAPABILITIES_DEBUG: '0',
  }, extraEnv);

  const child = spawn(process.execPath, [MCP_BIN], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  let recvBuf = Buffer.alloc(0);
  const pending = [];  // resolve fns for waiting callers

  child.stdout.on('data', chunk => {
    recvBuf = Buffer.concat([recvBuf, chunk]);
    while (pending.length > 0) {
      const result = decodeNextMessage(recvBuf);
      if (!result) break;
      recvBuf = result.rest;
      pending.shift()(result.message);
    }
  });

  const send = (obj) => child.stdin.write(encodeMessage(obj));

  const recv = () => new Promise((resolve, reject) => {
    const result = decodeNextMessage(recvBuf);
    if (result) {
      recvBuf = result.rest;
      resolve(result.message);
      return;
    }
    const timer = setTimeout(() => {
      const idx = pending.indexOf(resolve);
      if (idx !== -1) pending.splice(idx, 1);
      reject(new Error('recv timeout'));
    }, 5000);
    pending.push(msg => {
      clearTimeout(timer);
      resolve(msg);
    });
  });

  const close = () => new Promise(r => {
    child.stdin.end();
    child.on('exit', r);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
  });

  return { send, recv, close, child };
}

async function rpc(session, id, method, params) {
  const msg = { jsonrpc: '2.0', id, method };
  if (params !== undefined) msg.params = params;
  session.send(msg);
  return session.recv();
}

// ── Tests ──────────────────────────────────────────────────────────────────────

async function main() {
  let tmpDir;
  let stub;
  const sessions = [];

  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));

    // Minimal valid config (MCP server reads config on callTool only).
    const config = {
      backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
      model_routes: { 'stub-model': 'local' },
      llm_profiles: { '16gb': { workhorse: { connected_model: 'stub-model', disconnect_model: 'stub-model' } } },
      llm_mode: 'connected',
    };
    const rawConfigPath = path.join(tmpDir, 'model-map.json');
    fs.writeFileSync(rawConfigPath, JSON.stringify(config));
    const configPath = fs.realpathSync(rawConfigPath);

    stub = await startStubProxy(configPath);

    // ── 1. initialize → protocolVersion + capabilities ─────────────────────
    console.log('1. initialize → protocolVersion + capabilities');
    {
      const s = spawnMcp({ CLAUDE_MODEL_MAP_PATH: configPath });
      sessions.push(s);
      const resp = await rpc(s, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} });
      assert(resp.result?.protocolVersion === '2024-11-05',
        `protocolVersion=2024-11-05 (got ${resp.result?.protocolVersion})`);
      assert(typeof resp.result?.capabilities === 'object',
        'capabilities object present');
      assert(resp.result?.serverInfo?.name === 'llm-capabilities-mcp',
        `serverInfo.name correct (got ${resp.result?.serverInfo?.name})`);
    }

    // ── 2. tools/list → all TOOL_DEFS keys + valid inputSchema per tool ────
    console.log('\n2. tools/list → tool catalog with valid inputSchema');
    {
      const s = spawnMcp({ CLAUDE_MODEL_MAP_PATH: configPath });
      sessions.push(s);
      await rpc(s, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} });
      const resp = await rpc(s, 2, 'tools/list', {});
      assert(Array.isArray(resp.result?.tools), 'tools is an array');
      const tools = resp.result?.tools || [];
      assert(tools.length >= 3, `at least 3 tools (got ${tools.length})`);
      const toolNames = new Set(tools.map(t => t.name));
      assert(toolNames.has('list_models'),     'list_models tool present');
      assert(toolNames.has('classify_intent'), 'classify_intent tool present');
      assert(toolNames.has('ask_model'),       'ask_model tool present');
      for (const tool of tools) {
        assert(typeof tool.description === 'string' && tool.description.length > 0,
          `${tool.name}: description non-empty`);
        assert(tool.inputSchema?.type === 'object',
          `${tool.name}: inputSchema.type=object`);
        // list_models takes no arguments — required field is absent (valid per JSON Schema)
        const req = tool.inputSchema?.required;
        assert(req == null || Array.isArray(req),
          `${tool.name}: inputSchema.required absent or array (got ${JSON.stringify(req)})`);
      }
    }

    // ── 3. tools/call list_models with stub proxy ─────────────────────────
    console.log('\n3. tools/call list_models → calls stub proxy /v1/models');
    {
      const s = spawnMcp({
        CLAUDE_MODEL_MAP_PATH: configPath,
        CLAUDE_PROXY_PORT: String(stub.port),
      });
      sessions.push(s);
      await rpc(s, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} });
      const resp = await rpc(s, 2, 'tools/call', { name: 'list_models', arguments: {} });
      const content = resp.result?.content;
      assert(Array.isArray(content) && content.length > 0, 'tools/call list_models → content array');
      const text = content?.[0]?.text;
      let parsed;
      try { parsed = JSON.parse(text); } catch {}
      assert(typeof parsed?.model_count === 'number',
        `result.model_count is number (got ${parsed?.model_count})`);
      assert(parsed?.confidence === 100, `confidence=100 (got ${parsed?.confidence})`);
    }

    // ── 4. tools/call unknown tool → -32000 error ─────────────────────────
    console.log('\n4. tools/call unknown tool → error');
    {
      const s = spawnMcp({ CLAUDE_MODEL_MAP_PATH: configPath });
      sessions.push(s);
      await rpc(s, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} });
      const resp = await rpc(s, 2, 'tools/call', { name: 'nonexistent-tool-xyz', arguments: {} });
      assert(resp.error != null, 'unknown tool → error field present');
      assert(typeof resp.error?.message === 'string', `error.message is string (got ${JSON.stringify(resp.error?.message)})`);
      assert(resp.error.message.includes('nonexistent-tool-xyz') ||
             resp.error.message.toLowerCase().includes('unknown'),
        `error mentions tool name or "unknown" (got "${resp.error.message}")`);
    }

    // ── 5. Unknown method → error ─────────────────────────────────────────
    console.log('\n5. Unknown method → error response');
    {
      const s = spawnMcp({ CLAUDE_MODEL_MAP_PATH: configPath });
      sessions.push(s);
      await rpc(s, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} });
      const resp = await rpc(s, 2, 'some/unknown/method', {});
      assert(resp.error != null, 'unknown method → error field present');
    }

    // ── 6. tools/list returns unique tool names ───────────────────────────
    console.log('\n6. tools/list — no duplicate tool names');
    {
      const s = spawnMcp({ CLAUDE_MODEL_MAP_PATH: configPath });
      sessions.push(s);
      await rpc(s, 1, 'initialize', {});
      const resp = await rpc(s, 2, 'tools/list', {});
      const names = (resp.result?.tools || []).map(t => t.name);
      const unique = new Set(names);
      assert(unique.size === names.length, `no duplicate tool names (${names.length} total, ${unique.size} unique)`);
    }

    // ── 7. Subsequent tools/list after initialize returns same tools ──────
    console.log('\n7. Multiple tools/list calls return consistent catalog');
    {
      const s = spawnMcp({ CLAUDE_MODEL_MAP_PATH: configPath });
      sessions.push(s);
      await rpc(s, 1, 'initialize', {});
      const r1 = await rpc(s, 2, 'tools/list', {});
      const r2 = await rpc(s, 3, 'tools/list', {});
      const names1 = (r1.result?.tools || []).map(t => t.name).sort().join(',');
      const names2 = (r2.result?.tools || []).map(t => t.name).sort().join(',');
      assert(names1 === names2, 'same tool list on repeated calls');
      assert(names1.length > 0, 'non-empty tool list');
    }

  } finally {
    await Promise.all(sessions.map(s => s.close().catch(() => {})));
    if (stub) await stub.close().catch(() => {});
    if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

process.on('unhandledRejection', err => {
  console.error('unhandledRejection:', err);
  process.exit(1);
});

main().catch(err => {
  console.error(err);
  process.exit(1);
});
