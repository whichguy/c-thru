#!/usr/bin/env node
'use strict';
// ADVISORY agent-offload COVERAGE harness — "are our agents actually getting picked?"
//
// WHAT IT MEASURES — whether c-thru's INJECTED agent descriptions, on their own, make
// Claude delegate to the right subagent for a NATURAL prompt. Unlike the scenario
// e2e (which says "use the reviewer-security subagent via the Task tool — dispatch
// now"), these prompts never name an agent or mention the Task tool. The win
// condition is description-driven selection, the way a real user triggers it.
//
// HOW — for each fixture prompt, run
//     bash tools/c-thru -p "<prompt>" --output-format stream-json --verbose
// c-thru injects the 22 agents (--agents) + the delegate-by-description nudge
// (--append-system-prompt) as explicit flags (tools/c-thru ~L3638-3663), so the
// injection survives headless mode. We parse the stream-json with the shared
// agent-offload-lib (PARSE-not-grep) and score each prompt:
//   exact      — delegated to the primary expected agent
//   acceptable — delegated to a listed alternate
//   unexpected — delegated to an agent not in the expected set
//   no-offload — answered inline (informative, not necessarily wrong)
// Output is a scorecard + a NEVER-SELECTED list (agents no natural prompt reached =
// effectively dead descriptions — the actionable feedback for description tuning).
//
// ADVISORY: LLM selection is non-deterministic, so this NEVER fails the suite (always
// exits 0). Treat it as signal. Authoritative agent gates are the hermetic
// agent-dispatch-graph + agent-router-hook + agent-description-quality suites.
//
// GATES (else SKIP cleanly): C_THRU_OFFLOAD=1, a usable `claude` binary, tools/c-thru.
//
// Run: C_THRU_OFFLOAD=1 node test/agent-offload-coverage.js
//   CLAUDE_BIN=...                 path to the claude binary (else PATH)
//   C_THRU_OFFLOAD_TIMEOUT=<secs>  per-prompt timeout (default 180)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { extractDelegations } = require('../tools/agent-offload-lib.js');

const REPO = path.resolve(__dirname, '..');
const C_THRU = path.join(REPO, 'tools', 'c-thru');
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'offload-prompts.json');
const AGENTS_DIR = path.join(REPO, 'agents');

function skip(msg) { console.log(`SKIP  agent-offload-coverage: ${msg}`); process.exit(0); }

// ── Gates ─────────────────────────────────────────────────────────────────────
if (process.env.C_THRU_OFFLOAD !== '1') {
  skip('set C_THRU_OFFLOAD=1 to enable (advisory; drives real `claude -p` sessions, costs tokens)');
}
let claudeBin = process.env.CLAUDE_BIN;
if (!claudeBin) {
  try { claudeBin = execFileSync('command', ['-v', 'claude'], { shell: '/bin/bash', encoding: 'utf8' }).trim(); }
  catch (_e) { claudeBin = ''; }
}
if (!claudeBin) skip('no usable `claude` binary (set CLAUDE_BIN=...)');
if (!fs.existsSync(C_THRU)) skip('tools/c-thru not found');

const TIMEOUT_S = parseInt(process.env.C_THRU_OFFLOAD_TIMEOUT || '180', 10);
const roster = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort();
let fixtures = JSON.parse(fs.readFileSync(FIXTURES, 'utf8')).prompts;
// C_THRU_OFFLOAD_ONLY=<id[,id...]> runs just those fixtures (debugging / cheap smoke).
if (process.env.C_THRU_OFFLOAD_ONLY) {
  const want = new Set(process.env.C_THRU_OFFLOAD_ONLY.split(',').map((s) => s.trim()));
  fixtures = fixtures.filter((f) => want.has(f.id));
}

// ── Scratch files referenced by the prompts ───────────────────────────────────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-offload-'));
const PY = path.join(scratch, 'clamp.py');
const PLAN = path.join(scratch, 'plan.md');
fs.writeFileSync(PY, [
  'def clamp(value, low, high):',
  '    """Clamp value into the inclusive range [low, high]."""',
  '    if value < low:',
  '        return high   # returns the wrong bound for below-range inputs',
  '    if value > high:',
  '        return high',
  '    return value',
  '',
  'def merge_sorted(a, b):',
  '    return sorted(a + b)',
  '',
].join('\n'));
fs.writeFileSync(PLAN, [
  '# Plan: add a /healthz endpoint',
  '',
  '1. Add a route that returns 200.',
  '2. Ship it.',
  '',
].join('\n'));

function subst(s) { return s.split('{{PY}}').join(PY).split('{{PLAN}}').join(PLAN).split('{{DIR}}').join(scratch); }

// ── Run one prompt through c-thru, return parsed events ────────────────────────
function runPrompt(prompt) {
  const res = spawnSync('bash', [C_THRU, '-p', prompt, '--output-format', 'stream-json', '--verbose'], {
    encoding: 'utf8',
    timeout: TIMEOUT_S * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { C_THRU_NO_UPDATE: '1', CLAUDE_BIN: claudeBin }),
  });
  const objs = [];
  let initEvent = null;
  let resultEvent = null;
  for (const line of (res.stdout || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch (_e) { continue; }
    objs.push(o);
    if (o.type === 'system' && o.subtype === 'init') initEvent = o;
    if (o.type === 'result') resultEvent = o;
  }
  return {
    delegations: extractDelegations(objs),
    initEvent, resultEvent,
    timedOut: res.error && res.error.code === 'ETIMEDOUT',
    stderrTail: (res.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | '),
  };
}

function score(fixture, picked) {
  if (picked.length === 0) return { kind: 'no-offload', agent: null };
  if (picked.includes(fixture.expect[0])) return { kind: 'exact', agent: fixture.expect[0] };
  const alt = picked.find((a) => fixture.expect.includes(a));
  if (alt) return { kind: 'acceptable', agent: alt };
  return { kind: 'unexpected', agent: picked[0] };
}

// ── Drive all fixtures ─────────────────────────────────────────────────────────
console.log(`agent-offload-coverage: ${fixtures.length} natural prompts, ${TIMEOUT_S}s each (advisory)\n`);
const selectedCount = Object.create(null);
let injectedAgents = null;
const tally = { exact: 0, acceptable: 0, unexpected: 0, 'no-offload': 0, errored: 0 };

try {
  for (const f of fixtures) {
    const prompt = subst(f.prompt);
    const r = runPrompt(prompt);
    if (injectedAgents === null && r.initEvent && Array.isArray(r.initEvent.agents)) {
      injectedAgents = r.initEvent.agents;
    }
    const picked = r.delegations.map((d) => d.subagent_type).filter(Boolean);
    for (const a of picked) selectedCount[a] = (selectedCount[a] || 0) + 1;

    if (r.resultEvent && r.resultEvent.is_error && picked.length === 0) {
      tally.errored++;
      console.log(`  ${'ERROR'.padEnd(11)} ${f.id.padEnd(20)} session error${r.timedOut ? ' (timeout)' : ''} — ${r.stderrTail || 'see stderr'}`);
      continue;
    }
    const s = score(f, picked);
    tally[s.kind]++;
    const detail = s.kind === 'exact' ? s.agent
      : s.kind === 'acceptable' ? `${s.agent} (alt; primary=${f.expect[0]})`
      : s.kind === 'unexpected' ? `${s.agent} (expected ${f.expect.join('|')})`
      : `expected ${f.expect.join('|')}`;
    console.log(`  ${s.kind.toUpperCase().padEnd(11)} ${f.id.padEnd(20)} ${detail}`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ── Scorecard ──────────────────────────────────────────────────────────────────
console.log('\n── scorecard ──');
console.log(`  exact ${tally.exact}  acceptable ${tally.acceptable}  unexpected ${tally.unexpected}  no-offload ${tally['no-offload']}  errored ${tally.errored}`);

// init event `agents[]` elements may be names (strings) or objects — handle both.
function agentName(x) { return typeof x === 'string' ? x : (x && (x.name || x.type || x.agentType)) || null; }
if (injectedAgents) {
  const injectedNames = injectedAgents.map(agentName).filter(Boolean);
  const present = roster.filter((a) => injectedNames.includes(a));
  const presentNote = injectedNames.length
    ? ` — ${present.length}/${roster.length} roster agents present${present.length < roster.length ? ` (missing: ${roster.filter((a) => !injectedNames.includes(a)).join(', ')})` : ''}`
    : '';
  console.log(`\n  injection: init event listed ${injectedAgents.length} agents (22 c-thru + built-ins)${presentNote}`);
} else {
  const totalPicked = Object.values(selectedCount).reduce((a, b) => a + b, 0);
  console.log(`\n  injection: init event did not expose an agents[] field; ${totalPicked} delegation(s) observed — delegation implies injection worked`);
}

const selected = Object.keys(selectedCount).sort();
if (selected.length) {
  console.log('\n  agents selected (count):');
  for (const a of selected.sort((x, y) => selectedCount[y] - selectedCount[x])) {
    console.log(`    ${String(selectedCount[a]).padStart(3)}  ${a}`);
  }
}

const neverSelected = roster.filter((a) => !selectedCount[a]);
console.log(`\n  never selected by any prompt (${neverSelected.length}/${roster.length}) — candidates for description tuning or more fixtures:`);
console.log(`    ${neverSelected.join(', ') || '(none)'}`);

console.log('\n(advisory — never fails the suite; authoritative gates: agent-dispatch-graph, agent-router-hook, agent-description-quality)');
process.exit(0);
