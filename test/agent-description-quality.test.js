#!/usr/bin/env node
'use strict';
// Agent description-quality lint.
//
// Claude Code's Agent tool selects a subagent by matching the task against each
// agent's `description` (injected via --agents JSON in tools/c-thru). A weak
// description = an agent that never gets picked. This lint makes "attract usage"
// ENFORCEABLE rather than aspirational: every agents/*.md description must follow
// the house convention documented in docs/agent-authoring.md.
//
// For every agents/*.md the description must:
//   1. exist and be a single non-empty line;
//   2. be ≥ MIN_LEN chars (enough room for trigger + example + disambiguation);
//   3. contain a recognized TRIGGER phrase (the "when to pick me" signal)
//      — and it must START within the first TRIGGER_WINDOW chars. Official
//      guidance: "Good descriptions start with WHEN to use the subagent, not
//      what it is." A trigger buried behind a model-name or role-blurb preamble
//      wastes the highest-signal characters the selector reads first;
//   4. contain a SPECIFICITY signal — at least one of:
//        (a) a quoted example query  ("…"),
//        (b) a disambiguation clause ("Not for …", "use X instead/first",
//            "prefer …", "does not", "rather than"), or
//        (c) a "MUST BE USED for <enumerated scope>" mandate (≥3 comma-separated
//            terms) — a strong mandate with concrete scope is itself a
//            discoverability+scoping signal (the gold-standard reviewer-security
//            pattern, which carries no quoted examples by design);
//   5. every agent NAMED in a disambiguation clause ("use X instead/first",
//      "prefer X") must be a real agents/*.md or an allowlisted built-in —
//      a rename must not silently orphan the guidance (the
//      <role>-<noun>→<noun>-<role> rename already orphaned one once).
//
// Fail-closed: a new agent that skips the convention fails this suite.
//
// TODO (out of scope): full semantic overlap detection between descriptions
// (two agents claiming the same task) needs an LLM judge, not a regex.
//
// Run: node test/agent-description-quality.test.js

const fs   = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}

const REPO = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(REPO, 'agents');
const AGENT_FILES = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')).sort();

const MIN_LEN = 120;

// Trigger vocabulary — the "when to pick me" verb phrases (see docs/agent-authoring.md).
const TRIGGER_RE = /\b(MUST BE USED|Use PROACTIVELY|Use when|Use for|Use after|Use to|Use in)\b/i;

// The trigger must start within this many chars of the description start.
// Tolerates a short leading clause; kills model-name preambles.
const TRIGGER_WINDOW = 60;

// Specificity signals.
const QUOTED_EXAMPLE_RE = /"[^"]{3,}"/;                       // a quoted example query
const DISAMBIG_RES = [
  /\bnot for\b/i,
  /\buse\s+[a-z][\w-]*\s+(instead|first)\b/i,
  /\bprefer\b/i,
  /\bdoes not\b/i,
  /\brather than\b/i,
];
const MANDATE_RE = /MUST BE USED/i;

// Parse the single-line `description:` value from frontmatter.
function parseDescription(body) {
  const m = body.match(/^description:[ \t]*(.+?)[ \t]*$/m);
  return m ? m[1] : null;
}

function hasDisambig(desc) {
  return DISAMBIG_RES.some(re => re.test(desc));
}

// ── Disambiguation-target validation ──────────────────────────────────────────
// Extract agent names from disambiguation clauses ("use X instead/first",
// "prefer X") and require each to resolve to a real agents/*.md or an
// allowlisted built-in. Capture is constrained to avoid matching ordinary
// English ("use caution first"): the token must be hyphenated (claimed agent
// reference) or exactly match a known agent/built-in name.
const BUILTIN_AGENTS = new Set([
  'general-purpose', // Claude Code's default subagent type
]);
const AGENT_NAMES = new Set(AGENT_FILES.map(f => f.replace(/\.md$/, '')));
const DISAMBIG_MARKER_RE = /\bnot for\b|\binstead\b|\bfirst\b|\bprefer\b|\bfor those\b/i;
const TARGET_TOKEN_RE = /\b(?:[Uu]se|[Pp]refer)(?:\s+over)?\s+([a-z][a-z0-9-]*)\b/g;

function disambigTargets(desc) {
  const targets = [];
  for (const sentence of desc.split(/(?<=[.!?])\s+/)) {
    if (!DISAMBIG_MARKER_RE.test(sentence)) continue;
    for (const m of sentence.matchAll(TARGET_TOKEN_RE)) {
      const token = m[1];
      if (token.includes('-') || AGENT_NAMES.has(token) || BUILTIN_AGENTS.has(token)) {
        targets.push({ token, sentence: sentence.trim() });
      }
    }
  }
  return targets;
}
function commaCount(desc) {
  return (desc.match(/,/g) || []).length;
}
function hasSpecificity(desc) {
  if (QUOTED_EXAMPLE_RE.test(desc)) return 'quoted-example';
  if (hasDisambig(desc)) return 'disambiguation';
  if (MANDATE_RE.test(desc) && commaCount(desc) >= 3) return 'mandate+scope';
  return null;
}

console.log(`agent-description-quality: ${AGENT_FILES.length} agent descriptions\n`);

for (const file of AGENT_FILES) {
  const name = file.replace(/\.md$/, '');
  const body = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
  const desc = parseDescription(body);

  if (!desc || desc.length === 0) {
    assert(false, `${name}: has a non-empty description`);
    continue;
  }
  assert(desc.length >= MIN_LEN,
    `${name}: description ≥ ${MIN_LEN} chars (got ${desc.length})`);
  const trig = TRIGGER_RE.exec(desc);
  assert(trig !== null,
    `${name}: has a recognized trigger phrase (MUST BE USED / Use PROACTIVELY / Use when|for|after|to|in)`);
  if (trig) {
    assert(trig.index < TRIGGER_WINDOW,
      `${name}: trigger starts within first ${TRIGGER_WINDOW} chars (found "${trig[1]}" at index ${trig.index})`);
  }
  const sig = hasSpecificity(desc);
  assert(sig !== null,
    `${name}: has a specificity signal (quoted example / disambiguation / mandate+scope)${sig ? ` [${sig}]` : ''}`);
  for (const { token, sentence } of disambigTargets(desc)) {
    assert(AGENT_NAMES.has(token) || BUILTIN_AGENTS.has(token),
      `${name}: disambiguation target "${token}" resolves to a real agent — offending sentence: "${sentence}"`);
  }
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
