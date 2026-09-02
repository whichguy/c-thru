#!/usr/bin/env node
'use strict';
// P0 — agent-sentinel end-to-end through a LIVE proxy (loopback + HMAC trust).
//
// Trust requires loopback (default bind 127.0.0.1), an HMAC, and a spawned-agent id.
// capability in resolved-via is the logical profile key; agent is separate.
//
// Run: node test/proxy-agent-sentinel-e2e.test.js

const fs   = require('fs');
const path = require('path');
const { assert, assertEq, summary, withProxy, httpJson, stubBackend, collectStderr } = require('./helpers');
const { computeAgentSentinelTag, formatAgentSentinel } = require('../tools/agent-sentinel.js');

console.log('proxy agent-sentinel e2e (live proxy, loopback trust)\n');

const AGENT         = 'plan-reviewer';
const CAPABILITY    = 'plan-reviewer';
const AGENT_MODEL   = 'agent-model';
const DEFAULT_MODEL = 'default-model';
const MODE          = 'best-cloud';
const TIER          = '16gb';
const SENTINEL_SECRET = '0123456789abcdef0123456789abcdef';

function mkConfig(agentStubPort, defaultStubPort) {
  return {
    agent_to_capability: { [AGENT]: CAPABILITY },
    llm_profiles: {
      [CAPABILITY]: { [MODE]: { [TIER]: AGENT_MODEL } },
    },
    model_routes: {
      [AGENT_MODEL]: 'agentBackend',
      [DEFAULT_MODEL]: 'defaultBackend',
    },
    endpoints: {
      agentBackend:   { kind: 'anthropic', url: `http://127.0.0.1:${agentStubPort}` },
      defaultBackend: { kind: 'anthropic', url: `http://127.0.0.1:${defaultStubPort}` },
    },
  };
}

function bodyWith(markerContent, extraMessages = []) {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 5,
    messages: [{ role: 'user', content: markerContent }, ...extraMessages],
  };
}

function marker(name) {
  return formatAgentSentinel(name, SENTINEL_SECRET);
}

function legacyMarker(name) {
  return `[[c-thru-agent:${name}:deadbeefdeadbeef]]`;
}

function agentHeaders() {
  return { 'x-claude-code-agent-id': 'agent-e2e-1' };
}

async function withSentinelProxy({ logFile }, fn) {
  const agentStub   = await stubBackend();
  const defaultStub = await stubBackend();
  const configRoot  = fs.mkdtempSync(path.join(require('os').tmpdir(), 'c-thru-sentinel-cfg-'));
  const configPath  = path.join(configRoot, 'model-map.json');
  fs.writeFileSync(configPath, JSON.stringify(mkConfig(agentStub.port, defaultStub.port)));
  const env = { CLAUDE_LLM_MODE: MODE, C_THRU_AGENT_SENTINEL_SECRET: SENTINEL_SECRET };
  if (logFile) env.CLAUDE_PROXY_LOG_FILE = logFile;
  try {
    await withProxy({ configPath, profile: TIER, mode: MODE, env }, async (ctx) => {
      const stderr = collectStderr(ctx.child);
      await fn({ ...ctx, agentStub, defaultStub, stderr });
    });
  } finally {
    await agentStub.close().catch(() => {});
    await defaultStub.close().catch(() => {});
    try { fs.rmSync(configRoot, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  console.log('1. unsigned marker fails closed to the request model');
  await withSentinelProxy({}, async ({ port, agentStub, defaultStub }) => {
    const r = await httpJson(port, 'POST', '/v1/messages', bodyWith(`[[c-thru-agent:${AGENT}]]\nreview this plan`));
    assertEq(r.status, 200, 'unsigned marker: request succeeds (200)');
    assertEq(r.headers['x-c-thru-served-by'], DEFAULT_MODEL,
      `unsigned marker: x-c-thru-served-by remains '${DEFAULT_MODEL}'`);
    assert(r.headers['x-c-thru-resolved-via'] === undefined,
      'unsigned marker: no capability resolved-via (bare model route)');
    assert(defaultStub.requests.length === 1, `unsigned marker: default stub hit once`);
    assert(agentStub.requests.length === 0, `unsigned marker: agent stub NOT hit`);
    const fwd = defaultStub.requests[0] && defaultStub.requests[0].body;
    assert(fwd && !JSON.stringify(fwd).includes('[[c-thru-agent:'),
      'unsigned marker: upstream body stripped');
    assertEq(r.headers['x-c-thru-agent-identity'], 'none', 'agent-identity header');
    const status = await httpJson(port, 'GET', '/c-thru/status');
    assertEq(status.status, 200, '/c-thru/status 200');
    const byAgent = status.json?.usage?.by_agent || {};
    assert(!Object.prototype.hasOwnProperty.call(byAgent, AGENT), `by_agent excludes rejected ${AGENT}`);
  });

  console.log('\n2. legacy :16hex suffix fails closed');
  await withSentinelProxy({}, async ({ port, agentStub, defaultStub }) => {
    const r = await httpJson(port, 'POST', '/v1/messages',
      bodyWith(`${legacyMarker(AGENT)}\nreview`), agentHeaders());
    assertEq(r.status, 200, 'legacy peel: 200');
    assertEq(r.headers['x-c-thru-served-by'], DEFAULT_MODEL, 'legacy peel: served-by default model');
    assert(agentStub.requests.length === 0, 'legacy peel: agent stub not hit');
  });

  console.log('\n3. signed x-c-thru-agent header → routes without body marker');
  await withSentinelProxy({}, async ({ port, agentStub }) => {
    const r = await httpJson(port, 'POST', '/v1/messages',
      { model: DEFAULT_MODEL, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] },
      { ...agentHeaders(), 'x-c-thru-agent': AGENT, 'x-c-thru-agent-signature': computeAgentSentinelTag(AGENT, SENTINEL_SECRET) });
    assertEq(r.status, 200, 'header: 200');
    assertEq(r.headers['x-c-thru-served-by'], AGENT_MODEL, 'header: served-by');
    assertEq(r.headers['x-c-thru-agent-identity'], 'header', 'header identity');
    assert(agentStub.requests.length === 1, 'header: agent stub hit');
  });

  console.log('\n4. two sentinels → last match wins; body clean');
  await withSentinelProxy({}, async ({ port, agentStub }) => {
    const body = {
      model: DEFAULT_MODEL,
      max_tokens: 5,
      messages: [
        { role: 'user', content: `${marker('coder')}\nold task` },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: `${marker(AGENT)}\nnew task` },
      ],
    };
    const r = await httpJson(port, 'POST', '/v1/messages', body, agentHeaders());
    assertEq(r.status, 200, 'last-match: 200');
    assertEq(r.headers['x-c-thru-served-by'], AGENT_MODEL, 'last-match: agent model');
    const fwd = agentStub.requests[0] && agentStub.requests[0].body;
    assert(fwd && !JSON.stringify(fwd).includes('[[c-thru-agent:'), 'last-match: stripped');
  });

  console.log('\n5. concrete model id sentinel');
  await withSentinelProxy({}, async ({ port, agentStub, defaultStub }) => {
    const r = await httpJson(port, 'POST', '/v1/messages', bodyWith(`${marker(AGENT_MODEL)}\npin`), agentHeaders());
    assertEq(r.status, 200, 'model-id: 200');
    assertEq(r.headers['x-c-thru-served-by'], AGENT_MODEL, 'model-id: served-by');
    assert(agentStub.requests.length === 1, 'model-id: agent stub');
    assert(defaultStub.requests.length === 0, 'model-id: not default');
  });

  console.log('\n6. no marker → body.model');
  await withSentinelProxy({}, async ({ port, agentStub, defaultStub }) => {
    const r = await httpJson(port, 'POST', '/v1/messages', bodyWith('plain prompt'));
    assertEq(r.status, 200, 'no marker: 200');
    assertEq(r.headers['x-c-thru-served-by'], DEFAULT_MODEL, 'no marker: default');
    assert(defaultStub.requests.length === 1, 'no marker: default stub');
    assert(agentStub.requests.length === 0, 'no marker: no agent stub');
    assertEq(r.headers['x-c-thru-agent-identity'], 'none', 'identity none');
  });

  // Unroutable marker (unknown agent name, no capability / model_routes): keep
  // body.model. Do not invent a model that would hit Ollama-fallback 400.
  console.log('\n7. unroutable sentinel → keep default model (no override)');
  await withSentinelProxy({}, async ({ port, agentStub, defaultStub }) => {
    const r = await httpJson(port, 'POST', '/v1/messages',
      bodyWith(`${marker('totally-unknown-agent-xyz')}\nhi`), agentHeaders());
    assertEq(r.status, 200, 'unroutable: 200');
    assertEq(r.headers['x-c-thru-served-by'], DEFAULT_MODEL, 'unroutable: default model');
    assert(defaultStub.requests.length === 1, 'unroutable: default stub hit');
    assert(agentStub.requests.length === 0, 'unroutable: agent stub not hit');
    assertEq(r.headers['x-c-thru-agent-identity'], 'none', 'unroutable: identity none');
    const fwd = defaultStub.requests[0] && defaultStub.requests[0].body;
    assert(fwd && !JSON.stringify(fwd).includes('[[c-thru-agent:'),
      'unroutable: marker still stripped from upstream body');
  });

  // Source-code poison (${lookup_key}) is rejected by parseAgentSentinel; same
  // "keep default" outcome as unroutable, even when a prior valid marker exists
  // later in history as the last *invalid* match.
  console.log('\n8. poison ${lookup_key} ignored → keep default when sole marker');
  await withSentinelProxy({}, async ({ port, agentStub, defaultStub }) => {
    const r = await httpJson(port, 'POST', '/v1/messages',
      bodyWith('tool_result: sentinel="[[c-thru-agent:${lookup_key}]]"$'));
    assertEq(r.status, 200, 'poison-only: 200');
    assertEq(r.headers['x-c-thru-served-by'], DEFAULT_MODEL, 'poison-only: default model');
    assert(defaultStub.requests.length === 1, 'poison-only: default stub');
    assert(agentStub.requests.length === 0, 'poison-only: no agent stub');
  });

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
