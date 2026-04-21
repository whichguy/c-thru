#!/usr/bin/env node
'use strict';
// Worker STATUS contract tests — per-agent extensions of the base STATUS block.
// Complements test/planner-return-schema.test.js (planner + RECUSE fixtures there).
// Run: node test/agent-status-schema.test.js

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ok    ${label}`);
  passed++;
}

function fail(label, reason) {
  console.error(`  FAIL  ${label}`);
  if (reason) console.error(`        ${reason}`);
  failed++;
}

// ── Shared STATUS block parser ─────────────────────────────────────────────────
// Parses key: value lines from a STATUS block (^([A-Z_]+): (.*)$).
function parseStatusBlock(text) {
  const r = {};
  for (const line of text.trim().split('\n')) {
    const m = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (!m) continue;
    r[m[1]] = m[2].trim();
  }
  return r;
}

// Validate worker STATUS (all agents except uplift-decider).
function validateWorkerStatus(r) {
  const errors = [];
  if (!['COMPLETE', 'PARTIAL', 'ERROR', 'RECUSE'].includes(r.STATUS))
    errors.push('STATUS must be COMPLETE|PARTIAL|ERROR|RECUSE');
  if (r.STATUS === 'RECUSE') return errors; // RECUSE has its own contract
  if (!['high', 'medium', 'low'].includes(r.CONFIDENCE) && r.CONFIDENCE !== undefined)
    errors.push(`CONFIDENCE must be high|medium|low (got ${r.CONFIDENCE})`);
  if (!r.SUMMARY || r.SUMMARY.length === 0)
    errors.push('SUMMARY required');
  return errors;
}

// ── 1. Base worker STATUS — COMPLETE/PARTIAL/ERROR ────────────────────────────
console.log('1. Base worker STATUS block — COMPLETE/PARTIAL/ERROR');

{
  const raw = [
    'STATUS: COMPLETE',
    'CONFIDENCE: high',
    'WROTE: waves/001/outputs/item-a.md',
    'INDEX: waves/001/outputs/item-a.INDEX.md',
    'FINDINGS: waves/001/findings/item-a.jsonl',
    'FINDING_CATS: {crisis:0,plan-material:0,contextual:0,trivial:0,augmentation:0,improvement:1}',
    'SUMMARY: implementation complete, all tests passing',
  ].join('\n');
  const r = parseStatusBlock(raw);
  const errs = validateWorkerStatus(r);
  errs.length === 0
    ? ok('COMPLETE + CONFIDENCE=high passes')
    : fail('COMPLETE + CONFIDENCE=high passes', errs.join('; '));
}

{
  const raw = 'STATUS: PARTIAL\nCONFIDENCE: medium\nSUMMARY: partial work done';
  const r = parseStatusBlock(raw);
  const errs = validateWorkerStatus(r);
  errs.length === 0
    ? ok('PARTIAL + CONFIDENCE=medium passes')
    : fail('PARTIAL + CONFIDENCE=medium passes', errs.join('; '));
}

{
  const raw = 'STATUS: ERROR\nCONFIDENCE: low\nSUMMARY: failed to produce output';
  const r = parseStatusBlock(raw);
  const errs = validateWorkerStatus(r);
  errs.length === 0
    ? ok('ERROR + CONFIDENCE=low passes')
    : fail('ERROR + CONFIDENCE=low passes', errs.join('; '));
}

{
  const raw = 'STATUS: INVALID\nCONFIDENCE: high\nSUMMARY: bad status';
  const r = parseStatusBlock(raw);
  const errs = validateWorkerStatus(r);
  errs.length > 0
    ? ok('invalid STATUS rejected')
    : fail('invalid STATUS rejected');
}

// ── 2. CONFIDENCE graceful degradation — absent treated as medium ─────────────
console.log('\n2. CONFIDENCE absent → treated as medium (graceful degradation)');

{
  // Orchestrator applies: absent CONFIDENCE → medium
  function resolveConfidence(r) {
    return r.CONFIDENCE || 'medium';
  }
  const raw = 'STATUS: COMPLETE\nSUMMARY: done';
  const r = parseStatusBlock(raw);
  const effective = resolveConfidence(r);
  effective === 'medium'
    ? ok('absent CONFIDENCE → medium')
    : fail('absent CONFIDENCE → medium', `got: ${effective}`);
}

// ── 3. reviewer-fix: ITERATIONS field required ────────────────────────────────
console.log('\n3. reviewer-fix STATUS — ITERATIONS required field');

function validateReviewerFix(r) {
  const errors = validateWorkerStatus(r);
  if (r.STATUS !== 'RECUSE' && (r.ITERATIONS === undefined || r.ITERATIONS === ''))
    errors.push('ITERATIONS required for reviewer-fix');
  if (r.ITERATIONS !== undefined && !/^\d+$/.test(r.ITERATIONS))
    errors.push(`ITERATIONS must be a non-negative integer (got ${r.ITERATIONS})`);
  return errors;
}

{
  const raw = 'STATUS: COMPLETE\nCONFIDENCE: high\nITERATIONS: 2\nSUMMARY: fixed in 2 passes';
  const r = parseStatusBlock(raw);
  const errs = validateReviewerFix(r);
  errs.length === 0
    ? ok('reviewer-fix ITERATIONS: 2 passes')
    : fail('reviewer-fix ITERATIONS: 2 passes', errs.join('; '));
}

{
  const raw = 'STATUS: COMPLETE\nCONFIDENCE: high\nITERATIONS: 0\nSUMMARY: clean first pass';
  const r = parseStatusBlock(raw);
  const errs = validateReviewerFix(r);
  errs.length === 0
    ? ok('reviewer-fix ITERATIONS: 0 passes')
    : fail('reviewer-fix ITERATIONS: 0 passes', errs.join('; '));
}

{
  const raw = 'STATUS: COMPLETE\nCONFIDENCE: high\nSUMMARY: missing iterations';
  const r = parseStatusBlock(raw);
  const errs = validateReviewerFix(r);
  errs.some(e => e.includes('ITERATIONS'))
    ? ok('reviewer-fix missing ITERATIONS → error')
    : fail('reviewer-fix missing ITERATIONS → error', errs.join('; '));
}

// ── 4. implementer: LINT_ITERATIONS field + CONFIDENCE rules ──────────────────
console.log('\n4. implementer STATUS — LINT_ITERATIONS field');

function validateImplementer(r) {
  const errors = validateWorkerStatus(r);
  if (r.STATUS !== 'RECUSE' && r.LINT_ITERATIONS !== undefined && !/^\d+$/.test(r.LINT_ITERATIONS))
    errors.push(`LINT_ITERATIONS must be non-negative integer (got ${r.LINT_ITERATIONS})`);
  // If lint errors remain after 5-iteration cap, CONFIDENCE must be medium or low
  if (r.LINT_ITERATIONS && Number(r.LINT_ITERATIONS) >= 5 && r.CONFIDENCE === 'high')
    errors.push('CONFIDENCE must not be high when LINT_ITERATIONS >= 5 (lint errors remain)');
  return errors;
}

{
  const raw = 'STATUS: COMPLETE\nCONFIDENCE: high\nLINT_ITERATIONS: 0\nSUMMARY: clean';
  const r = parseStatusBlock(raw);
  const errs = validateImplementer(r);
  errs.length === 0
    ? ok('implementer LINT_ITERATIONS: 0 + CONFIDENCE=high passes')
    : fail('implementer LINT_ITERATIONS: 0 + CONFIDENCE=high passes', errs.join('; '));
}

{
  const raw = 'STATUS: COMPLETE\nCONFIDENCE: medium\nLINT_ITERATIONS: 5\nSUMMARY: lint errors remain';
  const r = parseStatusBlock(raw);
  const errs = validateImplementer(r);
  errs.length === 0
    ? ok('LINT_ITERATIONS=5 + CONFIDENCE=medium passes (cap reached)')
    : fail('LINT_ITERATIONS=5 + CONFIDENCE=medium passes', errs.join('; '));
}

{
  const raw = 'STATUS: COMPLETE\nCONFIDENCE: high\nLINT_ITERATIONS: 5\nSUMMARY: bad: high confidence at lint cap';
  const r = parseStatusBlock(raw);
  const errs = validateImplementer(r);
  errs.some(e => e.includes('CONFIDENCE'))
    ? ok('LINT_ITERATIONS=5 + CONFIDENCE=high rejected')
    : fail('LINT_ITERATIONS=5 + CONFIDENCE=high rejected', errs.join('; '));
}

{
  // LINT_ITERATIONS absent → treated as 0 (graceful degradation)
  const raw = 'STATUS: COMPLETE\nCONFIDENCE: high\nSUMMARY: no lint field';
  const r = parseStatusBlock(raw);
  const effective = r.LINT_ITERATIONS !== undefined ? Number(r.LINT_ITERATIONS) : 0;
  effective === 0
    ? ok('absent LINT_ITERATIONS → 0 (graceful degradation)')
    : fail('absent LINT_ITERATIONS → 0 (graceful degradation)', `got: ${effective}`);
}

// ── 5. RECUSE STATUS contract ─────────────────────────────────────────────────
console.log('\n5. RECUSE STATUS contract');

function validateRecuse(r) {
  const errors = [];
  if (r.STATUS !== 'RECUSE') errors.push('STATUS must be RECUSE');
  if (!['yes', 'no'].includes(r.ATTEMPTED)) errors.push(`ATTEMPTED must be yes|no (got ${r.ATTEMPTED})`);
  if (!r.RECUSAL_REASON || r.RECUSAL_REASON.length === 0) errors.push('RECUSAL_REASON required');
  if (!r.RECOMMEND || r.RECOMMEND.length === 0) errors.push('RECOMMEND required');
  if (!r.SUMMARY || r.SUMMARY.length === 0) errors.push('SUMMARY required');
  return errors;
}

{
  const raw = [
    'STATUS: RECUSE',
    'ATTEMPTED: yes',
    'RECUSAL_REASON: cannot verify output satisfies criteria without integration environment',
    'RECOMMEND: implementer-cloud',
    'PARTIAL_OUTPUT: waves/001/outputs/item-a.md',
    'SUMMARY: partial work done, escalating to cloud tier',
  ].join('\n');
  const r = parseStatusBlock(raw);
  const errs = validateRecuse(r);
  errs.length === 0
    ? ok('RECUSE ATTEMPTED=yes with PARTIAL_OUTPUT passes')
    : fail('RECUSE ATTEMPTED=yes passes', errs.join('; '));
}

{
  const raw = [
    'STATUS: RECUSE',
    'ATTEMPTED: no',
    'RECUSAL_REASON: task requires capabilities outside this agent tier',
    'RECOMMEND: deep-coder',
    'SUMMARY: escalating immediately without attempt',
  ].join('\n');
  const r = parseStatusBlock(raw);
  const errs = validateRecuse(r);
  errs.length === 0
    ? ok('RECUSE ATTEMPTED=no passes')
    : fail('RECUSE ATTEMPTED=no passes', errs.join('; '));
}

{
  const raw = 'STATUS: RECUSE\nATTEMPTED: yes\nSUMMARY: missing RECOMMEND';
  const r = parseStatusBlock(raw);
  const errs = validateRecuse(r);
  errs.some(e => e.includes('RECOMMEND'))
    ? ok('RECUSE missing RECOMMEND → error')
    : fail('RECUSE missing RECOMMEND → error', errs.join('; '));
}

// ── 6. uplift-decider VERDICT: accept|uplift|restart ─────────────────────────
console.log('\n6. uplift-decider VERDICT contract');

function parseUpliftDecider(text) {
  return parseStatusBlock(text);
}

function validateUpliftDecider(r) {
  const errors = [];
  if (r.STATUS !== 'COMPLETE') errors.push('STATUS must be COMPLETE');
  if (!['accept', 'uplift', 'restart'].includes(r.VERDICT)) errors.push(`VERDICT must be accept|uplift|restart (got ${r.VERDICT})`);
  if (!r.RATIONALE) errors.push('RATIONALE required');
  if (!r.SUMMARY) errors.push('SUMMARY required');
  return errors;
}

{
  const raw = 'STATUS: COMPLETE\nVERDICT: accept\nCLOUD_CONFIDENCE: high\nRATIONALE: all criteria satisfied\nSUMMARY: accept local output';
  const r = parseUpliftDecider(raw);
  const errs = validateUpliftDecider(r);
  errs.length === 0
    ? ok('uplift-decider VERDICT=accept passes')
    : fail('uplift-decider VERDICT=accept passes', errs.join('; '));
}

{
  const raw = 'STATUS: COMPLETE\nVERDICT: uplift\nCLOUD_CONFIDENCE: medium\nRATIONALE: two criteria unsatisfied\nPATCH_SCOPE: extend error handling\nSUMMARY: cloud should extend not rewrite';
  const r = parseUpliftDecider(raw);
  const errs = validateUpliftDecider(r);
  (errs.length === 0 && r.PATCH_SCOPE && r.PATCH_SCOPE.length > 0)
    ? ok('uplift-decider VERDICT=uplift with PATCH_SCOPE passes')
    : fail('uplift-decider VERDICT=uplift passes', errs.join('; '));
}

{
  const raw = 'STATUS: COMPLETE\nVERDICT: restart\nCLOUD_CONFIDENCE: low\nRATIONALE: approach structurally wrong\nSUMMARY: discard, restart clean';
  const r = parseUpliftDecider(raw);
  const errs = validateUpliftDecider(r);
  (errs.length === 0 && !r.PATCH_SCOPE)
    ? ok('uplift-decider VERDICT=restart without PATCH_SCOPE passes')
    : fail('uplift-decider VERDICT=restart passes', errs.join('; '));
}

{
  const raw = 'STATUS: COMPLETE\nRATIONALE: something\nSUMMARY: malformed';
  const r = parseUpliftDecider(raw);
  const errs = validateUpliftDecider(r);
  errs.some(e => e.includes('VERDICT'))
    ? ok('uplift-decider missing VERDICT → error')
    : fail('uplift-decider missing VERDICT → error', errs.join('; '));
}

// ── 7. converger STATUS — COMPLETE with synthesis summary ─────────────────────
console.log('\n7. converger STATUS — base contract applies');

{
  // converger uses the base worker contract (no special extensions documented)
  const raw = [
    'STATUS: COMPLETE',
    'CONFIDENCE: high',
    'WROTE: waves/001/outputs/converger-item-a.md',
    'INDEX: waves/001/outputs/converger-item-a.INDEX.md',
    'FINDINGS: waves/001/findings/converger-item-a.jsonl',
    'FINDING_CATS: {crisis:0,plan-material:1,contextual:0,trivial:0,augmentation:0,improvement:0}',
    'SUMMARY: merged parallel outputs without conflict',
  ].join('\n');
  const r = parseStatusBlock(raw);
  const errs = validateWorkerStatus(r);
  errs.length === 0
    ? ok('converger COMPLETE + base contract passes')
    : fail('converger COMPLETE passes', errs.join('; '));
}

{
  // converger RECUSE → implementer-cloud (unresolvable conflict)
  const raw = [
    'STATUS: RECUSE',
    'ATTEMPTED: yes',
    'RECUSAL_REASON: parallel outputs have unresolvable architectural conflict',
    'RECOMMEND: implementer-cloud',
    'SUMMARY: conflict requires redesign, escalating',
  ].join('\n');
  const r = parseStatusBlock(raw);
  const errs = validateRecuse(r);
  errs.length === 0
    ? ok('converger RECUSE → implementer-cloud passes')
    : fail('converger RECUSE → implementer-cloud passes', errs.join('; '));
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
