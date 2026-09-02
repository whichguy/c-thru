#!/usr/bin/env node
'use strict';
// Static linter for agents/*.md — zero-cost CI gate for STATUS contract conformance.
// Parses every agent file and asserts structural compliance with:
//   docs/agent-architecture.md §"Worker STATUS contract" + §"RECUSE STATUS contract"
// Run: node test/agent-contract-static.test.js

const fs   = require('fs');
const path = require('path');
const {
  preflightAgentContracts,
  STRUCTURED_AGENTS,
} = require('./agent-contract-fixtures');

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

try {
  preflightAgentContracts({
    agentsDir: AGENTS_DIR,
    modelMapPath: path.join(REPO_ROOT, 'config', 'model-map.json'),
    requiredRecusalCaseAgents: STRUCTURED_AGENTS,
    suiteName: 'agent-contract-static',
  });
  ok('shared structured-agent contract preflight passes');
} catch (error) {
  fail('shared structured-agent contract preflight passes', error.message);
}

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
  // ── Pipeline agents (planner → coder → tester → reviewer flow) ───────────────
  'planner':              { warnOnly: true },
  'planner-hard':         { warnOnly: true },
  'explore':              { warnOnly: true },
  'coder':                { warnOnly: true },
  'coder-fallback':       { warnOnly: true },
  'tester':               { warnOnly: true },
  'docs':                 { warnOnly: true },
  'code-reviewer':        { warnOnly: true },
  'plan-reviewer':        { warnOnly: true },
  'reviewer-security':    { warnOnly: true },
  'plan-scheduler':       { warnOnly: true },
  'debugger-hypothesis':  { warnOnly: true },
  'debugger-investigate': { warnOnly: true },
  'debugger-hard':        { warnOnly: true },

  // ── Utility agents ────────────────────────────────────────────────────────────
  'vision':               { warnOnly: true },
  'pdf':                  { warnOnly: true },
  'writer':               { warnOnly: true },
  'microtask':            { warnOnly: true },
  'generalist':           { warnOnly: true },
  'fast-generalist':      { warnOnly: true },
  'fast-scout':           { warnOnly: true },
  'long-context':         { warnOnly: true },
  'advisors':             { warnOnly: true },

  // ── Brand-pin leaves (model: pins; leaf/opinion only) ──────────────────────────
  // Populated from config/brand-agents.json below (primaries + aliases).
  // ── Routing-only entries: no agent file; resolve via agent_to_capability only ──
  // routingOnly: true — skip all file checks; only coverage in agent_to_capability is verified.
  'WebSearch': { routingOnly: true },
  'WebFetch':  { routingOnly: true },
  'Monitor':   { routingOnly: true },
};

// Brand catalog → warnOnly roster entries
{
  const brandCat = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'brand-agents.json'), 'utf8'));
  for (const a of brandCat.agents || []) {
    ROSTER[a.id] = { warnOnly: true };
    for (const al of a.aliases || []) {
      const id = typeof al === 'string' ? al : al.id;
      ROSTER[id] = { warnOnly: true };
    }
  }
}

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
