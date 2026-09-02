#!/usr/bin/env node
'use strict';
// Hermetic CLI test for tools/c-thru-agent-usage.js — the passive telemetry tool.
//
// Builds a throwaway Claude config dir with two fake project transcripts, then runs
// the tool with --config-dir pointed at it (no real ~/.claude, no network). Asserts
// the aggregation, the --since and --project filters, and graceful handling of a
// missing config dir. Parsing correctness itself is covered by
// test/agent-offload-lib.test.js.
//
// Run: node test/c-thru-agent-usage.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOL = path.join(__dirname, '..', 'tools', 'c-thru-agent-usage.js');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}

function callLine(uuid, toolUseId, subagentType, ts) {
  return JSON.stringify({
    uuid, timestamp: ts, sessionId: 'sess', promptId: 'p',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { subagent_type: subagentType, description: 'd' } }] },
  });
}
function resultLine(uuid, agentType, tokens, ts) {
  return JSON.stringify({
    uuid: 'r-' + uuid, sourceToolAssistantUUID: uuid, timestamp: ts, type: 'user',
    toolUseResult: { agentType, status: 'completed', totalTokens: tokens, totalDurationMs: 1000, totalToolUseCount: 1 },
  });
}

function runJson(args) {
  const out = execFileSync('node', [TOOL, '--json', ...args], { encoding: 'utf8' });
  return JSON.parse(out);
}

// ── Build a throwaway config dir ──────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-usage-test-'));
try {
  const projA = path.join(tmp, 'projects', '-proj-a');
  const projB = path.join(tmp, 'projects', '-proj-b');
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });

  // proj-a: a plan-reviewer and a code-reviewer (the pair proxy stats can't tell apart)
  fs.writeFileSync(path.join(projA, 'sess1.jsonl'), [
    callLine('a1', 't1', 'plan-reviewer', '2026-06-12T10:00:00.000Z'),
    resultLine('a1', 'plan-reviewer', 500, '2026-06-12T10:01:00.000Z'),
    callLine('a2', 't2', 'code-reviewer', '2026-06-12T11:00:00.000Z'),
    resultLine('a2', 'code-reviewer', 700, '2026-06-12T11:01:00.000Z'),
  ].join('\n') + '\n');

  // proj-b: an older code-reviewer delegation
  fs.writeFileSync(path.join(projB, 'sess2.jsonl'), [
    callLine('b1', 't3', 'code-reviewer', '2026-06-01T09:00:00.000Z'),
    resultLine('b1', 'code-reviewer', 300, '2026-06-01T09:01:00.000Z'),
  ].join('\n') + '\n');

  // ── 1. all projects ─────────────────────────────────────────────────────────
  console.log('\n1. aggregate across all projects, agent-precise');
  {
    const r = runJson(['--config-dir', tmp]);
    const by = Object.fromEntries(r.agents.map((a) => [a.agent, a]));
    assert(r.totals.calls === 3, `3 total delegations (got ${r.totals.calls})`);
    assert(by['plan-reviewer'] && by['plan-reviewer'].calls === 1, `plan-reviewer = 1 call`);
    assert(by['code-reviewer'] && by['code-reviewer'].calls === 2, `code-reviewer = 2 calls (the two collapse to one capability in proxy stats)`);
    assert(by['code-reviewer'] && by['code-reviewer'].tokens === 1000, `code-reviewer tokens summed = 1000 (got ${by['code-reviewer'] && by['code-reviewer'].tokens})`);
  }

  // ── 2. --since filter ─────────────────────────────────────────────────────────
  console.log('\n2. --since excludes older delegations');
  {
    const r = runJson(['--config-dir', tmp, '--since', '2026-06-05']);
    const by = Object.fromEntries(r.agents.map((a) => [a.agent, a]));
    assert(r.totals.calls === 2, `2 delegations on/after 2026-06-05 (got ${r.totals.calls})`);
    assert(by['code-reviewer'] && by['code-reviewer'].calls === 1, `only the 2026-06-12 code-reviewer survives (got ${by['code-reviewer'] && by['code-reviewer'].calls})`);
  }

  // ── 3. --project filter ───────────────────────────────────────────────────────
  console.log('\n3. --project narrows to one project dir');
  {
    const r = runJson(['--config-dir', tmp, '--project', 'proj-b']);
    assert(r.totals.calls === 1, `only proj-b's 1 delegation (got ${r.totals.calls})`);
  }

  // ── 4. missing config dir is graceful (exit 0, empty) ─────────────────────────
  console.log('\n4. missing config dir → graceful empty result');
  {
    const r = runJson(['--config-dir', path.join(tmp, 'does-not-exist')]);
    assert(Array.isArray(r.agents) && r.agents.length === 0, `empty agents array, no crash`);
  }

  // ── 5. C47: `--since --json` errors, does NOT swallow the next flag ───────────
  console.log('\n5. C47: value-flag parsing rejects a following flag as a value');
  {
    let threw = false;
    let stderrMsg = '';
    try {
      // --since with --json next: the old parser set since='--json' and consumed --json.
      execFileSync('node', [TOOL, '--config-dir', tmp, '--since', '--json'], { stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      threw = e.status !== 0;
      stderrMsg = (e.stderr || '').toString();
    }
    assert(threw, '`--since --json` exits non-zero (does not silently consume --json)');
    assert(stderrMsg.includes('--since requires a value'), 'error names the missing --since value');
  }

  // ── 6. C47: a valid --since still works ──────────────────────────────────────
  console.log('\n6. C47: valid --since date still parses and filters');
  {
    const r = runJson(['--config-dir', tmp, '--since', '2026-01-01']);
    assert(r.totals.calls === 3, `valid --since 2026-01-01 keeps all 3 delegations (got ${r.totals.calls})`);

    // A non-ISO --since value is rejected (not silently treated as a no-op).
    let badThrew = false;
    let badStderr = '';
    try {
      execFileSync('node', [TOOL, '--config-dir', tmp, '--since', 'yesterday'], { stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      badThrew = e.status !== 0;
      badStderr = (e.stderr || '').toString();
    }
    assert(badThrew, 'non-ISO --since value exits non-zero');
    assert(badStderr.includes('ISO date'), 'error explains --since must be an ISO date');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
