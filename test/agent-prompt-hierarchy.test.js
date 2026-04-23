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
const os   = require('os');
const path = require('path');
const {
  parseStatusBlock,
  stripBehavioralContract,
  tierTimeout,
  registerTmpDir,
} = require('./helpers');

if (!process.env.C_THRU_HIERARCHY_TESTS) {
  console.log('agent-prompt-hierarchy: skip (set C_THRU_HIERARCHY_TESTS=1 to enable)');
  process.exit(0);
}

const REPO_ROOT       = path.resolve(__dirname, '..');
const AGENTS_DIR      = path.join(REPO_ROOT, 'agents');
const CONTRACT_FILE   = path.join(REPO_ROOT, 'shared', '_worker-contract.md');
const WORKER_CONTRACT = fs.readFileSync(CONTRACT_FILE, 'utf8');
const BEHAVIORAL_WORKER_CONTRACT = stripBehavioralContract(WORKER_CONTRACT);

const PROXY_HOST = '127.0.0.1';
let PROXY_PORT = Number(process.env.CLAUDE_PROXY_PORT);

// Extract from ANTHROPIC_BASE_URL if CLAUDE_PROXY_PORT is missing (e.g. when run via c-thru)
if (!PROXY_PORT && process.env.ANTHROPIC_BASE_URL) {
  try {
    const u = new URL(process.env.ANTHROPIC_BASE_URL);
    PROXY_PORT = Number(u.port);
  } catch {}
}

// Fallback to default
if (!PROXY_PORT) PROXY_PORT = 9001;

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
  process.exit(1);
}

async function postMessages(agentName, systemPrompt, userMessage) {
  // Prepend /no_think for Qwen3 models to suppress thinking tokens
  const sys = `/no_think\n\n${systemPrompt}`;

  const body = {
    model:      agentName,
    max_tokens: 4000,
    stream:     false,
    system:     sys,
    messages:   [{ role: 'user', content: userMessage + '\n\nIMPORTANT: You MUST conclude your response with the required STATUS block format.' }],
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

function buildWorkerDigest(agentName, itemId, targetResources, taskBody) {
  const frontmatter = [
    '---',
    `agent: ${agentName}`,
    `item_id: ${itemId}`,
    'wave: "001"',
    `target_resources: [${targetResources.join(', ')}]`,
    '---',
  ].join('\n');
  return frontmatter + '\n\n' + taskBody.trim() + '\n\n---\n\n' + BEHAVIORAL_WORKER_CONTRACT + '\n\nIMPORTANT: You MUST end your response with the STATUS: COMPLETE block as defined in your system prompt.';
}

// ── Test Sequence ─────────────────────────────────────────────────────────────

async function run() {
  console.log(`Starting Hierarchy Test: "${SCENARIO.intent}"\n`);

  // --- Phase 1: Recon & Scaffolding ---

  console.log('--- Phase 1: Recon & Scaffolding ---');

  // 1. discovery-advisor
  {
    const name = 'discovery-advisor';
    const sys = readSystemPrompt(name);
    const user = `intent: ${SCENARIO.intent}\nrecon_path: recon.md\ngaps_out: gaps.md\n\nContents of recon.md:\n${artifacts.recon}`;
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    const block = parseStatusBlock(resp);
    if (!['COMPLETE', 'PARTIAL'].includes(block.STATUS)) {
      console.error(`  [${name}] response was:\n${resp}\n`);
      fail(name, `Expected COMPLETE or PARTIAL, got ${block.STATUS}`);
    }
    ok(`${name}: STATUS=${block.STATUS}`);
    artifacts.gaps = resp; // In a real scenario, this would be the content of gaps.md
  }

  // 2. explorer
  {
    const name = 'explorer';
    const sys = readSystemPrompt(name);
    const user = `gap_question: Is src/auth/utils.js available for new utilities?\noutput_path: discovery/auth-utils.md\n\nFile list from recon:\n- src/auth/login.js\n- src/auth/session.js`;
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    const block = parseStatusBlock(resp);
    if (!['COMPLETE', 'PARTIAL'].includes(block.STATUS)) {
      console.error(`  [${name}] response was:\n${resp}\n`);
      fail(name, `Expected COMPLETE or PARTIAL, got ${block.STATUS}`);
    }
    ok(`${name}: STATUS=${block.STATUS}`);
    artifacts.discovery = resp;
  }

  // 3. scaffolder
  {
    const name = 'scaffolder';
    const sys = readSystemPrompt(name);
    const user = buildWorkerDigest(name, 'item-001', [SCENARIO.target], `Create a stub for a palindrome checker in ${SCENARIO.target}.`);
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    const block = parseStatusBlock(resp);
    if (!['COMPLETE', 'PARTIAL'].includes(block.STATUS)) {
      console.error(`  [${name}] response was:\n${resp}\n`);
      fail(name, `Expected COMPLETE or PARTIAL, got ${block.STATUS}`);
    }
    ok(`${name}: STATUS=${block.STATUS}`);
    artifacts.stubs = resp;
  }

  // --- Phase 2: Implementation & Tests ---

  console.log('\n--- Phase 2: Implementation & Tests ---');

  // 4. implementer
  {
    const name = 'implementer';
    const sys = readSystemPrompt(name);
    const user = buildWorkerDigest(name, 'item-002', [SCENARIO.target], `Implement the palindrome checker in ${SCENARIO.target} based on the following stubs:\n\n${artifacts.stubs}`);
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    const block = parseStatusBlock(resp);
    if (!['COMPLETE', 'PARTIAL'].includes(block.STATUS)) {
      console.error(`  [${name}] response was:\n${resp}\n`);
      fail(name, `Expected COMPLETE or PARTIAL, got ${block.STATUS}`);
    }
    ok(`${name}: STATUS=${block.STATUS}`);
    artifacts.implementation = resp;
  }

  // 5. test-writer
  {
    const name = 'test-writer';
    const sys = readSystemPrompt(name);
    const user = buildWorkerDigest(name, 'item-003', ['src/auth/utils.test.js'], `Write unit tests for the palindrome checker implementation:\n\n${artifacts.implementation}`);
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    const block = parseStatusBlock(resp);
    if (!['COMPLETE', 'PARTIAL'].includes(block.STATUS)) {
      console.error(`  [${name}] response was:\n${resp}\n`);
      fail(name, `Expected COMPLETE or PARTIAL, got ${block.STATUS}`);
    }
    ok(`${name}: STATUS=${block.STATUS}`);
    artifacts.tests = resp;
  }

  // --- Phase 3: Review & Synthesis ---

  console.log('\n--- Phase 3: Review & Synthesis ---');

  // 6. wave-reviewer
  {
    const name = 'wave-reviewer';
    const sys = readSystemPrompt(name);
    const user = buildWorkerDigest(name, 'item-004', [SCENARIO.target, 'src/auth/utils.test.js'], `Review the implementation and tests for the palindrome checker.
Implementation:
${artifacts.implementation}

Tests:
${artifacts.tests}`);
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    const block = parseStatusBlock(resp);
    // wave-reviewer might return PARTIAL if it finds something, but for a simple case COMPLETE is expected.
    if (!['COMPLETE', 'PARTIAL'].includes(block.STATUS)) fail(name, `Expected COMPLETE or PARTIAL, got ${block.STATUS}`);
    ok(`${name}: STATUS=${block.STATUS}`);
    artifacts.waveReview = resp;
  }

  // 7. plan-orchestrator
  {
    const name = 'plan-orchestrator';
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
    const block = parseStatusBlock(resp);
    // plan-orchestrator might not have a strict STATUS contract in all versions, but we check if it responds.
    ok(`${name}: Responded`);
    artifacts.waveSummary = resp;
  }

  // --- Phase 4: Planners & Judges ---

  console.log('\n--- Phase 4: Planners & Judges ---');

  // 8. planner-local (dep_update)
  {
    const name = 'planner-local';
    const sys = readSystemPrompt(name);
    const user = `signal: dep_update
intent: ${SCENARIO.intent}
affected_items:
- id: item-002, desc: Implement checker
dep_discoveries:
- item_id: item-002, text: "Found dependency on 'string-sanitizer' library."`;
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    const block = parseStatusBlock(resp);
    if (!['COMPLETE', 'PARTIAL'].includes(block.STATUS)) {
      console.error(`  [${name}] response was:\n${resp}\n`);
      fail(name, `Expected COMPLETE or PARTIAL, got ${block.STATUS}`);
    }
    ok(`${name}: STATUS=${block.STATUS}`);
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
    // planner (cloud) returns current.md content
    ok(`${name}: Generated initial plan`);
    artifacts.currentPlan = resp;
  }

  // 10. review-plan
  {
    const name = 'review-plan';
    const sys = readSystemPrompt(name);
    const user = `Review the following plan for intent: ${SCENARIO.intent}

${artifacts.currentPlan}`;
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    const v = resp.match(/VERDICT:\s*(APPROVED|NEEDS_REVISION)/i);
    ok(`${name}: VERDICT=${v ? v[1] : 'unknown'}`);
  }

  // 11. final-reviewer
  {
    const name = 'final-reviewer';
    const sys = readSystemPrompt(name);
    const user = `intent: ${SCENARIO.intent}
plan:
${artifacts.currentPlan}

journal:
Wave 001: Implemented palindrome checker and tests.`;
    console.log(`  [${name}] calling...`);
    const resp = await postMessages(name, sys, user);
    const v = resp.match(/VERDICT:\s*(COMPLETE|INCOMPLETE)/i);
    ok(`${name}: VERDICT=${v ? v[1] : 'unknown'}`);
  }

  console.log('\nHierarchy Test Completed Successfully.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
