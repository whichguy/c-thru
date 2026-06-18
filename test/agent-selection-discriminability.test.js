#!/usr/bin/env node
'use strict';
// Agent-selection DISCRIMINABILITY lint (Tier 1: hermetic, deterministic, no API key).
//
// SCOPE / HONESTY (read first):
//   This suite does NOT prove that Claude Code's Agent tool will pick the right
//   subagent. Real selection is an LLM reading the natural-language descriptions;
//   that is the Tier-2a LLM-judge and Tier-2b real-session tiers (see the corpus
//   header). What THIS suite does is a DRIFT / OVERLAP GUARD using a pure LEXICAL
//   proxy (token Jaccard over stopword-stripped content words). It answers two
//   cheaper questions that an LLM-free lint CAN answer deterministically and
//   gate every commit on:
//     1. Do any two agent descriptions claim the SAME lexical space (overlap)
//        without an explicit disambiguation clause pointing at each other?
//     2. For the labeled corpus, is the INTENDED agent the closest lexical match
//        (or near-top), and does every primary agent win at least one task?
//   A lexical proxy is a weak stand-in for meaning: a high lexical match does not
//   guarantee correct selection, and a low one does not guarantee a wrong pick
//   (the corpus is deliberately phrased to AVOID reusing the descriptions' own
//   example phrases — the NON-CIRCULARITY RULE — so some tasks legitimately
//   cannot win on lexical overlap alone; those are documented blind spots below).
//   The value here is REGRESSION pressure: descriptions converging, a
//   disambiguation clause deleted, or an agent's description rewritten so it stops
//   matching its own corpus tasks will all trip this lint while it stays green on
//   the current fleet+corpus.
//
// Three checks (A pairwise-overlap, B corpus-top-match, C dead-description),
// plus an ambiguous-floor check, all over the REAL agents/*.md descriptions and
// the REAL test/fixtures/agent-selection-corpus.json. Thresholds are BASELINED
// against the current fleet (printed below for visibility) and chosen so the
// suite passes today yet a genuine regression would bite.
//
// Exit is gated on summary() (enforced by test/exit-code-gating.test.js).
//
// Run: node test/agent-selection-discriminability.test.js

const fs   = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}
function summary() {
  const total = passed + failed;
  console.log(`\n${passed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
  return failed;
}

const REPO        = path.resolve(__dirname, '..');
const AGENTS_DIR  = path.join(REPO, 'agents');
const CORPUS_PATH = path.join(REPO, 'test', 'fixtures', 'agent-selection-corpus.json');
const AGENT_FILES = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')).sort();

// ── Lexical metric ───────────────────────────────────────────────────────────
// Token Jaccard over lowercased content words, stopword-stripped. Stopwords
// include ordinary English function words AND the trigger-grammar words that the
// description-quality convention forces into EVERY description ("use", "when",
// "for", "after", "must", "proactively", "instead", "prefer", ...). Leaving
// those in would inflate every pair's similarity uniformly (shared boilerplate),
// drowning the signal we actually want — the topical content words ("auth",
// "screenshot", "plan", "race"). Tokens are >=2 chars; "+"/"-" kept inside a
// token so "c++" / "coder-fallback" survive.
const STOPWORDS = new Set((`
  a an and or the to of for in on at by with from as is are be been being
  use used using uses this that these those it its their your you we our
  i me my not no any all over under into out up down off about than then
  them they he she his her him proactively must when after first instead
  prefer does do done before each every more most less few many much some
  other another such same so if but per via etc eg ie which what who whom
  whose where why how also only just very too new can will shall should
  would could may might has have had need needs needed get gets got make
  makes made
`).trim().split(/\s+/));

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9+-]*/g) || [])
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

function jaccard(aSet, bSet) {
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter++;
  const uni = aSet.size + bSet.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

// The "Routes to <model/capability> ..." tail of a description is plumbing
// metadata, not selection signal — and it shares vocabulary across many agents
// ("claude-sonnet-4-6 connected", "local", "tiers"), so leaving it in would
// manufacture spurious overlap. Strip it before scoring.
function selectionText(desc) {
  return desc.replace(/Routes to[^.]*\.?/gi, ' ');
}

function parseDescription(body) {
  const m = body.match(/^description:[ \t]*(.+?)[ \t]*$/m);
  return m ? m[1] : null;
}

// ── Disambiguation awareness ─────────────────────────────────────────────────
// Two descriptions are ALLOWED to overlap if at least one explicitly names the
// other inside a disambiguation clause ("Not for X — use Y", "use X instead",
// "prefer X", "rather than", "escalate from X", or a directive "use X" / "use X
// for ..."). The fleet has legitimate near-neighbour clusters (writer/docs,
// explore/fast-scout, planner/planner-hard, the debugger trio, the reviewer
// trio, generalist/fast-generalist, pdf/vision, coder/coder-fallback) that
// resolve their overlap exactly this way. namesInDisambig(descA, B) returns the
// offending clause if descA names agent B in a disambiguation context.
const DISAMBIG_MARKERS = [
  /\bnot for\b/i,
  /\binstead\b/i,
  /\bprefer\b/i,
  /\brather than\b/i,
  /\bescalate from\b/i,
  /\bdoes not\b/i,
  /\buse [a-z]/i,   // directive "use <agent> ..." / "use <agent> for ..."
];
function namesInDisambig(descA, otherName) {
  // Split into clause-ish spans on sentence terminators, em-dash, semicolon.
  const spans = descA.split(/(?<=[.!?])\s+|—|;/);
  const nameRe = new RegExp(`\\b${otherName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`);
  for (const s of spans) {
    if (!nameRe.test(s)) continue;
    if (DISAMBIG_MARKERS.some(re => re.test(s))) return s.trim();
  }
  return null;
}
function pairDisambiguated(a, b) {
  return namesInDisambig(a.desc, b.name) || namesInDisambig(b.desc, a.name);
}

// ── Load the fleet ───────────────────────────────────────────────────────────
const agents = AGENT_FILES.map(f => {
  const name = f.replace(/\.md$/, '');
  const desc = parseDescription(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8')) || '';
  return { name, desc, tokens: new Set(tokenize(selectionText(desc))) };
});
const byName = Object.fromEntries(agents.map(a => [a.name, a]));

// Deterministic ranking of a query (task text) against all descriptions.
// Tie-break: higher score first, then agent name ascending — so the ranking is
// reproducible run-to-run regardless of fs.readdir order or V8 sort stability.
function rankQuery(text) {
  const q = new Set(tokenize(text));
  return agents
    .map(a => ({ name: a.name, score: jaccard(q, a.tokens) }))
    .sort((x, y) => (y.score - x.score) || (x.name < y.name ? -1 : 1));
}

// ── Corpus ───────────────────────────────────────────────────────────────────
const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')).prompts;
// Hermetic placeholder substitution (mirrors the corpus header contract):
// {{PY}}→"the code file", {{DIR}}→"the directory", {{PLAN}}→"the plan file".
function subst(prompt) {
  return prompt
    .replace(/\{\{PY\}\}/g,   'the code file')
    .replace(/\{\{DIR\}\}/g,  'the directory')
    .replace(/\{\{PLAN\}\}/g, 'the plan file');
}

// ── Baselined thresholds (see the printed baselines below for justification) ──
//
// (A) Pairwise overlap. Baselined 2026-06: the single non-exempt pair nearest
//     collision is code-reviewer/tester at ~0.21 (both speak "review / check /
//     correctness / edge cases / coverage" — genuinely distinct roles, no
//     disambiguation clause). The only pair ABOVE the threshold today is the
//     legitimate near-neighbour explore/fast-scout (~0.26), which IS
//     disambiguated. PAIR_OVERLAP_MAX is set just under explore/fast-scout and
//     just over code-reviewer/tester so the check (a) passes today, (b) actively
//     exercises the disambiguation exemption (one pair relies on it), and (c)
//     bites if explore/fast-scout loses its clause OR any unrelated pair
//     converges past ~0.22.
const PAIR_OVERLAP_MAX = 0.22;
//
// (B) Corpus top-match. Most tasks: the intended agent (any of expect[]) must be
//     the #1 lexical match. A short, documented allowlist relaxes to top-2
//     (rank <= 1) where a legitimate near-neighbour edges out the intended agent
//     lexically. A second documented allowlist marks tasks the lexical proxy
//     genuinely cannot resolve (the NON-CIRCULARITY RULE stripped all shared
//     vocabulary) — these are reported as blind spots, asserted only not to grow.
const TOP2_RANK = 1; // 0-indexed: rank 0 or 1 counts as "near-top"
//
//   top-2 (intended agent edged to rank 1 by an acceptable neighbour):
const CORPUS_TOP2_ALLOW = new Map([
  ['tester-edge',    'coder (expect[1]) edges tester on "behaves correctly / function / input" overlap'],
  ['explore-usages', 'explore at rank 1 behind coder; "defined / calls / repo" pulls coder slightly higher'],
]);
//   blind spots (lexical proxy cannot make the intended agent even top-2):
const CORPUS_BLIND_SPOTS = new Map([
  ['dbg-unknown-cause',
    'all descriptions score 0.000 — the prompt ("no idea why ... where would you even start") shares zero ' +
    'content tokens with any debugger description after stopword strip; an LLM reads intent, lexical proxy cannot.'],
  ['explore-locate',
    'intended explore at rank ~6 (0.034 vs top 0.074); "validates its inputs" pulls code-reviewer/tester/' +
    'reviewer-security; the read-only-recon intent is semantic, not lexical.'],
  ['amb-trivial-q',
    'inline_ok task (decisive, not ambiguous): intended fast-generalist/generalist BOTH score 0.000 — the ' +
    'NON-CIRCULARITY prompt ("what does the acronym TTL stand for") shares zero content tokens with the ' +
    'generalist-tier descriptions ("quick / one-line / TL;DR") after stopword strip, so top-3 is ' +
    'explore/long-context/fast-scout at ~0.04 and the intended agents tie at rank 11/12. The "quick factual ' +
    'one-liner → fast-generalist" mapping is semantic intent the lexical proxy cannot see; an LLM judge can ' +
    '(Tier 2a). fast-generalist still wins tester-edge, so check (C) is unaffected.'],
]);
// Hard cap: the blind-spot list must not silently grow. Raised 2→3 on 2026-06
// when amb-trivial-q was relabeled from ambiguous to inline_ok (decisive): it
// became subject to check (B), and its intended generalist-tier agents are a
// genuine lexical blind spot (see the entry above) — NOT a threshold loosening.
const CORPUS_BLIND_SPOT_MAX = 3;
//
// (D) Ambiguous floor. ambiguous:true tasks (expect:[]) must look like a WEAK
//     match to everything — no agent should score above this absolute floor.
//     This applies ONLY to genuine decline tasks (ambiguous:true). inline_ok
//     tasks are DECISIVE (non-empty generalist-tier expect[]) and are explicitly
//     EXCLUDED — amb-tradeoffs → generalist at ~0.167 is the CORRECT pick, not a
//     floor violation, which is exactly why it was relabeled out of ambiguous.
//     Baselined (2026-06, after the relabel): the strongest remaining ambiguous
//     match is amb-greeting → debugger-investigate at ~0.056; every ambiguous
//     top is now <= 0.056. Floor kept at 0.20 with generous headroom; it bites
//     if a specialist description drifts into claiming conversational prompts.
const AMBIGUOUS_FLOOR = 0.20;

console.log(`agent-selection-discriminability: ${agents.length} agents, ` +
  `${corpus.length} corpus prompts (${corpus.filter(c => c.ambiguous === true).length} ambiguous, ` +
  `${corpus.filter(c => c.inline_ok === true).length} inline_ok→decisive)\n`);

// ════════════════════════════════════════════════════════════════════════════
// (A) PAIRWISE OVERLAP
// ════════════════════════════════════════════════════════════════════════════
console.log('── (A) Pairwise description overlap (token Jaccard) ──');
console.log(`    threshold: a pair > ${PAIR_OVERLAP_MAX} must be disambiguated (one names the other)\n`);

const pairs = [];
for (let i = 0; i < agents.length; i++) {
  for (let j = i + 1; j < agents.length; j++) {
    pairs.push({ a: agents[i], b: agents[j], score: jaccard(agents[i].tokens, agents[j].tokens) });
  }
}
pairs.sort((x, y) => y.score - x.score);

// Print the baseline: the top overlapping pairs, with their exemption status.
console.log('    top overlapping pairs (baseline visibility):');
for (const p of pairs.slice(0, 12)) {
  const dis = pairDisambiguated(p.a, p.b);
  console.log(`      ${p.score.toFixed(3)}  ${dis ? 'disambig' : '        '}  ${p.a.name} / ${p.b.name}`);
}
console.log('');

for (const p of pairs) {
  if (p.score <= PAIR_OVERLAP_MAX) continue; // only over-threshold pairs need the exemption
  const clause = pairDisambiguated(p.a, p.b);
  assert(clause !== null,
    `${p.a.name} / ${p.b.name}: overlap ${p.score.toFixed(3)} > ${PAIR_OVERLAP_MAX} is resolved by a ` +
    `disambiguation clause` + (clause ? ` ("${clause}")` : ' — NONE FOUND; two descriptions claim the same space'));
}
// If NO pair is above threshold, the disambiguation exemption is never exercised
// and the check has quietly gone slack (e.g. someone lowered all overlaps or the
// metric broke). Assert at least one over-threshold pair exists AND is exempted,
// so the exemption path stays live.
{
  const above = pairs.filter(p => p.score > PAIR_OVERLAP_MAX);
  assert(above.length >= 1,
    `at least one legitimate near-neighbour pair exceeds ${PAIR_OVERLAP_MAX} (keeps the disambiguation ` +
    `exemption exercised; got ${above.length})`);
  if (above.length) {
    assert(above.every(p => pairDisambiguated(p.a, p.b)),
      `every over-threshold pair is disambiguation-exempt (the check would bite an un-exempted one)`);
  }
}

// Self-test: a synthetic DUPLICATE pair with NO disambiguation MUST be flagged,
// and the same pair WITH a disambiguation clause MUST be exempted. Keeps the
// heuristic honest — if a refactor loosens it into a no-op, this trips.
{
  const dupText = 'Use for implementing and editing code, writing functions and refactoring files.';
  const A = { name: 'synth-a', desc: dupText, tokens: new Set(tokenize(selectionText(dupText))) };
  const B = { name: 'synth-b', desc: dupText, tokens: new Set(tokenize(selectionText(dupText))) };
  const score = jaccard(A.tokens, B.tokens);
  assert(score > PAIR_OVERLAP_MAX,
    `self-test: identical descriptions overlap ${score.toFixed(3)} > ${PAIR_OVERLAP_MAX}`);
  assert(pairDisambiguated(A, B) === null,
    `self-test: a duplicate pair with NO disambiguation clause is flagged (not exempted)`);
  const Bdis = { name: 'synth-b', desc: dupText + ' Not for trivial edits — use synth-a instead.',
    tokens: new Set(tokenize(selectionText(dupText))) };
  assert(pairDisambiguated(A, Bdis) !== null,
    `self-test: adding "use synth-a instead" exempts the same duplicate pair`);
}

// ════════════════════════════════════════════════════════════════════════════
// (B) CORPUS TOP-MATCH
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── (B) Corpus top-match (intended agent is the closest lexical match) ──\n');

// "non-ambiguous" = DECISIVE tasks: every task with a definite expectation. This
// keys on ambiguous:true, NOT on an empty expect[] — an inline_ok task carries a
// NON-EMPTY generalist-tier expect[] and is decisive, so it IS subject to (B)/(C).
// Only genuine ambiguous:true (expect:[]) decline tasks are excluded here and
// handled by the (D) ambiguous floor below.
const nonAmbiguous = corpus.filter(t => t.ambiguous !== true);
const winnersByTask = {};       // taskId -> rank0 agent name (for check C)
const observedBlindSpots = [];
let strictTop1 = 0, top2 = 0;

for (const task of nonAmbiguous) {
  const ranked = rankQuery(subst(task.prompt));
  winnersByTask[task.id] = ranked[0].name;
  const expect = new Set(task.expect);
  const top3 = ranked.slice(0, 3).map(r => `${r.name}:${r.score.toFixed(2)}`).join(' ');

  if (CORPUS_BLIND_SPOTS.has(task.id)) {
    // Documented lexical blind spot — report, do not gate on a pass.
    observedBlindSpots.push(task.id);
    console.log(`  NOTE  ${task.id}: documented lexical blind spot [${top3}] ` +
      `(intended ${task.expect.join('/')}) — ${CORPUS_BLIND_SPOTS.get(task.id)}`);
    continue;
  }

  const rank0ok = expect.has(ranked[0].name);
  const top2ok  = ranked.slice(0, TOP2_RANK + 1).some(r => expect.has(r.name));

  if (CORPUS_TOP2_ALLOW.has(task.id)) {
    assert(top2ok,
      `${task.id}: an intended agent (${task.expect.join('/')}) is within top-${TOP2_RANK + 1} ` +
      `[${top3}] — allowlisted as top-2: ${CORPUS_TOP2_ALLOW.get(task.id)}`);
    if (top2ok) (rank0ok ? strictTop1++ : top2++);
  } else {
    assert(rank0ok,
      `${task.id}: an intended agent (${task.expect.join('/')}) is the #1 lexical match [${top3}]`);
    if (rank0ok) strictTop1++;
  }
}

// The blind-spot list must not silently grow: any NEW task that drops out of
// top-2 must be examined and explicitly classified, not absorbed.
for (const task of nonAmbiguous) {
  if (CORPUS_BLIND_SPOTS.has(task.id) || CORPUS_TOP2_ALLOW.has(task.id)) continue;
  const ranked = rankQuery(subst(task.prompt));
  const expect = new Set(task.expect);
  const top2ok = ranked.slice(0, TOP2_RANK + 1).some(r => expect.has(r.name));
  if (!top2ok) {
    assert(false,
      `${task.id}: intended ${task.expect.join('/')} fell out of top-${TOP2_RANK + 1} and is NOT allowlisted ` +
      `— classify it as CORPUS_TOP2_ALLOW or CORPUS_BLIND_SPOTS (with a reason), do not let the guard rot`);
  }
}
assert(observedBlindSpots.length <= CORPUS_BLIND_SPOT_MAX,
  `lexical blind-spot count (${observedBlindSpots.length}) within cap ${CORPUS_BLIND_SPOT_MAX} ` +
  `(${observedBlindSpots.join(', ') || 'none'}) — a growing list means descriptions/corpus drifted apart`);
console.log(`\n    baseline: ${strictTop1} strict-top-1, ${top2} top-2, ${observedBlindSpots.length} blind-spot ` +
  `of ${nonAmbiguous.length} non-ambiguous tasks`);

// ════════════════════════════════════════════════════════════════════════════
// (C) DEAD-DESCRIPTION
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── (C) Dead-description (every primary agent wins ≥1 task) ──\n');

const primaries = new Set(nonAmbiguous.filter(t => t.expect.length).map(t => t.expect[0]));
const everWins  = new Set(Object.values(winnersByTask));

for (const primary of [...primaries].sort()) {
  if (everWins.has(primary)) {
    assert(true, `${primary}: is the top lexical match for at least one corpus task`);
    continue;
  }
  // An agent that never wins is OK ONLY if every corpus task naming it as primary
  // is a documented blind spot (its loss is the lexical proxy's, not the
  // description's). Otherwise it is a dead description — flag it.
  const itsPrimaryTasks = nonAmbiguous.filter(t => t.expect[0] === primary).map(t => t.id);
  const allBlind = itsPrimaryTasks.every(id => CORPUS_BLIND_SPOTS.has(id));
  assert(allBlind,
    `${primary}: never the top match, but every task it leads is a documented blind spot ` +
    `(${itsPrimaryTasks.join(', ')}) — otherwise this is a dead description (rewrite to attract its tasks)`);
  if (allBlind) {
    console.log(`  NOTE  ${primary}: never top-1, but its only primary task(s) (${itsPrimaryTasks.join(', ')}) ` +
      `are documented lexical blind spots`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// (D) AMBIGUOUS FLOOR
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── (D) Ambiguous floor (no specialist matches a non-task prompt strongly) ──\n');

// Keys on ambiguous:true (NOT empty expect) — inline_ok entries are decisive and
// must NOT be subject to the ambiguous floor (their generalist pick is correct,
// e.g. amb-tradeoffs → generalist at ~0.167, which would otherwise trip the floor).
const ambiguous = corpus.filter(t => t.ambiguous === true);
let maxAmb = 0, maxAmbId = null, maxAmbAgent = null;
for (const task of ambiguous) {
  const ranked = rankQuery(subst(task.prompt));
  const top = ranked[0];
  if (top.score > maxAmb) { maxAmb = top.score; maxAmbId = task.id; maxAmbAgent = top.name; }
  assert(top.score < AMBIGUOUS_FLOOR,
    `${task.id}: top lexical match ${top.name}:${top.score.toFixed(3)} stays below the floor ` +
    `${AMBIGUOUS_FLOOR} (ambiguous prompts must look weak to every specialist)`);
}
console.log(`\n    baseline: strongest ambiguous match is ${maxAmbId} → ${maxAmbAgent}:${maxAmb.toFixed(3)} ` +
  `(floor ${AMBIGUOUS_FLOOR})`);

// ── Exit gate (enforced by test/exit-code-gating.test.js) ────────────────────
const _failed = summary();
process.exit(_failed > 0 ? 1 : 0);
