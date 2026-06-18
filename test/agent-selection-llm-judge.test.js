#!/usr/bin/env node
'use strict';
// Agent-selection LLM-judge (Tier 2a) — opt-in live cloud test.
//
// Question this answers: do the agent DESCRIPTIONS alone — the exact text
// tools/c-thru injects via the Agent tool's `--agents` JSON — let a model pick
// the right subagent for a real task? agent-description-quality.test.js lints
// each description's *shape* (trigger phrase, specificity signal) with regexes;
// it explicitly punts on semantic overlap ("two agents claiming the same task
// needs an LLM judge, not a regex"). THIS is that judge.
//
// Mechanism (isolated — NO Claude Code session, NO proxy):
//   1. Build {name: description} from agents/*.md (parsed exactly like
//      agent-description-quality.test.js's parseDescription).
//   2. For each corpus task, make ONE direct HTTPS call to api.anthropic.com
//      (the same wire pattern judge-canary uses against the real API, but
//      direct rather than through the proxy — the proxy would route/translate,
//      which is a different system under test). The model is told it is the
//      subagent selector and must output ONLY one subagent_type, or 'none'.
//   3. Score the pick against the labeled corpus and assert an aggregate
//      threshold — this is the gate the nightly CI runs.
//
// Scoring (per test/fixtures/agent-selection-corpus.json — THREE label modes):
//   - normal expect:[...] task: exact if pick==expect[0]; acceptable if
//     pick∈expect[]; else miss.
//   - inline_ok task (NON-EMPTY expect:[...] of generalist-tier agents +
//     inline_ok:true): correct if pick∈expect[] (exact/acceptable) OR pick is
//     'none'/empty (declining / answering inline is ALSO fine — outcome
//     'inline-correct'); picking any agent NOT in expect[] is a miss.
//   - ambiguous task (ambiguous:true, expect:[]): correct only if pick=='none'/
//     empty; any specialist pick is a miss.
//
// Two BUCKETS (each gated on its own threshold):
//   - DECISIVE = every task with a definite expectation — normal expect[] AND
//     inline_ok tasks. These must be picked decisively; the hard gate lives here.
//   - DECLINE  = ambiguous:true tasks. These must be declined; a looser floor.
//   per-bucket accuracy = (its correct outcomes) / (its task count).
//
// Gating (matches the repo's live-suite convention — see
// anthropic-api-coverage-live.test.js / judge-canary.test.js):
//   - SKIP cleanly (print SKIP, exit 0) unless C_THRU_LIVE_SELECTION=1.
//   - SKIP cleanly if ANTHROPIC_API_KEY is unset. The no-key path STILL runs a
//     DRY self-test (stubbed judge, no network) that exercises the bucketed
//     scoring/threshold logic, then exits on summary().
//   - When enabled it runs for real and ASSERTS BOTH thresholds (gates CI):
//     fail if decisive < DECISIVE_THRESHOLD (default 0.95, env
//     C_THRU_SELECTION_DECISIVE_THRESHOLD) OR decline < DECLINE_THRESHOLD
//     (default 0.60, env C_THRU_SELECTION_DECLINE_THRESHOLD).
//   - Escape hatch: C_THRU_SELECTION_ADVISORY=1 downgrades ALL failures to
//     advisory (print both scorecards, exit 0) — for local runs that don't gate.
//
// Run live:
//   C_THRU_LIVE_SELECTION=1 ANTHROPIC_API_KEY=... node test/agent-selection-llm-judge.test.js
// Advisory (don't gate):
//   C_THRU_LIVE_SELECTION=1 C_THRU_SELECTION_ADVISORY=1 ANTHROPIC_API_KEY=... node test/agent-selection-llm-judge.test.js
// Dry self-test (no key, no network — exercises bucketed scoring):
//   node test/agent-selection-llm-judge.test.js

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const { assert, summary } = require('./helpers');

// ── Config ───────────────────────────────────────────────────────────────────
const REPO        = path.resolve(__dirname, '..');
const AGENTS_DIR  = path.join(REPO, 'agents');
const CORPUS_PATH = path.join(REPO, 'test', 'fixtures', 'agent-selection-corpus.json');

// A small, fast model is fine for this classification task (judge-canary uses
// the haiku tier). Allow override via env for re-baselining.
const JUDGE_MODEL = process.env.C_THRU_SELECTION_MODEL || 'claude-haiku-4-5';

// Per-bucket thresholds the live run asserts.
//
// DECISIVE (every task with a definite expectation — normal expect[] AND
// inline_ok tasks) is the hard gate: the live judge demo got 36/36 specialist
// tasks right and an inline_ok task is satisfied by EITHER its generalist pick
// OR declining, so a high floor is defensible. Hard-gate at 0.95.
//
// DECLINE (ambiguous:true tasks) is genuinely fuzzy — a model may reasonably
// reach for a near-neighbour specialist on a borderline conversational prompt —
// so its floor is looser (0.60). The per-bucket miss list printed by each
// scorecard documents exactly which tasks drove a shortfall.
const DECISIVE_THRESHOLD = Number(process.env.C_THRU_SELECTION_DECISIVE_THRESHOLD || '0.95');
const DECLINE_THRESHOLD  = Number(process.env.C_THRU_SELECTION_DECLINE_THRESHOLD  || '0.60');

// Placeholder substitutions — neutral nouns for the hermetic/judge loaders
// (the real-session harness swaps in real scratch paths instead). See the
// corpus _comment.
const PLACEHOLDERS = {
  '{{PY}}':   'a code file',
  '{{DIR}}':  'a directory',
  '{{PLAN}}': 'a plan file',
};

// Concurrency + retry knobs.
const CONCURRENCY  = Number(process.env.C_THRU_SELECTION_CONCURRENCY || '5');
const MAX_RETRIES  = 3;
const REQ_TIMEOUT  = 30_000;

// ── Description parsing (mirrors agent-description-quality.test.js) ─────────────
function parseDescription(body) {
  const m = body.match(/^description:[ \t]*(.+?)[ \t]*$/m);
  return m ? m[1] : null;
}

function loadAgentDescriptions() {
  const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')).sort();
  const out = {};
  for (const file of files) {
    const name = file.replace(/\.md$/, '');
    const desc = parseDescription(fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8'));
    if (desc) out[name] = desc;
  }
  return out;
}

function loadCorpus() {
  return JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')).prompts;
}

function substitutePlaceholders(prompt) {
  let p = prompt;
  for (const [k, v] of Object.entries(PLACEHOLDERS)) p = p.split(k).join(v);
  return p;
}

// ── Prompt construction ────────────────────────────────────────────────────────
const SYSTEM_INSTRUCTION =
  "You are Claude Code's subagent selector. Given these subagent descriptions, " +
  "output ONLY the single subagent_type whose description best matches the user's " +
  "task, or exactly 'none' if no specialized subagent clearly fits. Output just " +
  'the identifier, nothing else.';

function buildSelectorPrompt(descriptions, taskPrompt) {
  const list = Object.entries(descriptions)
    .map(([name, desc]) => `${name}: ${desc}`)
    .join('\n');
  return (
    `Available subagent_types:\n${list}\n\n` +
    `User task:\n${taskPrompt}\n\n` +
    'Answer with exactly one subagent_type from the list above, or "none".'
  );
}

// Normalize the model's free-text answer to a bare identifier: trim, lowercase,
// strip surrounding quotes/backticks/punctuation, drop any "subagent_type:" or
// "answer:" prefix, and take the first token-ish run of identifier chars.
function parsePick(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  // Drop a leading label like "subagent_type:" / "answer:".
  s = s.replace(/^(?:subagent_type|subagent|agent|answer|pick|selection)\s*[:=]\s*/i, '');
  // Strip wrapping quotes/backticks.
  s = s.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  s = s.trim();
  // The identifier is the leading run of [a-z0-9-] characters (agent names and
  // "none" are all that shape). This also salvages a one-line answer that has a
  // trailing period or explanatory clause.
  const m = s.match(/^[a-z0-9][a-z0-9-]*/);
  return m ? m[0] : '';
}

// ── Live judge call (direct HTTPS to api.anthropic.com, like judge-canary) ─────
function callAnthropic(apiKey, model, systemText, userText) {
  const body = JSON.stringify({
    model,
    max_tokens: 20,
    system: systemText,
    // Low temperature for determinism. (haiku-4-5 accepts temperature; if a
    // future judge model rejects it, drop this field — adaptive default is fine.)
    temperature: 0,
    messages: [{ role: 'user', content: userText }],
  });
  const opts = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-length': Buffer.byteLength(body),
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, bodyText: text });
      });
    });
    req.setTimeout(REQ_TIMEOUT, () => {
      req.destroy(new Error(`anthropic request timed out after ${REQ_TIMEOUT}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// One judge call → bare pick string. Small retry on transient errors
// (timeouts, 429/5xx). `callFn` is injectable so the structural self-test can
// stub it without touching the network.
async function judgeOne(task, descriptions, ctx) {
  const callFn = ctx.callFn;
  const taskPrompt = substitutePlaceholders(task.prompt);
  const userText = buildSelectorPrompt(descriptions, taskPrompt);

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await callFn(ctx.apiKey, ctx.model, SYSTEM_INSTRUCTION, userText, task);
      if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
        lastErr = new Error(`transient status ${r.status}`);
        await sleep(250 * attempt);
        continue;
      }
      if (r.status !== 200) {
        // Non-transient (e.g. 400/401) — surface immediately.
        throw new Error(`anthropic ${r.status}: ${(r.bodyText || '').slice(0, 200)}`);
      }
      const textOut = (r.json && Array.isArray(r.json.content)
        ? r.json.content.map(c => c.text || '').join('')
        : '');
      return parsePick(textOut);
    } catch (err) {
      lastErr = err;
      await sleep(250 * attempt);
    }
  }
  throw lastErr || new Error('judgeOne: exhausted retries');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Run tasks with bounded concurrency, preserving input order in the result.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// ── Scoring ────────────────────────────────────────────────────────────────────
// Bucket a task: DECLINE = ambiguous:true (decline-only). DECISIVE = everything
// with a definite expectation, including inline_ok tasks (which have a NON-EMPTY
// expect[]). The bucket keys on ambiguous:true, NEVER on an empty expect — an
// inline_ok task carries a non-empty expect and belongs in DECISIVE.
function taskBucket(task) {
  return task.ambiguous === true ? 'decline' : 'decisive';
}

// Classify one (task, pick) → outcome record. Pure — exercised by the self-test.
function scoreTask(task, pick) {
  const declined = pick === 'none' || pick === '';
  if (task.ambiguous === true) {
    // Decline-only: only 'none'/empty is correct.
    return { id: task.id, bucket: 'decline', pick, outcome: declined ? 'ambiguous-correct' : 'miss' };
  }
  const expect = task.expect || [];
  const inline_ok = task.inline_ok === true;
  if (pick === expect[0]) return { id: task.id, bucket: 'decisive', pick, expect, inline_ok, outcome: 'exact' };
  if (expect.includes(pick)) return { id: task.id, bucket: 'decisive', pick, expect, inline_ok, outcome: 'acceptable' };
  // inline_ok: a pick in expect[] is correct (handled above) AND declining /
  // answering inline ('none'/empty) is ALSO correct; any OTHER pick is a miss.
  if (inline_ok && declined) {
    return { id: task.id, bucket: 'decisive', pick, expect, inline_ok, outcome: 'inline-correct' };
  }
  return { id: task.id, bucket: 'decisive', pick, expect, inline_ok, outcome: 'miss' };
}

function isCorrect(outcome) {
  return outcome === 'exact' || outcome === 'acceptable' ||
    outcome === 'inline-correct' || outcome === 'ambiguous-correct';
}

// Summarize one bucket's records into { total, correct, score, byOutcome, misses }.
function bucketStats(records) {
  const total = records.length;
  let correct = 0;
  const byOutcome = {};
  const misses = [];
  for (const rec of records) {
    byOutcome[rec.outcome] = (byOutcome[rec.outcome] || 0) + 1;
    if (isCorrect(rec.outcome)) correct++;
    else misses.push(rec);
  }
  return { total, correct, score: total ? correct / total : 0, byOutcome, misses };
}

// Aggregate the per-task records into a scorecard. Pure — exercised by the
// self-test. Splits into TWO buckets (decisive / decline), each with its own
// accuracy, plus the overall per-agent / never-selected info.
// Returns { total, correct, score, byOutcome, misses, perAgent, neverSelected,
//           decisive:{...}, decline:{...} }.
function aggregate(records, agentNames) {
  const total = records.length;
  let correct = 0;
  const byOutcome = { exact: 0, acceptable: 0, 'inline-correct': 0, 'ambiguous-correct': 0, miss: 0 };
  const misses = [];
  const selectedCount = {};
  for (const name of agentNames) selectedCount[name] = 0;

  for (const rec of records) {
    byOutcome[rec.outcome] = (byOutcome[rec.outcome] || 0) + 1;
    if (isCorrect(rec.outcome)) correct++;
    else misses.push(rec);
    if (rec.pick && Object.prototype.hasOwnProperty.call(selectedCount, rec.pick)) {
      selectedCount[rec.pick]++;
    }
  }

  // Per-bucket accuracy. DECISIVE = definite-expectation tasks (normal + inline_ok);
  // DECLINE = ambiguous:true tasks.
  const decisive = bucketStats(records.filter(r => r.bucket === 'decisive'));
  const decline  = bucketStats(records.filter(r => r.bucket === 'decline'));

  // Per-agent: for each agent that is the PRIMARY (expect[0]) of any decisive
  // task, how often was it picked exactly?
  const perAgent = {};
  for (const rec of records) {
    if (rec.bucket !== 'decisive') continue;
    const primary = (rec.expect || [])[0];
    if (!primary) continue;
    if (!perAgent[primary]) perAgent[primary] = { primaryTasks: 0, exact: 0, acceptableElsewhere: 0 };
    perAgent[primary].primaryTasks++;
    if (rec.outcome === 'exact') perAgent[primary].exact++;
    else if (rec.outcome === 'acceptable') perAgent[primary].acceptableElsewhere++;
  }

  const neverSelected = agentNames.filter(n => selectedCount[n] === 0);

  return {
    total,
    correct,
    score: total ? correct / total : 0,
    byOutcome,
    misses,
    selectedCount,
    perAgent,
    neverSelected,
    decisive,
    decline,
  };
}

// ── Scorecard printing ─────────────────────────────────────────────────────────
// Print one bucket scorecard (decisive or decline) with its own miss list.
function printBucket(label, bucket, threshold) {
  const b = bucket.byOutcome;
  console.log(`\n── ${label} scorecard ${'─'.repeat(Math.max(0, 44 - label.length))}`);
  console.log(`  tasks:              ${bucket.total}`);
  console.log(`  exact:              ${b.exact || 0}`);
  console.log(`  acceptable:         ${b.acceptable || 0}`);
  console.log(`  inline-correct:     ${b['inline-correct'] || 0}`);
  console.log(`  ambiguous-correct:  ${b['ambiguous-correct'] || 0}`);
  console.log(`  miss:               ${b.miss || 0}`);
  console.log(`  accuracy:           ${bucket.score.toFixed(4)} (${bucket.correct}/${bucket.total})` +
    (threshold != null ? `  threshold >= ${threshold}` : ''));
  if (bucket.misses.length) {
    console.log('  misses:');
    for (const m of bucket.misses) {
      const want = m.bucket === 'decline'
        ? "'none'"
        : (m.expect && m.expect.length ? `[${m.expect.join(', ')}]${m.inline_ok ? ' or none' : ''}` : "'none'");
      console.log(`    ${m.id}: picked ${JSON.stringify(m.pick)} — expected ${want}`);
    }
  }
}

function printScorecard(card, decisiveThreshold, declineThreshold) {
  const b = card.byOutcome;
  console.log('\n── Scorecard (overall) ─────────────────────────────────────');
  console.log(`  total tasks:        ${card.total}`);
  console.log(`  exact:              ${b.exact || 0}`);
  console.log(`  acceptable:         ${b.acceptable || 0}`);
  console.log(`  inline-correct:     ${b['inline-correct'] || 0}`);
  console.log(`  ambiguous-correct:  ${b['ambiguous-correct'] || 0}`);
  console.log(`  miss:               ${b.miss || 0}`);
  console.log(`  aggregate score:    ${card.score.toFixed(4)} (${card.correct}/${card.total})`);

  // Per-bucket scorecards — these carry the gating thresholds.
  printBucket('DECISIVE (definite expectation: normal + inline_ok)', card.decisive, decisiveThreshold);
  printBucket('DECLINE (ambiguous:true — decline is the win)', card.decline, declineThreshold);

  console.log('\n── Per-agent (primary-task hit rate) ───────────────────────');
  const agents = Object.keys(card.perAgent).sort();
  for (const a of agents) {
    const p = card.perAgent[a];
    console.log(`  ${a}: ${p.exact}/${p.primaryTasks} exact` +
      (p.acceptableElsewhere ? ` (+${p.acceptableElsewhere} acceptable-neighbour)` : ''));
  }

  console.log('\n── Never-selected agents ───────────────────────────────────');
  console.log(card.neverSelected.length
    ? '  ' + card.neverSelected.join(', ')
    : '  (none — every agent was picked at least once)');
  console.log('────────────────────────────────────────────────────────────\n');
}

// ── Orchestration ──────────────────────────────────────────────────────────────
// runJudge: do the per-task judging + scoring and return the scorecard.
// callFn is injectable (the live path uses callAnthropic; the self-test injects
// a fake) so the scoring/threshold/parse logic is testable without the network.
async function runJudge({ apiKey, model, callFn }) {
  const descriptions = loadAgentDescriptions();
  const agentNames = Object.keys(descriptions);
  const corpus = loadCorpus();
  const ctx = { apiKey, model, callFn };

  const records = await mapWithConcurrency(corpus, CONCURRENCY, async (task) => {
    const pick = await judgeOne(task, descriptions, ctx);
    return scoreTask(task, pick);
  });

  return aggregate(records, agentNames);
}

// ── DRY self-test (no network, no key) ───────────────────────────────────────────
// Verifies the bucketed scoring + per-bucket threshold logic end-to-end against
// the REAL corpus, driving runJudge with a stubbed callFn. Two scenarios:
//   (1) a PERFECT judge (always returns each task's correct answer) → BOTH
//       buckets score 1.0 and clear their thresholds.
//   (2) a judge that MISSES one specialist task (returns 'none' for a normal
//       expect[] task — which is NOT inline_ok, so 'none' is a miss) → the
//       DECISIVE bucket drops below its threshold while DECLINE stays perfect.
// This keeps the no-key run meaningful and pins the inline_ok / bucket rules.
function stubCall(answerFor) {
  // callFn signature: (apiKey, model, systemText, userText, task) → { status, json }
  return async (_apiKey, _model, _systemText, _userText, task) => {
    const text = answerFor(task);
    return { status: 200, json: { content: [{ type: 'text', text }] } };
  };
}

async function selfTest() {
  console.log('── DRY self-test (stubbed judge, real corpus) ───────────────');

  // (1) Perfect judge: pick expect[0] for decisive tasks (an expect pick is
  //     always correct, incl. inline_ok), 'none' for ambiguous decline tasks.
  const perfect = await runJudge({
    apiKey: 'stub', model: 'stub',
    callFn: stubCall((task) => {
      if (task.ambiguous === true) return 'none';
      return (task.expect && task.expect[0]) || 'none';
    }),
  });
  assert(perfect.decisive.score >= DECISIVE_THRESHOLD,
    `self-test: perfect judge clears DECISIVE threshold ` +
    `(${perfect.decisive.score.toFixed(4)} >= ${DECISIVE_THRESHOLD}, ${perfect.decisive.correct}/${perfect.decisive.total})`);
  assert(perfect.decline.score >= DECLINE_THRESHOLD,
    `self-test: perfect judge clears DECLINE threshold ` +
    `(${perfect.decline.score.toFixed(4)} >= ${DECLINE_THRESHOLD}, ${perfect.decline.correct}/${perfect.decline.total})`);

  // Inline_ok sanity: declining an inline_ok task is ALSO correct. Score the
  // inline_ok corpus with a judge that ALWAYS declines → those tasks must land
  // 'inline-correct' (decisive bucket stays correct for them).
  const inlineTasks = loadCorpus().filter(t => t.inline_ok === true);
  assert(inlineTasks.length >= 1, `self-test: corpus has at least one inline_ok task (${inlineTasks.length})`);
  for (const t of inlineTasks) {
    const declineRec = scoreTask(t, 'none');
    const pickRec    = scoreTask(t, t.expect[0]);
    assert(declineRec.bucket === 'decisive' && declineRec.outcome === 'inline-correct',
      `self-test: inline_ok ${t.id} — declining ('none') is inline-correct in DECISIVE`);
    assert(pickRec.outcome === 'exact',
      `self-test: inline_ok ${t.id} — picking expect[0] (${t.expect[0]}) is exact`);
    const wrongRec = scoreTask(t, 'reviewer-security');
    assert(wrongRec.outcome === 'miss',
      `self-test: inline_ok ${t.id} — a non-expect pick (reviewer-security) is a miss`);
  }

  // (2) Specialist-miss judge: behave like the perfect judge EXCEPT decline one
  //     normal (non-inline_ok) decisive task — that 'none' is a real miss, so
  //     DECISIVE drops below a perfect score while DECLINE stays perfect. We gate
  //     against a 1.0 threshold here (independent of the live default and of
  //     corpus size: ANY single decisive miss must trip the gate), which is the
  //     property the live gate relies on — a specialist miss CANNOT pass a
  //     perfect-required bar.
  const victim = loadCorpus().find(t => t.ambiguous !== true && t.inline_ok !== true);
  assert(!!victim, `self-test: corpus has a normal (non-inline_ok) decisive task to miss (${victim && victim.id})`);
  const missed = await runJudge({
    apiKey: 'stub', model: 'stub',
    callFn: stubCall((task) => {
      if (task.id === victim.id) return 'none'; // wrong: a specialist task answered inline
      if (task.ambiguous === true) return 'none';
      return (task.expect && task.expect[0]) || 'none';
    }),
  });
  assert(missed.decisive.score < 1.0 && missed.decisive.score < perfect.decisive.score,
    `self-test: a specialist miss drops DECISIVE below perfect ` +
    `(${missed.decisive.score.toFixed(4)} < 1.0, miss on ${victim.id})`);
  // Gate semantics: fail iff decisive < threshold OR decline < threshold. With a
  // perfect-required decisive bar, the specialist-miss run must FAIL the gate
  // while the perfect run PASSES it.
  const gateFails = (card, decT, decLineT) => card.decisive.score < decT || card.decline.score < decLineT;
  assert(gateFails(missed, 1.0, DECLINE_THRESHOLD) === true,
    `self-test: specialist-miss run FAILS the gate at a perfect-required decisive bar (decisive ${missed.decisive.score.toFixed(4)} < 1.0)`);
  assert(gateFails(perfect, 1.0, DECLINE_THRESHOLD) === false,
    `self-test: perfect run PASSES the gate even at a perfect-required decisive bar`);
  assert(missed.decline.score >= DECLINE_THRESHOLD,
    `self-test: DECLINE unaffected by the specialist miss ` +
    `(${missed.decline.score.toFixed(4)} >= ${DECLINE_THRESHOLD})`);
}

// ── Main (live path) ───────────────────────────────────────────────────────────
async function main() {
  console.log('agent-selection-llm-judge: do descriptions alone let a model pick the right subagent?\n');

  const LIVE     = process.env.C_THRU_LIVE_SELECTION === '1';
  const ADVISORY = process.env.C_THRU_SELECTION_ADVISORY === '1';
  const KEY      = process.env.ANTHROPIC_API_KEY;

  if (!LIVE || !KEY) {
    // No live cloud run. Don't just skip silently — run the DRY self-test so the
    // bucketed scoring/threshold logic is verified offline on every plain run,
    // and the suite's exit stays gated on summary() (exit-code-gating meta-lint).
    console.log(LIVE
      ? 'SKIP live judge: ANTHROPIC_API_KEY not set — running DRY self-test instead (no network)\n'
      : 'SKIP live judge: requires C_THRU_LIVE_SELECTION=1 — running DRY self-test instead (no network)\n');
    await selfTest();
    const failed = summary();
    process.exit(failed ? 1 : 0);
  }

  console.log(`judge model: ${JUDGE_MODEL}   decisive>=${DECISIVE_THRESHOLD}  decline>=${DECLINE_THRESHOLD}   ` +
    `advisory: ${ADVISORY ? 'yes' : 'no'}\n`);

  let card;
  try {
    card = await runJudge({ apiKey: KEY, model: JUDGE_MODEL, callFn: callAnthropic });
  } catch (err) {
    console.error('FATAL: judge run failed:', err && err.stack || err);
    process.exit(1);
  }

  printScorecard(card, DECISIVE_THRESHOLD, DECLINE_THRESHOLD);

  const decisiveOk = card.decisive.score >= DECISIVE_THRESHOLD;
  const declineOk  = card.decline.score  >= DECLINE_THRESHOLD;

  if (ADVISORY) {
    // Advisory mode never gates: record both bucket verdicts for visibility, exit 0.
    assert(true,
      `advisory mode — decisive ${card.decisive.score.toFixed(4)} (>=${DECISIVE_THRESHOLD}? ${decisiveOk}), ` +
      `decline ${card.decline.score.toFixed(4)} (>=${DECLINE_THRESHOLD}? ${declineOk}) — not gating`);
    summary();
    process.exit(0);
  }

  // Gate: fail if EITHER bucket is below its threshold.
  assert(decisiveOk,
    `DECISIVE accuracy ${card.decisive.score.toFixed(4)} >= ${DECISIVE_THRESHOLD} ` +
    `(${card.decisive.correct}/${card.decisive.total}; ${card.decisive.misses.length} miss(es))`);
  assert(declineOk,
    `DECLINE accuracy ${card.decline.score.toFixed(4)} >= ${DECLINE_THRESHOLD} ` +
    `(${card.decline.correct}/${card.decline.total}; ${card.decline.misses.length} miss(es))`);

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

// Export the pure pieces + the injectable orchestrator so the structural
// self-test (and any future caller) can exercise scoring/threshold/parse logic
// with a stubbed judge — no network, no live key.
module.exports = {
  parseDescription,
  loadAgentDescriptions,
  loadCorpus,
  substitutePlaceholders,
  buildSelectorPrompt,
  parsePick,
  scoreTask,
  taskBucket,
  bucketStats,
  aggregate,
  isCorrect,
  runJudge,
  selfTest,
  SYSTEM_INSTRUCTION,
  DECISIVE_THRESHOLD,
  DECLINE_THRESHOLD,
};

if (require.main === module) {
  main().catch(err => {
    console.error('FATAL:', err && err.stack || err);
    process.exit(1);
  });
}
