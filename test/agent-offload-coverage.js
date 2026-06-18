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
// CORPUS: driven by the SHARED labeled corpus test/fixtures/agent-selection-corpus.json
// (the same file the Tier 1 hermetic discriminability lint and the Tier 2a LLM-judge
// consume). It is a strict superset of the legacy test/fixtures/offload-prompts.json,
// which is now unreferenced (left in place for history; safe to delete). Each entry is
// {id, prompt, expect:[primary,...acceptable], note, ambiguous?, inline_ok?}. THREE modes:
//   - normal expect:[...]   — delegating to an expect agent is the win; no-offload is a miss.
//   - ambiguous:true        — carries expect:[]; the WIN is no-offload (decline-only).
//   - inline_ok:true        — carries a NON-EMPTY generalist-tier expect[]; BOTH delegating
//                             to an expect agent AND answering inline (no-offload) are wins;
//                             any non-expect delegation is unexpected.
//
// SCORING:
//   exact            — delegated to the primary expected agent
//   acceptable       — delegated to a listed alternate
//   ambiguous-correct— ambiguous task answered inline (no offload) — a WIN
//   unexpected       — delegated to an agent not in the expected set
//   no-offload       — non-ambiguous task answered inline (informative miss)
//
// MODE — by default ADVISORY (always exit 0): LLM selection is non-deterministic, so a
// local run is signal, not a gate. On CI (process.env.CI) or with C_THRU_OFFLOAD_GATE=1
// it becomes THRESHOLD-GATED: it computes accuracy = (exact+acceptable+ambiguous-correct)
// / scored and exits non-zero if accuracy < THRESHOLD (0.70 — real sessions are noisy,
// so the bar is deliberately permissive) OR if any expect-primary agent is NEVER selected
// across the whole run (a primary that no natural prompt ever reaches = a dead/ambiguous
// description, which is the actionable failure). Authoritative hermetic agent gates remain
// the agent-dispatch-graph + agent-router-hook + agent-description-quality suites.
//
// GATES (else SKIP cleanly): C_THRU_OFFLOAD=1, a usable `claude` binary, tools/c-thru.
//
// Run: C_THRU_OFFLOAD=1 node test/agent-offload-coverage.js          (advisory)
//      C_THRU_OFFLOAD=1 C_THRU_OFFLOAD_GATE=1 node test/agent-offload-coverage.js  (gated)
//   CLAUDE_BIN=...                 path to the claude binary (else PATH)
//   C_THRU_OFFLOAD_TIMEOUT=<secs>  per-prompt timeout (default 180)
//   C_THRU_OFFLOAD_ONLY=<id,...>   run just those fixture ids (debug/cheap smoke)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { extractDelegations } = require('../tools/agent-offload-lib.js');

const REPO = path.resolve(__dirname, '..');
const C_THRU = path.join(REPO, 'tools', 'c-thru');
// Shared labeled corpus (Tier 1 lint + Tier 2a judge + Tier 2b here). Strict superset of
// the legacy test/fixtures/offload-prompts.json (now unreferenced — kept for history).
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'agent-selection-corpus.json');
const AGENTS_DIR = path.join(REPO, 'agents');

// Tasks whose inputs the scratch harness cannot realistically furnish: vision needs a real
// image, pdf needs a real PDF, long-context needs genuinely oversized files. Synthesizing
// stand-ins would only test how Claude handles a fake — not real selection — so we skip them
// in the real-session run. Their selection IS still gated, by Tier 1 (hermetic
// discriminability lint) and Tier 2a (LLM-judge), which feed off the same corpus.
const SKIP_IDS = new Set([
  'vision-screenshot', 'vision-diagram',   // need a real image
  'pdf-table', 'pdf-multicol',             // need a real PDF
  'longctx-needle', 'longctx-bigdoc',      // need genuinely huge files
]);

// CI / explicit gate flips advisory → threshold-gated (see header).
const GATED = process.env.CI === 'true' || process.env.CI === '1' || process.env.C_THRU_OFFLOAD_GATE === '1';
// Real sessions are noisy and LLM selection is non-deterministic; keep the bar permissive.
const THRESHOLD = parseFloat(process.env.C_THRU_OFFLOAD_THRESHOLD || '0.70');

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
const skippedIds = fixtures.filter((f) => SKIP_IDS.has(f.id)).map((f) => f.id);
fixtures = fixtures.filter((f) => !SKIP_IDS.has(f.id));
// C_THRU_OFFLOAD_ONLY=<id[,id...]> runs just those fixtures (debugging / cheap smoke);
// overrides the skip-list so a single skipped id can still be probed by hand.
if (process.env.C_THRU_OFFLOAD_ONLY) {
  const want = new Set(process.env.C_THRU_OFFLOAD_ONLY.split(',').map((s) => s.trim()));
  fixtures = JSON.parse(fs.readFileSync(FIXTURES, 'utf8')).prompts.filter((f) => want.has(f.id));
}

// ambiguous:true entries (and any with an empty expect[]) want NO specialist selected.
function isAmbiguous(f) { return f.ambiguous === true || !Array.isArray(f.expect) || f.expect.length === 0; }
// inline_ok entries have a NON-EMPTY generalist-tier expect[]: delegating to an
// expect agent is a WIN, AND answering inline (no offload) is ALSO a WIN; any
// other delegation is unexpected. Distinct from ambiguous:true (decline-only).
function isInlineOk(f) { return f.inline_ok === true && Array.isArray(f.expect) && f.expect.length > 0; }

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
  if (isAmbiguous(fixture)) {
    // No specialist is the correct answer. Answering inline (no offload) is the WIN; an
    // acceptable explicit pick (if any are listed) is tolerated; any other pick is wrong.
    if (picked.length === 0) return { kind: 'ambiguous-correct', agent: null };
    const ok = picked.find((a) => (fixture.expect || []).includes(a));
    if (ok) return { kind: 'acceptable', agent: ok };
    return { kind: 'unexpected', agent: picked[0] };
  }
  if (isInlineOk(fixture)) {
    // BOTH outcomes are wins: delegating to an expect agent (exact/acceptable) OR
    // answering inline (no offload). Any non-expect delegation is unexpected.
    if (picked.length === 0) return { kind: 'ambiguous-correct', agent: null }; // inline answer — a WIN
    if (picked.includes(fixture.expect[0])) return { kind: 'exact', agent: fixture.expect[0] };
    const altI = picked.find((a) => fixture.expect.includes(a));
    if (altI) return { kind: 'acceptable', agent: altI };
    return { kind: 'unexpected', agent: picked[0] };
  }
  if (picked.length === 0) return { kind: 'no-offload', agent: null };
  if (picked.includes(fixture.expect[0])) return { kind: 'exact', agent: fixture.expect[0] };
  const alt = picked.find((a) => fixture.expect.includes(a));
  if (alt) return { kind: 'acceptable', agent: alt };
  return { kind: 'unexpected', agent: picked[0] };
}

// ── Drive all fixtures ─────────────────────────────────────────────────────────
const modeLabel = GATED ? `GATED (threshold ${THRESHOLD})` : 'advisory';
const skipNote = skippedIds.length ? `, ${skippedIds.length} skipped (vision/pdf/long-context — see Tier 1/2a)` : '';
console.log(`agent-offload-coverage: ${fixtures.length} natural prompts, ${TIMEOUT_S}s each — ${modeLabel}${skipNote}\n`);
if (skippedIds.length) console.log(`  skipped ids: ${skippedIds.join(', ')}\n`);
const selectedCount = Object.create(null);
let injectedAgents = null;
const tally = { exact: 0, acceptable: 0, 'ambiguous-correct': 0, unexpected: 0, 'no-offload': 0, errored: 0 };

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
      console.log(`  ${'ERROR'.padEnd(17)} ${f.id.padEnd(24)} session error${r.timedOut ? ' (timeout)' : ''} — ${r.stderrTail || 'see stderr'}`);
      continue;
    }
    const s = score(f, picked);
    tally[s.kind]++;
    const expectStr = (f.expect && f.expect.length) ? f.expect.join('|') : 'none (ambiguous)';
    const detail = s.kind === 'exact' ? s.agent
      : s.kind === 'acceptable' ? `${s.agent} (alt; expected ${expectStr})`
      : s.kind === 'ambiguous-correct' ? 'answered inline (no specialist — correct)'
      : s.kind === 'unexpected' ? `${s.agent} (expected ${expectStr})`
      : `expected ${expectStr}`;
    console.log(`  ${s.kind.toUpperCase().padEnd(17)} ${f.id.padEnd(24)} ${detail}`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ── Scorecard ──────────────────────────────────────────────────────────────────
console.log('\n── scorecard ──');
console.log(`  exact ${tally.exact}  acceptable ${tally.acceptable}  ambiguous-correct ${tally['ambiguous-correct']}  unexpected ${tally.unexpected}  no-offload ${tally['no-offload']}  errored ${tally.errored}`);

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

// ── Accuracy + (CI) threshold gate ──────────────────────────────────────────────
// Denominator excludes session errors (infra noise, not a selection signal).
const scored = tally.exact + tally.acceptable + tally['ambiguous-correct'] + tally.unexpected + tally['no-offload'];
const correct = tally.exact + tally.acceptable + tally['ambiguous-correct'];
const accuracy = scored ? correct / scored : 0;
console.log(`\n  accuracy: ${correct}/${scored} = ${(accuracy * 100).toFixed(1)}%  (threshold ${(THRESHOLD * 100).toFixed(0)}% when gated)`);

// expect-primaries that NO natural prompt in this run ever reached = dead/ambiguous
// descriptions. Only count primaries among the fixtures we actually ran (skip-list aside),
// and EXCLUDE inline_ok primaries: for those, answering inline is an accepted win, so a
// generalist-tier agent never being delegated to is NOT evidence of a dead description.
const expectedPrimaries = [...new Set(
  fixtures.filter((f) => !isAmbiguous(f) && !isInlineOk(f)).map((f) => f.expect[0]),
)].sort();
const primariesNeverPicked = expectedPrimaries.filter((a) => !selectedCount[a]);
if (primariesNeverPicked.length) {
  console.log(`\n  WARN expect-primary agents never selected (${primariesNeverPicked.length}): ${primariesNeverPicked.join(', ')}`);
}

if (!GATED) {
  console.log('\n(advisory — never fails the suite; authoritative gates: agent-dispatch-graph, agent-router-hook, agent-description-quality)');
  process.exit(0);
}

// CI / C_THRU_OFFLOAD_GATE=1: turn the scorecard into a gate.
const failures = [];
if (scored === 0) failures.push('no fixtures scored (all errored?) — cannot assess selection');
if (scored > 0 && accuracy < THRESHOLD) failures.push(`accuracy ${(accuracy * 100).toFixed(1)}% < threshold ${(THRESHOLD * 100).toFixed(0)}%`);
if (primariesNeverPicked.length) failures.push(`expect-primary never selected: ${primariesNeverPicked.join(', ')}`);
if (failures.length) {
  console.log(`\nFAIL  agent-offload-coverage (gated):\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nPASS  agent-offload-coverage (gated): accuracy and primary-coverage thresholds met');
process.exit(0);
