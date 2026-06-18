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
// Scoring (per test/fixtures/agent-selection-corpus.json):
//   - non-ambiguous task: exact if pick==expect[0]; acceptable if pick∈expect[];
//     else miss.
//   - ambiguous task (expect:[]): correct if pick=='none'/empty; else miss.
//   aggregate = (exact + acceptable + ambiguous-correct) / total.
//
// Gating (matches the repo's live-suite convention — see
// anthropic-api-coverage-live.test.js / judge-canary.test.js):
//   - SKIP cleanly (print SKIP, exit 0) unless C_THRU_LIVE_SELECTION=1.
//   - SKIP cleanly if ANTHROPIC_API_KEY is unset.
//   - When enabled it runs for real and ASSERTS the threshold (gates CI).
//   - Escape hatch: C_THRU_SELECTION_ADVISORY=1 downgrades failures to advisory
//     (print the scorecard, exit 0) — for local runs that don't want to gate.
//
// Run live:
//   C_THRU_LIVE_SELECTION=1 ANTHROPIC_API_KEY=... node test/agent-selection-llm-judge.test.js
// Advisory (don't gate):
//   C_THRU_LIVE_SELECTION=1 C_THRU_SELECTION_ADVISORY=1 ANTHROPIC_API_KEY=... node test/agent-selection-llm-judge.test.js

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

// Threshold the live run asserts. Start at 0.90. The real fleet has a few
// genuinely-fuzzy neighbour tasks (e.g. docs vs writer, debugger-* tiers, the
// ambiguous "tradeoffs" prompt that a generalist could plausibly take) where a
// miss is not a description bug, so a defensible at-or-just-below floor is used.
// If the observed live score lands below this, the failing item list printed by
// the scorecard documents exactly which neighbours drove it.
const THRESHOLD = Number(process.env.C_THRU_SELECTION_THRESHOLD || '0.90');

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
// Classify one (task, pick) → outcome record. Pure — exercised by the self-test.
function scoreTask(task, pick) {
  const ambiguous = task.ambiguous === true || (Array.isArray(task.expect) && task.expect.length === 0);
  if (ambiguous) {
    const correct = pick === 'none' || pick === '';
    return { id: task.id, ambiguous: true, pick, outcome: correct ? 'ambiguous-correct' : 'miss' };
  }
  const expect = task.expect || [];
  if (pick === expect[0]) return { id: task.id, ambiguous: false, pick, expect, outcome: 'exact' };
  if (expect.includes(pick)) return { id: task.id, ambiguous: false, pick, expect, outcome: 'acceptable' };
  return { id: task.id, ambiguous: false, pick, expect, outcome: 'miss' };
}

function isCorrect(outcome) {
  return outcome === 'exact' || outcome === 'acceptable' || outcome === 'ambiguous-correct';
}

// Aggregate the per-task records into a scorecard. Pure — exercised by the
// self-test. Returns { total, correct, score, byOutcome, misses, perAgent,
// neverSelected }.
function aggregate(records, agentNames) {
  const total = records.length;
  let correct = 0;
  const byOutcome = { exact: 0, acceptable: 0, 'ambiguous-correct': 0, miss: 0 };
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

  // Per-agent: for each agent that is the PRIMARY (expect[0]) of any
  // non-ambiguous task, how often was it picked exactly?
  const perAgent = {};
  for (const rec of records) {
    if (rec.ambiguous) continue;
    const primary = rec.expect[0];
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
  };
}

// ── Scorecard printing ─────────────────────────────────────────────────────────
function printScorecard(card) {
  const b = card.byOutcome;
  console.log('\n── Scorecard ───────────────────────────────────────────────');
  console.log(`  total tasks:        ${card.total}`);
  console.log(`  exact:              ${b.exact || 0}`);
  console.log(`  acceptable:         ${b.acceptable || 0}`);
  console.log(`  ambiguous-correct:  ${b['ambiguous-correct'] || 0}`);
  console.log(`  miss:               ${b.miss || 0}`);
  console.log(`  aggregate score:    ${card.score.toFixed(4)} (${card.correct}/${card.total})`);

  if (card.misses.length) {
    console.log('\n── Misses ──────────────────────────────────────────────────');
    for (const m of card.misses) {
      const want = m.ambiguous ? "'none'" : `[${(m.expect || []).join(', ')}]`;
      console.log(`  ${m.id}: picked ${JSON.stringify(m.pick)} — expected ${want}`);
    }
  }

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

// ── Main (live path) ───────────────────────────────────────────────────────────
async function main() {
  console.log('agent-selection-llm-judge: do descriptions alone let a model pick the right subagent?\n');

  const LIVE     = process.env.C_THRU_LIVE_SELECTION === '1';
  const ADVISORY = process.env.C_THRU_SELECTION_ADVISORY === '1';
  const KEY      = process.env.ANTHROPIC_API_KEY;

  if (!LIVE) {
    console.log('SKIP: agent-selection LLM-judge requires C_THRU_LIVE_SELECTION=1 (live cloud test)');
    process.exit(0);
  }
  if (!KEY) {
    console.log('SKIP: ANTHROPIC_API_KEY not set — the selection judge needs real cloud access');
    process.exit(0);
  }

  console.log(`judge model: ${JUDGE_MODEL}   threshold: ${THRESHOLD}   advisory: ${ADVISORY ? 'yes' : 'no'}\n`);

  let card;
  try {
    card = await runJudge({ apiKey: KEY, model: JUDGE_MODEL, callFn: callAnthropic });
  } catch (err) {
    console.error('FATAL: judge run failed:', err && err.stack || err);
    process.exit(1);
  }

  printScorecard(card);

  if (ADVISORY) {
    // Advisory mode never gates: record the result for visibility, exit 0.
    assert(true, `advisory mode — score ${card.score.toFixed(4)} (>=${THRESHOLD} would gate; not gating)`);
    summary();
    process.exit(0);
  }

  assert(card.score >= THRESHOLD,
    `aggregate selection score ${card.score.toFixed(4)} >= ${THRESHOLD} ` +
    `(${card.correct}/${card.total} correct; ${card.misses.length} miss(es))`);

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
  aggregate,
  isCorrect,
  runJudge,
  SYSTEM_INSTRUCTION,
  THRESHOLD,
};

if (require.main === module) {
  main().catch(err => {
    console.error('FATAL:', err && err.stack || err);
    process.exit(1);
  });
}
