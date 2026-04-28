#!/usr/bin/env node
'use strict';
// Static linter for agents/*.md — zero-cost CI gate for STATUS contract conformance.
// Parses every agent file and asserts structural compliance with:
//   docs/agent-architecture.md §"Worker STATUS contract" + §"RECUSE STATUS contract"
// Run: node test/agent-contract-static.test.js

const fs   = require('fs');
const path = require('path');

let passed   = 0;
let failed   = 0;
let warnings = 0;

function ok(label) {
  console.log(`  ok    ${label}`);
  passed++;
}

function fail(label, reason) {
  console.error(`  FAIL  ${label}`);
  if (reason) console.error(`        ${reason}`);
  failed++;
}

function warn(label, reason) {
  console.warn(`  WARN  ${label}`);
  if (reason) console.warn(`        ${reason}`);
  warnings++;
}

const REPO_ROOT  = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const CONFIG     = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'model-map.json'), 'utf8'));
const AGENT_TO_CAPABILITY = CONFIG.agent_to_capability || {};

// Valid RECOMMEND targets: known agent names + 'judge' sentinel.
const KNOWN_AGENTS   = new Set(Object.keys(AGENT_TO_CAPABILITY));
const VALID_RECOMMEND = new Set([...KNOWN_AGENTS, 'judge']);

// ── Roster ────────────────────────────────────────────────────────────────────
// needsStatus:     true  = body must contain 'STATUS: COMPLETE'
// needsRecuse:     'fail'   = RECUSE block required; test fails when absent
//                  'warn'   = spec gap; test warns when absent (not a hard failure)
//                  'exempt' = read-only agent; no RECUSE contract applies
//                  null     = no RECUSE check performed
// recuseException: true  = RECUSE present but RECOMMEND must be ABSENT (security-reviewer)
// recommendTarget: expected RECOMMEND value, or null to skip escalation-table check
// extraFields:     strings that must appear somewhere in the file body
// special:         'uplift-decider' — uses VERDICT contract instead of STATUS/RECUSE
// warnOnly:        true  = judge/orchestrator/utility tier; only model: field checked

const ROSTER = {
  // ── Full-contract worker agents ──────────────────────────────────────────────
  'implementer':       { needsStatus: true, needsRecuse: 'fail', recommendTarget: 'uplift-decider',  extraFields: ['LINT_ITERATIONS'] },
  'implementer-heavy': { needsStatus: true, needsRecuse: 'fail', recommendTarget: 'judge',            extraFields: ['LINT_ITERATIONS'] },
  'wave-reviewer':     { needsStatus: true, needsRecuse: 'fail', recommendTarget: 'implementer-heavy', extraFields: ['ITERATIONS'] },
  'test-writer':       { needsStatus: true, needsRecuse: 'fail', recommendTarget: 'test-writer-heavy' },
  'test-writer-heavy': { needsStatus: true, needsRecuse: 'fail', recommendTarget: 'judge' },
  'scaffolder':        { needsStatus: true, needsRecuse: 'fail', recommendTarget: 'implementer' },
  'converger':         { needsStatus: true, needsRecuse: 'fail', recommendTarget: 'implementer-heavy' },

  // ── Spec-gap agents: STATUS required, RECUSE not yet declared ────────────────
  'integrator':       { needsStatus: true, needsRecuse: 'warn' },
  'doc-writer':       { needsStatus: true, needsRecuse: 'warn' },
  // planner-local uses CYCLE/VERDICT grammar — RECUSE not yet declared (spec gap)
  'planner-local':    { needsStatus: true, needsRecuse: 'warn' },

  // ── Recon agents ─────────────────────────────────────────────────────────────
  // TEST_FRAMEWORKS is conditional for explorer (CI questions only) — extraFields check verifies it's documented, not always emitted
  'explorer':          { needsStatus: true, needsRecuse: 'exempt', extraFields: ['TEST_FRAMEWORKS'] },
  // discovery-advisor: minimal STATUS grammar (COMPLETE|ERROR only); RECUSE spec gap; TEST_FRAMEWORKS always emitted
  'discovery-advisor': { needsStatus: true, needsRecuse: 'warn', extraFields: ['TEST_FRAMEWORKS'] },

  // ── Special contracts ─────────────────────────────────────────────────────────
  'uplift-decider':    { needsStatus: false, special: 'uplift-decider' },
  // security-reviewer: RECUSE present but RECOMMEND must be absent (no cascade target)
  'security-reviewer': { needsStatus: true, needsRecuse: 'fail', recuseException: true },

  // ── Judge tier: warn-only (no STATUS contract defined) ───────────────────────
  'auditor':            { warnOnly: true },
  'final-reviewer':     { warnOnly: true },
  'review-plan':        { warnOnly: true },
  'planner':            { warnOnly: true },
  'journal-digester':   { warnOnly: true },
  'evaluator':          { warnOnly: true },
  'supervisor':         { warnOnly: true },
  'supervisor-debug':   { warnOnly: true },

  // ── Orchestrator / utility tiers: warn-only ───────────────────────────────────
  'plan-orchestrator':      { warnOnly: true, extraFields: ['TEST_FRAMEWORKS', 'COMPLEXITY', 'MIGRATION_REQUIRED'] },
  'wave-synthesizer':       { warnOnly: true },
  'learnings-consolidator': { warnOnly: true },

  // ── General roles: warn-only (no STATUS contract defined) ───────────────────
  'generalist':             { warnOnly: true },
  'coder':                  { warnOnly: true },
  'agentic-coder':          { warnOnly: true },
  'debugger':               { warnOnly: true },
  'long-context':           { warnOnly: true },
  'fast-generalist':        { warnOnly: true },
  'vision':                 { warnOnly: true },
  'pdf':                    { warnOnly: true },
  'large-general':          { warnOnly: true },
  'edge':                   { warnOnly: true },
  'judge':                  { warnOnly: true },
  'reviewer':               { warnOnly: true },
  'refactor':               { warnOnly: true },
  'context-manager':        { warnOnly: true },
  'reasoner':               { warnOnly: true },
  'fast-scout':             { warnOnly: true },
  'code-analyst-light':     { warnOnly: true },
  'deep-coder-precise':     { warnOnly: true },
  'orchestrator':           { warnOnly: true },

  // ── Routing-only entries: no agent file; resolve via agent_to_capability only ──
  // routingOnly: true — skip all file checks; only coverage in agent_to_capability is verified.
  'judge-evaluator': { routingOnly: true },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

// ── 1. Fail-closed: every agent in agent_to_capability must be in the roster ──
console.log('1. Fail-closed: all agents in agent_to_capability covered by roster');

for (const agentName of Object.keys(AGENT_TO_CAPABILITY)) {
  if (!ROSTER[agentName]) {
    fail(`${agentName}: in agent_to_capability but NOT in test roster — add an entry`);
  } else {
    ok(`${agentName}: covered in test roster`);
  }
}

// ── 2. Per-agent structural checks ────────────────────────────────────────────
console.log('\n2. Per-agent structural checks');

for (const [agentName, spec] of Object.entries(ROSTER)) {
  // Routing-only entries have no agent file — skip all file checks.
  if (spec.routingOnly) {
    ok(`${agentName}: routing-only (no agent file required)`);
    continue;
  }

  const filePath = path.join(AGENTS_DIR, `${agentName}.md`);

  if (!fs.existsSync(filePath)) {
    fail(`${agentName}: agents/${agentName}.md not found`);
    continue;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const fm      = parseFrontmatter(content);

  // Frontmatter model: field must equal the filename
  if (fm.model !== agentName) {
    fail(`${agentName}: frontmatter model: "${fm.model || '(missing)'}" does not match filename "${agentName}"`);
  } else {
    ok(`${agentName}: model: field matches filename`);
  }

  // Extra field declarations checked for all agents (including warnOnly tiers)
  if (spec.extraFields) {
    for (const field of spec.extraFields) {
      if (!content.includes(field)) {
        fail(`${agentName}: required field "${field}" not declared in prompt body`);
      } else {
        ok(`${agentName}: "${field}" declared`);
      }
    }
  }

  // Warn-only tiers: only model: and extraFields checks above; no STATUS/RECUSE contract
  if (spec.warnOnly) continue;

  // uplift-decider: VERDICT contract instead of STATUS/RECUSE
  if (spec.special === 'uplift-decider') {
    for (const field of ['VERDICT:', 'CLOUD_CONFIDENCE:', 'RATIONALE:']) {
      if (!content.includes(field)) {
        fail(`${agentName}: ${field} required (uplift-decider contract)`);
      } else {
        ok(`${agentName}: ${field} present`);
      }
    }
    if (content.includes('STATUS: RECUSE')) {
      fail(`${agentName}: must NOT contain STATUS: RECUSE (routes via VERDICT, not RECUSE)`);
    } else {
      ok(`${agentName}: correctly omits STATUS: RECUSE`);
    }
    continue;
  }

  // STATUS: COMPLETE must be declared in the prompt body
  if (spec.needsStatus) {
    if (!content.includes('STATUS: COMPLETE')) {
      fail(`${agentName}: STATUS: COMPLETE not declared in prompt body`);
    } else {
      ok(`${agentName}: STATUS: COMPLETE declared`);
    }
  }

  // security-reviewer exception: RECUSE present, RECOMMEND must be absent
  if (spec.recuseException) {
    if (!content.includes('STATUS: RECUSE')) {
      fail(`${agentName}: STATUS: RECUSE required`);
    } else {
      ok(`${agentName}: STATUS: RECUSE present`);
    }
    if (content.includes('RECOMMEND:')) {
      fail(`${agentName}: RECOMMEND: must be absent (no cascade target — judge-strict hard_fail)`);
    } else {
      ok(`${agentName}: RECOMMEND: correctly absent (security-reviewer exception)`);
    }
    continue;
  }

  // RECUSE block checks
  if (spec.needsRecuse === 'fail' || spec.needsRecuse === 'warn') {
    const report    = spec.needsRecuse === 'fail' ? fail : warn;
    const hasRecuse = content.includes('STATUS: RECUSE');

    if (!hasRecuse) {
      report(`${agentName}: STATUS: RECUSE block missing`, 'spec gap — RECUSE contract not yet declared in this agent');
    } else {
      ok(`${agentName}: STATUS: RECUSE present`);

      const hasRecommend = content.includes('RECOMMEND:');
      if (!hasRecommend) {
        report(`${agentName}: RECOMMEND: missing from RECUSE block`);
      } else {
        ok(`${agentName}: RECOMMEND: present`);

        // RECOMMEND value must be a known agent name or 'judge' sentinel
        const m = content.match(/^RECOMMEND:\s*(\S+)/m);
        if (m) {
          const target = m[1].trim();
          if (!VALID_RECOMMEND.has(target)) {
            fail(`${agentName}: RECOMMEND: "${target}" is not a known agent or "judge" sentinel`);
          } else {
            ok(`${agentName}: RECOMMEND: "${target}" is a valid target`);
          }

          // RECOMMEND must match the hardcoded escalation table
          if (spec.recommendTarget && target !== spec.recommendTarget) {
            fail(`${agentName}: RECOMMEND: "${target}" expected "${spec.recommendTarget}" per escalation table`);
          } else if (spec.recommendTarget) {
            ok(`${agentName}: RECOMMEND: "${target}" matches escalation table`);
          }
        }
      }
    }
  }

}

// ── Summary ───────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${total} tests: ${passed} passed, ${failed} failed${warnings ? `, ${warnings} warnings` : ''}`);
process.exit(failed ? 1 : 0);
