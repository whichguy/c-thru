#!/usr/bin/env node
'use strict';

// Behavioral contract tests for the current session-injected agent fleet.
// Each actionable case must return TASK_STATUS and satisfy a role-specific
// content assertion. Every structured role has a documented recusal case, and
// plan-scheduler also exercises its missing-skill INSTALL contract.
//
// Guard:  C_THRU_BEHAVIORAL_TESTS=1
// Filter: BEHAVIORAL_ONLY=planner,coder-clamp-function
// Run:    C_THRU_BEHAVIORAL_TESTS=1 node test/agent-contract-behavioral.test.js

const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  ensureModelTestSupervisor,
  modelTestTimeoutMs,
  parseAgentContractResult,
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
const LIVE_SUITE = 'agent-contract-behavioral';
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

if (process.env.C_THRU_BEHAVIORAL_TESTS !== '1') {
  console.log('agent-contract-behavioral: skip (set C_THRU_BEHAVIORAL_TESTS=1 to enable)');
  finish('skipped', 'gate_not_enabled');
}

const REPO_ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const MODEL_MAP = process.env.CLAUDE_MODEL_MAP_PATH ||
  path.join(REPO_ROOT, 'config', 'model-map.json');
const PER_AGENT_TIMEOUT_MS = modelTestTimeoutMs();
const FILTER = process.env.BEHAVIORAL_ONLY
  ? new Set(process.env.BEHAVIORAL_ONLY.split(',').map(value => value.trim()).filter(Boolean))
  : null;

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

let passed = 0;
let failed = 0;
let skippedExpected = 0;
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
  console.log(`  skip  ${label}${reason ? ` — ${reason}` : ''} (expected)`);
  skippedExpected++;
}

function skipUnexpected(label, reason) {
  console.log(`  SKIP! ${label}${reason ? ` — ${reason}` : ''} (UNEXPECTED)`);
  skippedUnexpected++;
}

function postMessages(host, port, body, timeoutMs = PER_AGENT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const bodyText = JSON.stringify(body);
    const req = http.request(
      {
        hostname: host,
        port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyText),
          'Authorization': `Bearer ${process.env.ANTHROPIC_API_KEY || 'live-test'}`,
        },
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, bodyText: raw });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(bodyText);
    req.end();
  });
}

function stripFrontmatter(content) {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
}

function readSystemPrompt(agentName) {
  const file = path.join(AGENTS_DIR, `${agentName}.md`);
  if (!fs.existsSync(file)) return null;
  return stripFrontmatter(fs.readFileSync(file, 'utf8'));
}

function responseText(response) {
  if (!response.json || !Array.isArray(response.json.content)) return response.bodyText;
  return response.json.content
    .map(block => block && typeof block === 'object' && block.text ? block.text : '')
    .join('');
}

function validateRoute(entry, response) {
  const label = `${entry.caseId} (${entry.agent})`;
  const raw = response.headers && response.headers['x-c-thru-resolved-via'];
  if (!raw) {
    fail(`${label}: x-c-thru-resolved-via header absent`);
    return;
  }
  try {
    const via = JSON.parse(raw);
    if (!via.served_by || via.served_by === entry.agent) {
      fail(
        `${label}: agent name did not resolve to a concrete model`,
        `served_by=${via.served_by || '(missing)'}`,
      );
    } else {
      ok(`${label}: routed to concrete model ${via.served_by}`);
    }
    if (via.capability !== entry.expectedCapability) {
      fail(
        `${label}: capability mismatch`,
        `got ${via.capability || '(missing)'}, expected ${entry.expectedCapability}`,
      );
    } else {
      ok(`${label}: capability=${via.capability}`);
    }
  } catch (error) {
    fail(`${label}: x-c-thru-resolved-via is invalid JSON`, error.message);
  }
}

async function runContracts(host, port, roster) {
  const observations = [];
  for (const entry of roster) {
    const label = `${entry.caseId} (${entry.agent})`;
    const systemPrompt = readSystemPrompt(entry.agent);
    if (!systemPrompt) {
      fail(`${label}: agent file disappeared after preflight`);
      continue;
    }

    process.stdout.write(`  [${label}] … `);
    let response;
    try {
      response = await postMessages(host, port, {
        model: entry.agent,
        max_tokens: AGENT_CONTRACT_MAX_TOKENS,
        stream: false,
        system: systemPrompt,
        messages: [{ role: 'user', content: entry.userMessage }],
      });
    } catch (error) {
      console.log('');
      skipUnexpected(label, `request failed — ${error.message}`);
      continue;
    }
    console.log(`HTTP ${response.status}`);

    if (response.status === 401 || response.status === 403) {
      skipExpected(label, `HTTP ${response.status} — selected provider auth not configured`);
      continue;
    }
    if (response.status !== 200) {
      fail(
        `${label}: proxy returned HTTP ${response.status}`,
        boundedResponseTail(response.bodyText, 300),
      );
      continue;
    }

    validateRoute(entry, response);
    const text = responseText(response);
    const result = parseAgentContractResult(text);
    observations.push({ caseId: entry.caseId, result });
    const errors = [
      ...validateContractResponseIntegrity(response),
      ...validateContractCase(entry, result, text),
    ];
    if (errors.length > 0) {
      fail(
        `${label}: behavioral contract failed`,
        `${errors.join('; ')}; ${formatContractFailureDiagnostics(response, text)}`,
      );
    } else {
      ok(`${label}: ${result.kind === 'task' ? 'TASK_STATUS' : 'STATUS'}=${result.status}`);
    }
  }

  const universalRecusal = universalNormalRecusalError(roster, observations);
  if (universalRecusal) {
    fail('actionable normal cases cannot universally recuse', universalRecusal);
  }

  const total = passed + failed + skippedExpected + skippedUnexpected;
  const skipped = [];
  if (skippedExpected) skipped.push(`${skippedExpected} skipped (expected)`);
  if (skippedUnexpected) skipped.push(`${skippedUnexpected} skipped (UNEXPECTED)`);
  console.log(
    `\n${total} tests: ${passed} passed, ${failed} failed` +
    (skipped.length ? `, ${skipped.join(', ')}` : ''),
  );
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
    roster = FILTER
      ? preflight.cases.filter(entry => FILTER.has(entry.agent) || FILTER.has(entry.caseId))
      : preflight.cases;
    console.log(
      `agent-contract-behavioral: preflight ok ` +
      `(${preflight.structuredAgents.length} structured agents, ` +
      `${preflight.cases.length} cases; ${roster.length} selected)`,
    );
  } catch (error) {
    console.error(error && error.stack || error);
    finish('failed', 'preflight_failed');
  }

  if (roster.length === 0) finish('skipped', 'no_cases_selected');

  let proxyStarted = false;
  try {
    await withModelTestProxy({
      configPath: MODEL_MAP,
      cwd: REPO_ROOT,
      env: managedProxyEnv(),
    }, async ({ port }) => {
      proxyStarted = true;
      console.log(
        `agent-contract-behavioral: managed proxy 127.0.0.1:${port}, ` +
        `timeout=${PER_AGENT_TIMEOUT_MS}ms\n`,
      );
      await runContracts('127.0.0.1', port, roster);
    });
  } catch (error) {
    console.error('agent-contract-behavioral:', error && error.stack || error);
    if (!proxyStarted) finish('blocked', 'managed_proxy_unavailable');
    finish('failed', error?.code || error?.message || 'contract_run_failed');
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

// unhandledRejection handling is installed by helpers.js on require.
main().catch(error => {
  console.error(error && error.stack || error);
  finish('failed', error?.code || error?.message || 'uncaught_error');
});
