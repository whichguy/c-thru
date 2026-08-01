#!/usr/bin/env node
'use strict';
// Live Claude Code -> Agent tool -> signed marker -> c-thru proxy route proof.
//
// The hermetic sentinel suites can prove the proxy's trust matrix with synthetic
// headers, while the offload scorecard can prove that Claude selected an Agent.
// Neither alone proves that a real Claude Code spawn supplies the gateway headers
// c-thru expects or that the selected agent reaches its configured backend. This
// test correlates the real stream-json Agent event with sentinel_override and
// dispatch records from a fresh per-run proxy log.
//
// Guard: C_THRU_LIVE_CLAUDE_AGENT_ROUTE=1

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { deriveAuthProfile } = require('../tools/model-map-resolve.js');
const {
  assert,
  assertEq,
  ensureModelTestSupervisor,
  summary,
  modelTestTimeoutMs,
  modelTestProxyEnv,
} = require('./helpers');
if (require.main === module) ensureModelTestSupervisor();
const { emitLiveOutcome } = require('./provider-live-prerequisites');

const LIVE_PROVIDER = 'agent';
const LIVE_SUITE = 'claude-agent-route-live';
let outcomeEmitted = false;

function finish(status, reason, exitCode = status === 'failed' ? 1 : 0) {
  if (!outcomeEmitted) {
    outcomeEmitted = true;
    emitLiveOutcome(LIVE_PROVIDER, LIVE_SUITE, status, reason);
  }
  process.exit(exitCode);
}

if (require.main === module) {
  process.once('exit', code => {
    if (outcomeEmitted) return;
    process.exitCode = 1;
    outcomeEmitted = true;
    emitLiveOutcome(LIVE_PROVIDER, LIVE_SUITE, 'failed', `missing_terminal_outcome_exit_${code}`);
  });
}

if (require.main === module && process.env.C_THRU_LIVE_CLAUDE_AGENT_ROUTE !== '1') {
  console.log('SKIP  claude-agent-route-live: set C_THRU_LIVE_CLAUDE_AGENT_ROUTE=1');
  finish('skipped', 'gate_not_enabled');
}

const REPO = path.resolve(__dirname, '..');
const C_THRU = path.join(REPO, 'tools', 'c-thru');
const CHECKOUT_MODEL_MAP = path.join(REPO, 'config', 'model-map.json');
const activeModelMap = JSON.parse(fs.readFileSync(CHECKOUT_MODEL_MAP, 'utf8'));
const MODE = process.env.C_THRU_AGENT_ROUTE_MODE || 'best-cloud-oss';
const MEMORY_GB = process.env.C_THRU_AGENT_ROUTE_MEMORY_GB || '128';
const AGENT = process.env.C_THRU_AGENT_ROUTE_AGENT || 'coder';
const EXPECTED_TEXT = 'LIVE_AGENT_ROUTE_OK';
const TIMEOUT_MS = modelTestTimeoutMs();

const LIVE_RUNTIME_ENV_KEYS = Object.freeze([
  'PATH',
  'SHELL',
  'USER',
  'LOGNAME',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'CI',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'no_proxy',
]);
const NETWORK_PROXY_ENV_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
]);
const LIVE_C_THRU_CONTROL_ENV_KEYS = Object.freeze([
  'CLAUDE_LLM_MODE',
  'CLAUDE_LLM_PROFILE',
  'CLAUDE_LLM_MEMORY_GB',
  'CLAUDE_CONNECTIVITY_MODE',
  'CLAUDE_LLM_CONNECTIVITY_MODE',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY',
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  'C_THRU_DEBUG',
  'CLAUDE_PROXY_DEBUG',
  'C_THRU_NO_BENCHMARK_UPDATE',
  'C_THRU_NO_OAUTH_INJECT',
  'C_THRU_NO_STATUSLINE',
  'C_THRU_OLLAMA_AUTOSTART',
  'C_THRU_SKIP_INFO_INJECTION',
  'C_THRU_SKIP_PREFLIGHT',
  'C_THRU_SKIP_PREPULL',
  'OLLAMA_BASE_URL',
  'OLLAMA_URL',
  'OLLAMA_HOST',
]);
const CLAUDE_AUTH_ENV_KEYS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const ENDPOINT_COORDINATE_ENV_KEYS = new Set([
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_REGION',
]);

function activeProviderEnvKeys(modelMap) {
  const keys = new Set();
  const endpoints = modelMap.endpoints || modelMap.backends || {};
  for (const [id, endpoint] of Object.entries(endpoints)) {
    if (!endpoint || typeof endpoint !== 'object') continue;

    const explicitAuthEnv = typeof endpoint.auth_env === 'string'
      ? endpoint.auth_env
      : typeof endpoint.auth?.env === 'string'
        ? endpoint.auth.env
        : null;
    if (explicitAuthEnv && ENV_NAME_RE.test(explicitAuthEnv)) {
      keys.add(explicitAuthEnv);
    } else if (endpoint.auth !== 'none' && endpoint.auth !== 'subscription') {
      const derived = deriveAuthProfile(endpoint);
      if (derived?.env && ENV_NAME_RE.test(derived.env)) keys.add(derived.env);
    }

    if (
      /ollama/i.test(id) ||
      endpoint.kind === 'ollama' ||
      endpoint.format === 'ollama' ||
      endpoint.format === 'ollama-legacy'
    ) {
      keys.add('OLLAMA_API_KEY');
    }

    if (typeof endpoint.url === 'string') {
      for (const match of endpoint.url.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) {
        if (ENDPOINT_COORDINATE_ENV_KEYS.has(match[1])) keys.add(match[1]);
      }
    }
  }
  return Object.freeze([...keys]);
}

const ACTIVE_PROVIDER_ENV_KEYS = activeProviderEnvKeys(activeModelMap);

function isCredentialFreeProxyUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

function allowedLiveEnv() {
  const env = {};
  const keys = new Set([
    ...LIVE_RUNTIME_ENV_KEYS,
    ...LIVE_C_THRU_CONTROL_ENV_KEYS,
    ...CLAUDE_AUTH_ENV_KEYS,
    ...ACTIVE_PROVIDER_ENV_KEYS,
  ]);
  for (const key of keys) {
    if (Object.hasOwn(process.env, key)) env[key] = process.env[key];
  }
  for (const key of NETWORK_PROXY_ENV_KEYS) {
    if (isCredentialFreeProxyUrl(process.env[key])) env[key] = process.env[key];
  }
  return env;
}

let claudeBin = process.env.CLAUDE_BIN || '';
if (!claudeBin) {
  try {
    claudeBin = execFileSync('/bin/sh', ['-c', 'command -v claude'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    claudeBin = '';
  }
}
if (require.main === module && (!claudeBin || !fs.existsSync(C_THRU))) {
  console.log('SKIP  claude-agent-route-live: real claude binary or tools/c-thru unavailable');
  finish('skipped', !claudeBin ? 'missing_claude_binary' : 'missing_tools_c-thru');
}

function cleanLiveEnv(scratch, proxyLog, selectedClaudeBin = claudeBin) {
  const profileDir = path.join(scratch, 'claude-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const env = Object.assign(allowedLiveEnv(), modelTestProxyEnv(TIMEOUT_MS), {
    C_THRU_NO_UPDATE: '1',
    C_THRU_NO_MARKETPLACE_UPDATE: '1',
    C_THRU_KEEP_PROXY: '0',
    C_THRU_PROXY_ALWAYS: '1',
    C_THRU_BRAND_REUSE_GATEWAY_PROXY: '0',
    CLAUDE_BIN: selectedClaudeBin,
    CLAUDE_CONFIG_DIR: profileDir,
    CLAUDE_DIR: profileDir,
    CLAUDE_PROFILE_DIR: profileDir,
    CLAUDE_LLM_MODE: MODE,
    CLAUDE_LLM_MEMORY_GB: MEMORY_GB,
    CLAUDE_MODEL_MAP_LAUNCH_CWD: scratch,
    CLAUDE_MODEL_MAP_PATH: CHECKOUT_MODEL_MAP,
    CLAUDE_PROXY_LOG_FILE: proxyLog,
  });
  // Installed profiles and ambient proxy selectors must not decide which
  // checkout, model map, proxy process, subagent model, or watchdogs this proof
  // exercises.
  for (const key of [
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_MODEL_MAP_DEFAULTS_PATH',
    'CLAUDE_MODEL_MAP_OVERRIDES_PATH',
    'CLAUDE_MODEL_MAP_SYNC_STATE_FILE',
    'CLAUDE_PROXY_BIND_ADDR',
    'CLAUDE_PROXY_BYPASS',
    'CLAUDE_PROXY_PORT',
    'CLAUDE_PROXY_READY_TIMEOUT_SECONDS',
    'CLAUDE_PROXY_USE_OLLAMA_PORT',
    'CLAUDE_ROUTER_SKIP_PROXY_AUTOSTART',
    'C_THRU_SKIP_PROXY_AUTOSTART',
    'PROXY_PORT',
  ]) {
    delete env[key];
  }
  return env;
}

function parseStreamJson(text) {
  const events = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // c-thru's human routing preamble is stderr; tolerate any future
      // non-JSON stdout diagnostics without using grep as the assertion.
    }
  }
  return events;
}

function findAgentToolUse(events, agent) {
  for (const event of events) {
    if (event?.type !== 'assistant' || !Array.isArray(event?.message?.content)) continue;
    const block = event.message.content.find((candidate) =>
      candidate?.type === 'tool_use' &&
      candidate?.name === 'Agent' &&
      candidate?.input?.subagent_type === agent);
    if (block) return { event, block };
  }
  return null;
}

function forwardedSubagentText(events, parentToolUseId) {
  if (!parentToolUseId) return '';
  return events
    .filter((event) =>
      event?.type === 'assistant' &&
      event?.parent_tool_use_id === parentToolUseId &&
      Array.isArray(event?.message?.content))
    .flatMap((event) => event.message.content)
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function parseProxyLog(file) {
  const events = [];
  const eventRe = /\bc-thru \[([^\]]+)\] (\{.*\})$/;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(eventRe);
    if (!match) continue;
    try {
      events.push({ event: match[1], data: JSON.parse(match[2]) });
    } catch {
      // A malformed structured proxy line is simply not usable evidence.
    }
  }
  return events;
}

function explainExpected(env, scratch) {
  const result = spawnSync('bash', [
    C_THRU,
    'explain',
    '--agent', AGENT,
    '--mode', MODE,
    '--tier', `${MEMORY_GB}gb`,
  ], {
    cwd: scratch,
    env,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  assertEq(result.status, 0, 'explain: expected route resolves');
  const servedBy = String(result.stdout || '').match(/^\s*served_by\s+(\S+)/m)?.[1] || null;
  const backendId = String(result.stdout || '').match(/^\s*backend_id\s+(\S+)/m)?.[1] || null;
  assert(!!servedBy, 'explain: served_by captured');
  assert(!!backendId, 'explain: backend_id captured');
  return { servedBy, backendId };
}

function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-live-agent-route-'));
  const proxyLog = path.join(scratch, 'proxy.log');
  const env = cleanLiveEnv(scratch, proxyLog);

  try {
    const expected = explainExpected(env, scratch);
    console.log(
      `claude-agent-route-live: agent=${AGENT} expected=${expected.servedBy} ` +
      `backend=${expected.backendId} timeout=${TIMEOUT_MS}ms\n`,
    );

    const prompt = [
      `Use the ${AGENT} subagent through the Agent tool now.`,
      `Ask it to answer exactly and only ${EXPECTED_TEXT}.`,
      'Wait for it, then return its answer.',
    ].join(' ');
    const result = spawnSync('bash', [
      C_THRU,
      '-p', prompt,
      '--output-format', 'stream-json',
      '--forward-subagent-text',
      '--verbose',
    ], {
      cwd: scratch,
      env,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });

    assert(!result.error || result.error.code !== 'ETIMEDOUT',
      `real Claude route probe completes within ${TIMEOUT_MS}ms`);
    assertEq(result.status, 0,
      `real Claude route probe exits 0${result.stderr ? ` (stderr tail: ${result.stderr.split('\n').slice(-3).join(' | ')})` : ''}`);

    const stream = parseStreamJson(result.stdout);
    const agentCall = findAgentToolUse(stream, AGENT);
    assert(!!agentCall, `stream-json: Claude invoked Agent(${AGENT})`);
    const agentToolUseId = agentCall?.block?.id;
    assert(typeof agentToolUseId === 'string' && agentToolUseId.length > 0,
      `stream-json: Agent(${AGENT}) tool_use has a correlation ID`);

    // Claude Code 2.1.220 forwards subagent text as ordinary assistant events.
    // Their documented linkage is top-level parent_tool_use_id → Agent tool_use
    // id; forwarded events do not carry a reliable top-level subagent_type.
    const agentText = forwardedSubagentText(stream, agentToolUseId);
    assert(agentText.includes(EXPECTED_TEXT),
      `stream-json: Agent(${AGENT}) returned the probe token through parent_tool_use_id`);

    assert(fs.existsSync(proxyLog), 'proxy: fresh per-run structured log exists');
    const proxyEvents = parseProxyLog(proxyLog);
    const override = proxyEvents.find((entry) =>
      entry.event === 'sentinel_override' && entry.data?.agent === AGENT);
    assert(!!override, `proxy: accepted signed sentinel_override for ${AGENT}`);
    assert(/^h1:[0-9a-f]{32}$/.test(override?.data?.agent_ref || ''),
      'proxy: real Claude Code agent ID captured as a bounded HMAC reference');
    assert(!Object.prototype.hasOwnProperty.call(override?.data || {}, 'agent_id'),
      'proxy: structured log does not expose the raw Claude Code agent ID');
    assertEq(override?.data?.nested, false,
      'proxy: first-level agent has no parent-agent ID');

    const dispatch = proxyEvents.find((entry) =>
      entry.event === 'dispatch' && entry.data?.req_id === override?.data?.req_id);
    assert(!!dispatch, 'proxy: sentinel override correlates to dispatch by req_id');
    assertEq(dispatch?.data?.incoming_model, AGENT,
      `proxy: trusted marker changes the logical incoming model to ${AGENT}`);
    assertEq(dispatch?.data?.logical_role, AGENT,
      `proxy: dispatch records logical role ${AGENT}`);
    assertEq(dispatch?.data?.resolved_model, expected.servedBy,
      'proxy: dispatch reaches the model predicted by c-thru explain');
    assertEq(dispatch?.data?.backend_id, expected.backendId,
      'proxy: dispatch reaches the backend predicted by c-thru explain');

    const rejected = proxyEvents.find((entry) =>
      entry.event === 'sentinel_rejected' && entry.data?.req_id === override?.data?.req_id);
    assert(!rejected, 'proxy: accepted route has no sentinel_rejected event');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const failed = summary();
  finish(
    failed ? 'failed' : 'passed',
    failed ? `${failed}_assertions_failed` : 'all_mandatory_contracts_exercised',
    failed ? 1 : 0,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack || err);
    finish('failed', err?.code || err?.message || 'uncaught_error');
  }
}

module.exports = {
  ACTIVE_PROVIDER_ENV_KEYS,
  CHECKOUT_MODEL_MAP,
  C_THRU,
  cleanLiveEnv,
  findAgentToolUse,
  forwardedSubagentText,
  parseStreamJson,
};
