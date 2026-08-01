#!/usr/bin/env node
'use strict';
// Live contract test — reads each agent's system prompt, POSTs to a managed proxy,
// and validates the current TASK_STATUS / recusal contract in the response.
// Tests routing AND prompt behavior without spawning a stub backend. The test
// owns the proxy so its upstream watchdogs share the same wide model-call cap.
//
// Guard: set C_THRU_LIVE_AGENT_TESTS=1 to enable.
// Run: C_THRU_LIVE_AGENT_TESTS=1 node test/agent-contract-live.test.js

const fs   = require('fs');
const http = require('http');
const path = require('path');
const {
  ensureModelTestSupervisor,
  parseAgentContractResult,
  modelTestTimeoutMs,
  withModelTestProxy,
} = require('./helpers');
if (require.main === module) ensureModelTestSupervisor();
const {
  AGENT_CONTRACT_CASES,
  AGENT_CONTRACT_MAX_TOKENS,
  STRUCTURED_AGENTS,
  boundedResponseTail,
  formatContractFailureDiagnostics,
  preflightAgentContracts,
  universalNormalRecusalError,
  validateContractCase,
  validateContractResponseIntegrity,
} = require('./agent-contract-fixtures');
const { emitLiveOutcome } = require('./provider-live-prerequisites');

const LIVE_PROVIDER = 'agent';
const LIVE_SUITE = 'agent-contract-live';
let outcomeEmitted = false;

function finish(status, reason, exitCode = status === 'failed' ? 1 : 0) {
  if (!outcomeEmitted) {
    outcomeEmitted = true;
    emitLiveOutcome(LIVE_PROVIDER, LIVE_SUITE, status, reason);
  }
  process.exit(exitCode);
}

process.once('exit', code => {
  if (outcomeEmitted) return;
  process.exitCode = 1;
  outcomeEmitted = true;
  emitLiveOutcome(LIVE_PROVIDER, LIVE_SUITE, 'failed', `missing_terminal_outcome_exit_${code}`);
});

if (process.env.C_THRU_LIVE_AGENT_TESTS !== '1') {
  console.log('agent-contract-live: skip (set C_THRU_LIVE_AGENT_TESTS=1 to enable)');
  finish('skipped', 'gate_not_enabled');
}

const REPO_ROOT  = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const MODEL_MAP = process.env.CLAUDE_MODEL_MAP_PATH ||
  path.join(REPO_ROOT, 'config', 'model-map.json');
const PER_AGENT_TIMEOUT_MS = modelTestTimeoutMs();

const PROXY_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_TOKEN',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_REGION', 'OPENAI_API_KEY',
  'OPENROUTER_API_KEY', 'XAI_API_KEY', 'OLLAMA_API_KEY', 'OLLAMA_URL',
];

function managedProxyEnv() {
  const env = {
    ANTHROPIC_BASE_URL: '',
    CLAUDE_PROXY_URL: '',
    CLAUDE_PROXY_PORT: '',
    PROXY_PORT: '',
  };
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

let passed           = 0;
let failed           = 0;
let skippedExpected  = 0;
let skippedUnexpected = 0;

function ok(label) {
  console.log(`  ok    ${label}`);
  passed++;
}

function fail(label, reason) {
  console.error(`  FAIL  ${label}`);
  if (reason) console.error(`        ${reason}`);
  failed++;
}

function skipExpected(label, reason) {
  console.log(`  skip  ${label}${reason ? ' — ' + reason : ''} (expected)`);
  skippedExpected++;
}

function skipUnexpected(label, reason) {
  console.log(`  SKIP! ${label}${reason ? ' — ' + reason : ''} (UNEXPECTED)`);
  skippedUnexpected++;
}

function postMessages(host, port, body, timeoutMs = PER_AGENT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request(
      {
        hostname: host,
        port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          'Authorization':  `Bearer ${process.env.ANTHROPIC_API_KEY || 'live-test'}`,
        },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(bodyText); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, bodyText });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Agent file helpers ────────────────────────────────────────────────────────

function stripFrontmatter(content) {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
}

function readSystemPrompt(agentName) {
  const p = path.join(AGENTS_DIR, `${agentName}.md`);
  if (!fs.existsSync(p)) return null;
  return stripFrontmatter(fs.readFileSync(p, 'utf8'));
}

// ── Validation helpers ────────────────────────────────────────────────────────

function validateContractResult(entry, result, text, response) {
  const label = `${entry.caseId} (${entry.agent})`;
  const errors = [
    ...validateContractResponseIntegrity(response),
    ...validateContractCase(entry, result, text, { checkBehavior: false }),
  ];
  if (errors.length > 0) {
    fail(
      `${label}: contract assertion failed`,
      `${errors.join('; ')}; ${formatContractFailureDiagnostics(response, text)}`,
    );
  } else {
    ok(`${label}: ${result.kind === 'task' ? 'TASK_STATUS' : 'STATUS'}=${result.status}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runContracts(host, port, roster) {
  const observations = [];
  for (const entry of roster) {
    const { caseId, agent, expectedCapability, userMessage } = entry;
    const label = `${caseId} (${agent})`;

    const systemPrompt = readSystemPrompt(agent);
    if (!systemPrompt) {
      fail(`${label}: agent file disappeared after preflight`);
      continue;
    }

    const timeout = PER_AGENT_TIMEOUT_MS;
    process.stdout.write(`  [${label}] … `);
    let res;
    try {
      res = await postMessages(host, port, {
        model:      agent,
        max_tokens: AGENT_CONTRACT_MAX_TOKENS,
        stream:     false,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userMessage }],
      }, timeout);
    } catch (e) {
      console.log('');
      skipUnexpected(label, `request failed — ${e.message}`);
      continue;
    }
    console.log(`HTTP ${res.status}`);

    if (res.status === 401 || res.status === 403) {
      skipExpected(label, `HTTP ${res.status} — selected provider auth not configured`);
      continue;
    }
    if (res.status !== 200) {
      fail(
        `${label}: proxy returned HTTP ${res.status}`,
        boundedResponseTail(res.bodyText, 300),
      );
      continue;
    }

    // Verify the response came through c-thru with agent-name resolution.
    const resolvedVia = res.headers && res.headers['x-c-thru-resolved-via'];
    if (!resolvedVia) {
      fail(`${label}: x-c-thru-resolved-via header absent — response did not come through c-thru proxy`);
    } else {
      try {
        const via = JSON.parse(resolvedVia);
        ok(`${label}: routed through c-thru → served_by=${via.served_by} capability=${via.capability} tier=${via.tier}`);
        if (via.served_by === agent) {
          fail(`${label}: served_by equals agent name — agent_to_capability resolution did not fire`);
        } else {
          ok(`${label}: agent name resolved (served_by "${via.served_by}" ≠ agent name "${agent}")`);
        }
        if (!via.served_by) {
          fail(`${label}: served_by is null/empty — no model was resolved`);
        }
        if (via.capability !== expectedCapability) {
          fail(`${label}: capability "${via.capability}" expected "${expectedCapability}"`);
        } else {
          ok(`${label}: capability matches selected model map (${expectedCapability})`);
        }
      } catch (e) {
        fail(`${label}: x-c-thru-resolved-via is not valid JSON — ${e.message}`);
      }
    }

    const text = res.json && Array.isArray(res.json.content)
      ? res.json.content.map(c => (c != null && typeof c === 'object' && c.text) ? c.text : '').join('')
      : res.bodyText;

    const result = parseAgentContractResult(text);
    observations.push({ caseId, result });
    validateContractResult(entry, result, text, res);
  }

  const universalRecusal = universalNormalRecusalError(roster, observations);
  if (universalRecusal) {
    fail('actionable normal cases cannot universally recuse', universalRecusal);
  }

  const total = passed + failed + skippedExpected + skippedUnexpected;
  const skippedParts = [];
  if (skippedExpected)   skippedParts.push(`${skippedExpected} skipped (expected)`);
  if (skippedUnexpected) skippedParts.push(`${skippedUnexpected} skipped (UNEXPECTED)`);
  const skippedSummary = skippedParts.length ? `, ${skippedParts.join(', ')}` : '';
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed${skippedSummary}`);
}

async function main() {
  let roster;
  try {
    const preflight = preflightAgentContracts({
      agentsDir: AGENTS_DIR,
      modelMapPath: MODEL_MAP,
      cases: AGENT_CONTRACT_CASES,
      requiredCaseAgents: STRUCTURED_AGENTS,
      requiredRecusalCaseAgents: STRUCTURED_AGENTS,
      suiteName: LIVE_SUITE,
    });
    roster = preflight.cases;
    console.log(
      `agent-contract-live: preflight ok ` +
      `(${preflight.structuredAgents.length} structured agents, ${roster.length} cases)`,
    );
  } catch (err) {
    console.error(err && err.stack || err);
    finish('failed', 'preflight_failed');
  }

  let proxyStarted = false;
  try {
    await withModelTestProxy({
      configPath: MODEL_MAP,
      cwd: REPO_ROOT,
      env: managedProxyEnv(),
    }, async ({ port }) => {
      proxyStarted = true;
      console.log(
        `agent-contract-live: managed proxy 127.0.0.1:${port}, ` +
        `timeout=${PER_AGENT_TIMEOUT_MS}ms\n`,
      );
      await runContracts('127.0.0.1', port, roster);
    });
  } catch (err) {
    console.error('agent-contract-live:', err && err.stack || err);
    if (!proxyStarted) finish('blocked', 'managed_proxy_unavailable');
    finish('failed', err?.code || err?.message || 'contract_run_failed');
  }

  if (failed || skippedUnexpected) {
    finish(
      'failed',
      failed ? `${failed}_assertions_failed` : `${skippedUnexpected}_unexpected_mandatory_skips`,
    );
  }
  if (skippedExpected) {
    finish('skipped', `${skippedExpected}_mandatory_contracts_not_exercised`);
  }
  if (passed === 0) finish('skipped', 'no_mandatory_contracts_exercised');
  finish('passed', 'all_mandatory_contracts_exercised');
}

// unhandledRejection handler is installed by helpers.js on require.
main().catch(err => {
  console.error(err && err.stack || err);
  finish('failed', err?.code || err?.message || 'uncaught_error');
});
