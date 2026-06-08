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
//   3. contain a recognized TRIGGER phrase (the "when to pick me" signal);
//   4. contain a SPECIFICITY signal — at least one of:
//        (a) a quoted example query  ("…"),
//        (b) a disambiguation clause ("Not for …", "use X instead/first",
//            "prefer …", "does not", "rather than"), or
//        (c) a "MUST BE USED for <enumerated scope>" mandate (≥3 comma-separated
//            terms) — a strong mandate with concrete scope is itself a
//            discoverability+scoping signal (the gold-standard reviewer-security
//            pattern, which carries no quoted examples by design).
//
// Fail-closed: a new agent that skips the convention fails this suite.
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
  assert(TRIGGER_RE.test(desc),
    `${name}: has a recognized trigger phrase (MUST BE USED / Use PROACTIVELY / Use when|for|after|to|in)`);
  const sig = hasSpecificity(desc);
  assert(sig !== null,
    `${name}: has a specificity signal (quoted example / disambiguation / mandate+scope)${sig ? ` [${sig}]` : ''}`);
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
