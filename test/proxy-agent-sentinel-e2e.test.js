#!/usr/bin/env node
'use strict';
// P0 — agent-sentinel end-to-end through a LIVE proxy (C19 anti-spoof on the wire).
//
// proxy-sentinel-detection.test.js exercises the PURE parser + a hand-copied
// trustBodyMarker mirror. This suite drives the REAL claude-proxy path: it sends
// a genuine [[c-thru-agent:<name>:<hmac16>]] marker in the FIRST user message of a
// POST /v1/messages body and asserts the proxy's actual handshake — HMAC verify,
// agent→capability override of body.model, the resolved-via/served-by headers,
// and the by_agent attribution surfaced by /c-thru/status.
//
// Observability trick: two DISTINCT stub backends and two distinct models. The
// request body always carries model:'default-model' (→ defaultStub). A trusted
// sentinel REWRITES body.model to the agent name, which resolves
//   reviewer-plan → cap plan-reviewer → agent-model → agentStub.
// So "the override happened" is provable by WHICH stub got hit + x-c-thru-served-by,
// not by reading a log. (Logs are also asserted where the harness captures them.)
//
// The HMAC is computed in-test the SAME way the hook does
//   crypto.createHmac('sha256', key).update(name).digest('hex').slice(0,16)
// against a temp key file the spawned proxy is pointed at via the existing
// CLAUDE_PROXY_AGENT_HMAC_FILE override (tools/claude-proxy:320). No source change
// was needed — that override already mirrors CLAUDE_PROXY_CONTROL_TOKEN_FILE.
//
// Run: node test/proxy-agent-sentinel-e2e.test.js

const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { assert, assertEq, summary, withProxy, httpJson, stubBackend, collectStderr } = require('./helpers');

console.log('proxy agent-sentinel e2e (live proxy, C19 anti-spoof handshake)\n');

const AGENT        = 'reviewer-plan';      // the delegated subagent name in the marker
const CAPABILITY   = 'plan-reviewer';      // what the agent maps to
const AGENT_MODEL  = 'agent-model';        // model the capability resolves to → agentStub
const DEFAULT_MODEL = 'default-model';     // the hook's don't-block fallback alias → defaultStub
const KEY          = 'deadbeef'.repeat(8); // 64-hex stand-in for the per-user agent-hmac.key
const MODE         = 'best-cloud';
const TIER         = '16gb';

// Mirror the hook (tools/c-thru-agent-router-hook.sh agent_hmac_tag) + the proxy
// (tools/claude-proxy expectedAgentTag): first 16 hex of HMAC-SHA256(key, name).
function expectedTag(key, name) {
  return crypto.createHmac('sha256', key).update(name).digest('hex').slice(0, 16);
}

// Fixture: agent→capability→model, plus a distinguishable DEFAULT model on a
// SEPARATE backend so a successful sentinel override is observable.
function mkConfig(agentStubPort, defaultStubPort) {
  return {
    agent_to_capability: { [AGENT]: CAPABILITY },
    llm_profiles: {
      // capability-outer (new schema): plan-reviewer → agent-model at this mode/tier
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

// A first-user-message body carrying `markerContent` as the message text, with
// body.model = DEFAULT_MODEL (the unprivileged alias the hook would otherwise leave).
function bodyWith(markerContent, extraMessages = []) {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 5,
    messages: [{ role: 'user', content: markerContent }, ...extraMessages],
  };
}

function marker(name, tag) {
  return tag ? `[[c-thru-agent:${name}:${tag}]]` : `[[c-thru-agent:${name}]]`;
}

// Spawn a proxy with the key-file override (or omit it to prove fail-open) and
// run fn against fresh stubs. Returns nothing; assertions live in fn.
async function withSentinelProxy({ keyFile, logFile }, fn) {
  const agentStub   = await stubBackend();
  const defaultStub = await stubBackend();
  const configRoot  = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-sentinel-cfg-'));
  const configPath  = path.join(configRoot, 'model-map.json');
  fs.writeFileSync(configPath, JSON.stringify(mkConfig(agentStub.port, defaultStub.port)));
  const env = { CLAUDE_LLM_MODE: MODE };
  if (keyFile) env.CLAUDE_PROXY_AGENT_HMAC_FILE = keyFile;
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-sentinel-e2e-'));
  const keyFile = path.join(tmpRoot, 'agent-hmac.key');
  fs.writeFileSync(keyFile, KEY, { mode: 0o600 });

  try {
    // ── 1. SIGNED valid marker + key present → routes to the agent ────────────
    console.log('1. signed valid marker + key present → agent capability/model wins');
    await withSentinelProxy({ keyFile }, async ({ port, agentStub, defaultStub }) => {
      const tag = expectedTag(KEY, AGENT);
      const r = await httpJson(port, 'POST', '/v1/messages', bodyWith(`${marker(AGENT, tag)}\nreview this plan`));
      assertEq(r.status, 200, 'signed marker: request succeeds (200)');

      // served-by reflects the AGENT's model, not the body's default model.
      assertEq(r.headers['x-c-thru-served-by'], AGENT_MODEL,
        `signed marker: x-c-thru-served-by === '${AGENT_MODEL}' (override, not '${DEFAULT_MODEL}')`);

      let via = null;
      try { via = JSON.parse(r.headers['x-c-thru-resolved-via'] || 'null'); } catch {}
      assert(via && typeof via === 'object', 'signed marker: x-c-thru-resolved-via present + valid JSON');
      assertEq(via && via.capability, AGENT,
        `signed marker: resolved-via.capability === '${AGENT}' (agent, not bare capability)`);
      assertEq(via && via.served_by, AGENT_MODEL, `signed marker: resolved-via.served_by === '${AGENT_MODEL}'`);

      // The AGENT stub was hit; the DEFAULT stub was NOT.
      assert(agentStub.requests.length === 1, `signed marker: agent stub hit once (got ${agentStub.requests.length})`);
      assert(defaultStub.requests.length === 0, `signed marker: default stub NOT hit (got ${defaultStub.requests.length})`);

      // /c-thru/status by_agent attributes usage to the agent NAME (not just the capability/model).
      const status = await httpJson(port, 'GET', '/c-thru/status');
      assertEq(status.status, 200, 'signed marker: /c-thru/status reachable (200)');
      const byAgent = status.json?.usage?.by_agent || {};
      assert(Object.prototype.hasOwnProperty.call(byAgent, AGENT),
        `signed marker: /c-thru/status usage.by_agent has '${AGENT}'`);
      const servedBy = byAgent[AGENT] && byAgent[AGENT].served_by || {};
      assert(Object.prototype.hasOwnProperty.call(servedBy, AGENT_MODEL),
        `signed marker: by_agent['${AGENT}'].served_by has '${AGENT_MODEL}'`);
    });

    // ── 2. UNSIGNED marker + key present → rejected (routes by body.model) ─────
    console.log('\n2. unsigned marker + key present → REJECTED, falls back to body.model');
    const logUnsigned = path.join(tmpRoot, 'unsigned.log');
    await withSentinelProxy({ keyFile, logFile: logUnsigned }, async ({ port, agentStub, defaultStub }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', bodyWith(`${marker(AGENT)}\nreview this plan`));
      assertEq(r.status, 200, 'unsigned marker: request succeeds (200)');
      // No override → body.model (default-model) drives routing → default stub.
      assertEq(r.headers['x-c-thru-served-by'], DEFAULT_MODEL,
        `unsigned marker: x-c-thru-served-by === '${DEFAULT_MODEL}' (NOT force-routed to agent)`);
      assert(defaultStub.requests.length === 1, `unsigned marker: default stub hit (got ${defaultStub.requests.length})`);
      assert(agentStub.requests.length === 0, `unsigned marker: agent stub NOT force-routed (got ${agentStub.requests.length})`);

      let logText = '';
      try { logText = fs.readFileSync(logUnsigned, 'utf8'); } catch {}
      assert(/sentinel_rejected/.test(logText) && /unsigned/.test(logText),
        'unsigned marker: sentinel_rejected{reason:unsigned} logged');
    });

    // ── 3a. FORGED marker — wrong HMAC for the name → rejected ────────────────
    console.log('\n3a. forged marker (wrong hmac) + key present → REJECTED');
    const logForged = path.join(tmpRoot, 'forged.log');
    await withSentinelProxy({ keyFile, logFile: logForged }, async ({ port, agentStub, defaultStub }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', bodyWith(`${marker(AGENT, '0000000000000000')}\ngo`));
      assertEq(r.status, 200, 'forged marker: request succeeds (200)');
      assertEq(r.headers['x-c-thru-served-by'], DEFAULT_MODEL,
        `forged marker: x-c-thru-served-by === '${DEFAULT_MODEL}' (timingSafeEqual fails)`);
      assert(agentStub.requests.length === 0, `forged marker: agent stub NOT hit (got ${agentStub.requests.length})`);
      assert(defaultStub.requests.length === 1, `forged marker: default stub hit (got ${defaultStub.requests.length})`);

      let logText = '';
      try { logText = fs.readFileSync(logForged, 'utf8'); } catch {}
      assert(/sentinel_rejected/.test(logText) && /hmac_mismatch/.test(logText),
        'forged marker: sentinel_rejected{reason:hmac_mismatch} logged');
    });

    // ── 3b. FORGED marker — valid HMAC but for a DIFFERENT name → rejected ─────
    console.log('\n3b. tag valid for a DIFFERENT name + key present → REJECTED (tag binds to name)');
    await withSentinelProxy({ keyFile }, async ({ port, agentStub, defaultStub }) => {
      const tagForOther = expectedTag(KEY, 'some-other-agent'); // valid HMAC, wrong name
      const r = await httpJson(port, 'POST', '/v1/messages', bodyWith(`${marker(AGENT, tagForOther)}\ngo`));
      assertEq(r.status, 200, 'name-bound forgery: request succeeds (200)');
      assertEq(r.headers['x-c-thru-served-by'], DEFAULT_MODEL,
        `name-bound forgery: served-by === '${DEFAULT_MODEL}' (HMAC binds tag to name)`);
      assert(agentStub.requests.length === 0, `name-bound forgery: agent stub NOT hit (got ${agentStub.requests.length})`);
    });

    // ── 4. Marker present but KEY ABSENT → fail-open: marker honored ───────────
    console.log('\n4. marker present + key ABSENT → FAIL-OPEN (unsigned marker honored — posture proof)');
    const logFailOpen = path.join(tmpRoot, 'failopen.log');
    await withSentinelProxy({ keyFile: null, logFile: logFailOpen }, async ({ port, agentStub, defaultStub }) => {
      // No key file → unsigned marker is honored (today's documented behavior).
      const r = await httpJson(port, 'POST', '/v1/messages', bodyWith(`${marker(AGENT)}\ngo`));
      assertEq(r.status, 200, 'key absent: request succeeds (200)');
      assertEq(r.headers['x-c-thru-served-by'], AGENT_MODEL,
        `key absent: x-c-thru-served-by === '${AGENT_MODEL}' (fail-open honors unsigned marker)`);
      assert(agentStub.requests.length === 1, `key absent: agent stub hit (got ${agentStub.requests.length})`);
      assert(defaultStub.requests.length === 0, `key absent: default stub NOT hit (got ${defaultStub.requests.length})`);

      let logText = '';
      try { logText = fs.readFileSync(logFailOpen, 'utf8'); } catch {}
      assert(/sentinel\.auth_disabled/.test(logText) && /UNVERIFIED/.test(logText),
        'key absent: prominent fail-open warning (sentinel.auth_disabled / UNVERIFIED) logged');
    });

    // ── 5a. Valid HMAC but marker NOT at the first message → still honored ─────
    console.log('\n5a. valid HMAC, marker NOT at first-message position → still honored (HMAC is the trust boundary)');
    await withSentinelProxy({ keyFile }, async ({ port, agentStub, defaultStub }) => {
      const tag = expectedTag(KEY, AGENT);
      // Marker rides in a LATER user message after a benign first message.
      const r = await httpJson(port, 'POST', '/v1/messages', bodyWith(
        'an ordinary first message with no marker',
        [{ role: 'assistant', content: 'ok' }, { role: 'user', content: `${marker(AGENT, tag)} review` }],
      ));
      assertEq(r.status, 200, 'mid-body signed marker: request succeeds (200)');
      assertEq(r.headers['x-c-thru-served-by'], AGENT_MODEL,
        `mid-body signed marker: served-by === '${AGENT_MODEL}' (position is not the gate; HMAC is)`);
      assert(agentStub.requests.length === 1, `mid-body signed marker: agent stub hit (got ${agentStub.requests.length})`);
    });

    // ── 5b. UNSIGNED marker mid-body + key present → rejected ──────────────────
    console.log('\n5b. unsigned marker mid-body + key present → REJECTED');
    await withSentinelProxy({ keyFile }, async ({ port, agentStub, defaultStub }) => {
      const r = await httpJson(port, 'POST', '/v1/messages', bodyWith(
        'an ordinary first message',
        [{ role: 'assistant', content: 'ok' }, { role: 'user', content: `${marker(AGENT)} review` }],
      ));
      assertEq(r.status, 200, 'mid-body unsigned marker: request succeeds (200)');
      assertEq(r.headers['x-c-thru-served-by'], DEFAULT_MODEL,
        `mid-body unsigned marker: served-by === '${DEFAULT_MODEL}' (rejected)`);
      assert(defaultStub.requests.length === 1, `mid-body unsigned marker: default stub hit (got ${defaultStub.requests.length})`);
      assert(agentStub.requests.length === 0, `mid-body unsigned marker: agent stub NOT hit (got ${agentStub.requests.length})`);
    });
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
