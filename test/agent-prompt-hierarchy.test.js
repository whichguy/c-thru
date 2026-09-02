#!/usr/bin/env node
'use strict';
/**
 * Agent Prompt Hierarchy Test
 * Validates the c-thru agent hierarchy from bottom to top using a sample scenario.
 * Hierarchy: Tier 1 (Recon) -> Tier 2 (Workers) -> Tier 3 (Review) -> Tier 4 (Planners)
 *
 * Guard: C_THRU_HIERARCHY_TESTS=1
 * Run: C_THRU_HIERARCHY_TESTS=1 node test/agent-prompt-hierarchy.test.js
 */

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

if (!process.env.C_THRU_HIERARCHY_TESTS) {
  console.log('agent-prompt-hierarchy: skip (set C_THRU_HIERARCHY_TESTS=1 to enable)');
  process.exit(0);
}

const REPO_ROOT       = path.resolve(__dirname, '..');
const AGENTS_DIR      = path.join(REPO_ROOT, 'agents');
const MODEL_TEST_TIMEOUT_MS = modelTestTimeoutMs();
const ACTIONABLE_RESULT_REMINDER = [
  'Follow the response schema in your system prompt.',
  'Use TASK_STATUS for a normal outcome.',
  'STATUS: RECUSE is only the separate recusal path and does not complete this actionable phase.',
].join(' ');

const PROXY_HOST = '127.0.0.1';
let PROXY_PORT = Number(process.env.CLAUDE_PROXY_PORT);

// Extract from ANTHROPIC_BASE_URL if CLAUDE_PROXY_PORT is missing (e.g. when run via c-thru)
if (!PROXY_PORT && process.env.ANTHROPIC_BASE_URL) {
  try {
    const u = new URL(process.env.ANTHROPIC_BASE_URL);
    PROXY_PORT = Number(u.port);
  } catch {}
}

// ── Shared Artifacts ──────────────────────────────────────────────────────────
const SCENARIO = {
  intent: 'Add a palindrome checker utility to the auth module.',
  target: 'src/auth/utils.js',
};

const artifacts = {
  recon: '# Reconnaissance summary\n\nExisting files:\n- src/auth/login.js\n- src/auth/session.js\n\nNo string utilities found in src/auth/utils.js (file is empty or missing).',
  gaps: '',
  discovery: '',
  stubs: '',
  implementation: '',
  tests: '',
  findings: [],
  currentPlan: '',
  waveSummary: '',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(label) { console.log(`  ok    ${label}`); }
function fail(label, reason) {
  console.error(`  FAIL  ${label}`);
  if (reason) console.error(`        ${reason}`);
  throw new Error(`Hierarchy phase failed: ${label}${reason ? ` — ${reason}` : ''}`);
}

async function postMessages(agentName, systemPrompt, userMessage) {
  // Prepend /no_think for Qwen3 models to suppress thinking tokens
  const sys = `/no_think\n\n${systemPrompt}`;

  const body = {
    model:      agentName,
    max_tokens: 4000,
    stream:     false,
    system:     sys,
    messages:   [{ role: 'user', content: `${userMessage}\n\nIMPORTANT: ${ACTIONABLE_RESULT_REMINDER}` }],
  };
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: PROXY_HOST,
        port:     PROXY_PORT,
        path:     '/v1/messages',
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          'Authorization':  `Bearer ${process.env.ANTHROPIC_API_KEY || 'hierarchy-test'}`,
        },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${bodyText}`));
            return;
          }
          let json = null;
          try { json = JSON.parse(bodyText); } catch {}
          const text = json && Array.isArray(json.content)
            ? json.content.map(c => c.text || '').join('')
            : bodyText;
          resolve(text);
        });
      }
    );
    req.setTimeout(MODEL_TEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`model request timed out after ${MODEL_TEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function readSystemPrompt(agentName) {
  const p = path.join(AGENTS_DIR, `${agentName}.md`);
  const content = fs.readFileSync(p, 'utf8');
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
}

function requireActionableTaskStatus(agentName, response) {
  const result = parseAgentContractResult(response);
  const actionable =
    result.valid &&
    result.kind === 'task' &&
    ['COMPLETE', 'PARTIAL'].includes(result.status);
  if (!actionable) {
    console.error(`  [${agentName}] response was:\n${response}\n`);
    const observed = result.valid
      ? `${result.kind === 'recusal' ? 'STATUS' : 'TASK_STATUS'}: ${result.status}`
      : result.reason;
    fail(
      agentName,
      `Expected actionable TASK_STATUS: COMPLETE or PARTIAL; got ${observed}`,
    );
  }
  ok(`${agentName}: TASK_STATUS=${result.status}`);
  return result;
}

function requireVerdict(agentName, response, allowedVerdicts) {
  const verdicts = [...response.matchAll(/^VERDICT:\s*([A-Z_]+)\s*$/gmi)]
    .map(match => match[1].toUpperCase());
  const verdict = verdicts[0];
  if (verdicts.length !== 1 || !allowedVerdicts.includes(verdict)) {
    fail(
      agentName,
      `Expected exactly one VERDICT in {${allowedVerdicts.join(', ')}}; ` +
        `got ${verdicts.join(', ') || 'none'}`,
    );
  }
  ok(`${agentName}: VERDICT=${verdict}`);
  return verdict;
}

function buildWorkerDigest(agentName, itemId, targetResources, taskBody) {
  const frontmatter = [
    '---',
    `agent: ${agentName}`,
    `item_id: ${itemId}`,
    'wave: "001"',
    `target_resources: [${targetResources.join(', ')}]`,
    '---',
  ].join('\n');
  // The plan harness owns shared/_worker-contract.md. These direct Claude agent
  // calls use the response contract already present in each system prompt.
  return `${frontmatter}\n\n${taskBody.trim()}`;
}

// ── Test Sequence ─────────────────────────────────────────────────────────────

async function run() {
  console.log(`Starting Hierarchy Test: "${SCENARIO.intent}"\n`);

  // --- Phase 1: Recon & Scaffolding ---

  console.log('--- Phase 1: Recon & Scaffolding ---');

  // 1. explore (gap advisor)
  {
    const name = 'explore';
    const sys = readSystemPrompt(name);
    const user = `intent: ${SCENARIO.intent}\nrecon_path: recon.md\ngaps_out: gaps.md\n\nContents of recon.md:\n${artifacts.recon}`;
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    requireActionableTaskStatus(name, resp);
    artifacts.gaps = resp; // In a real scenario, this would be the content of gaps.md
  }

  // 2. explore (fan-out)
  {
    const name = 'explore';
    const sys = readSystemPrompt(name);
    const user = `gap_question: Is src/auth/utils.js available for new utilities?\noutput_path: discovery/auth-utils.md\n\nFile list from recon:\n- src/auth/login.js\n- src/auth/session.js`;
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    requireActionableTaskStatus(name, resp);
    artifacts.discovery = resp;
  }

  // 3. coder (stub creation)
  {
    const name = 'coder';
    const sys = readSystemPrompt(name);
    const user = buildWorkerDigest(name, 'item-001', [SCENARIO.target], `Create a stub for a palindrome checker in ${SCENARIO.target}.`);
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    requireActionableTaskStatus(name, resp);
    artifacts.stubs = resp;
  }

  // --- Phase 2: Implementation & Tests ---

  console.log('\n--- Phase 2: Implementation & Tests ---');

  // 4. coder (implementation)
  {
    const name = 'coder';
    const sys = readSystemPrompt(name);
    const user = buildWorkerDigest(name, 'item-002', [SCENARIO.target], `Implement the palindrome checker in ${SCENARIO.target} based on the following stubs:\n\n${artifacts.stubs}`);
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    requireActionableTaskStatus(name, resp);
    artifacts.implementation = resp;
  }

  // 5. tester
  {
    const name = 'tester';
    const sys = readSystemPrompt(name);
    const user = buildWorkerDigest(name, 'item-003', ['src/auth/utils.test.js'], `Write unit tests for the palindrome checker implementation:\n\n${artifacts.implementation}`);
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    requireActionableTaskStatus(name, resp);
    artifacts.tests = resp;
  }

  // --- Phase 3: Review & Synthesis ---

  console.log('\n--- Phase 3: Review & Synthesis ---');

  // 6. code-reviewer
  {
    const name = 'code-reviewer';
    const sys = readSystemPrompt(name);
    const user = buildWorkerDigest(name, 'item-004', [SCENARIO.target, 'src/auth/utils.test.js'], `Review the implementation and tests for the palindrome checker.
Implementation:
${artifacts.implementation}

Tests:
${artifacts.tests}`);
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    requireActionableTaskStatus(name, resp);
    requireVerdict(name, resp, ['APPROVE', 'APPROVE_WITH_SUGGESTIONS', 'REQUEST_CHANGES']);
    artifacts.waveReview = resp;
  }

  // 7. coder (wave executor)
  {
    const name = 'coder';
    const sys = readSystemPrompt(name);
    const user = `Execute wave 001 for intent: ${SCENARIO.intent}
READY_ITEMS:
- id: item-001, desc: Create stubs
- id: item-002, desc: Implement checker
- id: item-003, desc: Write tests

Findings so far:
${artifacts.waveReview}`;
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    requireActionableTaskStatus(name, resp);
    artifacts.waveSummary = resp;
  }

  // --- Phase 4: Planners & Judges ---

  console.log('\n--- Phase 4: Planners & Judges ---');

  // 8. planner (dep_update)
  {
    const name = 'planner';
    const sys = readSystemPrompt(name);
    const user = `signal: dep_update
intent: ${SCENARIO.intent}
affected_items:
- id: item-002, desc: Implement checker
dep_discoveries:
- item_id: item-002, text: "Found dependency on 'string-sanitizer' library."`;
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    requireActionableTaskStatus(name, resp);
    artifacts.currentPlan = resp;
  }

  // 9. planner (intent)
  {
    const name = 'planner';
    const sys = readSystemPrompt(name);
    const user = `signal: intent
intent: ${SCENARIO.intent}
discovery_context:
${artifacts.discovery}`;
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    requireActionableTaskStatus(name, resp);
    artifacts.currentPlan = resp;
  }

  // 10. plan-reviewer (plan review)
  {
    const name = 'plan-reviewer';
    const sys = readSystemPrompt(name);
    const user = `Review the following plan for intent: ${SCENARIO.intent}

${artifacts.currentPlan}`;
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    requireActionableTaskStatus(name, resp);
    requireVerdict(name, resp, ['APPROVED', 'NEEDS_REVISION']);
  }

  // 11. code-reviewer (final review)
  {
    const name = 'code-reviewer';
    const sys = readSystemPrompt(name);
    const user = `intent: ${SCENARIO.intent}
plan:
${artifacts.currentPlan}

journal:
Wave 001: Implemented palindrome checker and tests.`;
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    requireActionableTaskStatus(name, resp);
    requireVerdict(name, resp, ['APPROVE', 'APPROVE_WITH_SUGGESTIONS', 'REQUEST_CHANGES']);
  }

  console.log('\nHierarchy Test Completed Successfully.');
}

async function main() {
  if (PROXY_PORT) {
    await run();
    return;
  }

  const configPath = process.env.CLAUDE_MODEL_MAP_PATH
    || path.join(REPO_ROOT, 'config', 'model-map.json');
  await withModelTestProxy({ configPath, cwd: REPO_ROOT }, async ({ port }) => {
    PROXY_PORT = port;
    console.log(`Hierarchy test proxy: ${PROXY_HOST}:${PROXY_PORT} (managed)`);
    await run();
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
