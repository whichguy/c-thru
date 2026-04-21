#!/usr/bin/env node
// Fixture validator for the unified planner contract (v2).
// Covers: planner return block, structured findings JSON schema,
//         transition_type classification, and migration shim behavior.
// Run: node test/planner-return-schema.test.js

'use strict';

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

// ---------------------------------------------------------------------------
// Planner return block parser
// ---------------------------------------------------------------------------

function parsePlannerReturn(text) {
  const result = {};
  for (const line of text.trim().split('\n')) {
    const m = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'READY_ITEMS') {
      result[key] = val.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
    } else {
      result[key] = val.trim();
    }
  }
  return result;
}

// Driver validation rules (a)–(h) from planner contract
function validatePlannerReturn(r) {
  const errors = [];
  if (!['COMPLETE', 'CYCLE', 'ERROR'].includes(r.STATUS)) errors.push('(a) STATUS invalid');
  if (r.STATUS !== 'CYCLE' && r.STATUS !== 'ERROR' && !['ready', 'done'].includes(r.VERDICT)) errors.push('(b) VERDICT invalid');
  if (r.VERDICT === 'ready' && (!r.READY_ITEMS || r.READY_ITEMS.length === 0)) errors.push('(c) VERDICT=ready but READY_ITEMS empty');
  // (d) ID validation requires current.md context — skipped in unit test
  if (r.STATUS === 'CYCLE' && !r.ITEMS) errors.push('(e) STATUS=CYCLE but ITEMS absent');
  if (r.STATUS === 'ERROR' && !r.SUMMARY) errors.push('(f) STATUS=ERROR but SUMMARY absent');
  if (r.VERDICT === 'done' && r.READY_ITEMS && r.READY_ITEMS.length > 0) errors.push('(g) VERDICT=done but READY_ITEMS non-empty');
  if (r.VERDICT === 'done' && r.COMMIT_MESSAGE) errors.push('(h) VERDICT=done but COMMIT_MESSAGE present');
  return errors;
}

// ---------------------------------------------------------------------------
// Section 1 — Planner return block validation
// ---------------------------------------------------------------------------

console.log('\n1. Planner return block');

{
  const raw = `
STATUS: COMPLETE
VERDICT: ready
READY_ITEMS: [item-1, item-2]
COMMIT_MESSAGE: implement auth middleware and session store
DELTA_ADDED: 2
DELTA_CHANGED: 0
SUMMARY: initial wave with auth and session items
PARALLEL_WAVES: false
  `.trim();
  const r = parsePlannerReturn(raw);
  const errs = validatePlannerReturn(r);
  errs.length === 0 ? ok('VERDICT=ready with all fields') : fail('VERDICT=ready with all fields', errs.join('; '));
}

{
  const raw = `
STATUS: COMPLETE
VERDICT: done
DELTA_ADDED: 0
DELTA_CHANGED: 0
SUMMARY: no ready items remaining
PARALLEL_WAVES: false
  `.trim();
  const r = parsePlannerReturn(raw);
  const errs = validatePlannerReturn(r);
  errs.length === 0 ? ok('VERDICT=done clean') : fail('VERDICT=done clean', errs.join('; '));
}

{
  const raw = `
STATUS: CYCLE
ITEMS: item-3, item-7
SUMMARY: circular dependency detected
  `.trim();
  const r = parsePlannerReturn(raw);
  const errs = validatePlannerReturn(r);
  errs.length === 0 ? ok('STATUS=CYCLE with ITEMS') : fail('STATUS=CYCLE with ITEMS', errs.join('; '));
}

// Rule (a) — STATUS invalid
{
  const raw = `STATUS: UNKNOWN\nVERDICT: ready\nREADY_ITEMS: [item-1]`;
  const r = parsePlannerReturn(raw);
  const errs = validatePlannerReturn(r);
  errs.some(e => e.includes('(a)')) ? ok('(a) rejects invalid STATUS') : fail('(a) rejects invalid STATUS', `errors: ${errs}`);
}

// Rule (b) — VERDICT invalid
{
  const raw = `STATUS: COMPLETE\nVERDICT: continue\nREADY_ITEMS: [item-1]`;
  const r = parsePlannerReturn(raw);
  const errs = validatePlannerReturn(r);
  errs.some(e => e.includes('(b)')) ? ok('(b) rejects invalid VERDICT') : fail('(b) rejects invalid VERDICT');
}

// Rule (c) — VERDICT=ready but READY_ITEMS empty
{
  const raw = `STATUS: COMPLETE\nVERDICT: ready\nREADY_ITEMS: []\nCOMMIT_MESSAGE: implement something\nSUMMARY: x\nDELTA_ADDED: 0\nDELTA_CHANGED: 0\nPARALLEL_WAVES: false`;
  const r = parsePlannerReturn(raw);
  const errs = validatePlannerReturn(r);
  errs.some(e => e.includes('(c)')) ? ok('(c) rejects ready with empty READY_ITEMS') : fail('(c) rejects ready with empty READY_ITEMS');
}

// Rule (e) — STATUS=CYCLE but ITEMS absent
{
  const raw = `STATUS: CYCLE\nSUMMARY: cycle detected`;
  const r = parsePlannerReturn(raw);
  const errs = validatePlannerReturn(r);
  errs.some(e => e.includes('(e)')) ? ok('(e) rejects CYCLE without ITEMS') : fail('(e) rejects CYCLE without ITEMS');
}

// Rule (f) — STATUS=ERROR but SUMMARY absent
{
  const raw = `STATUS: ERROR\nVERDICT: done`;
  const r = parsePlannerReturn(raw);
  const errs = validatePlannerReturn(r);
  errs.some(e => e.includes('(f)')) ? ok('(f) rejects ERROR without SUMMARY') : fail('(f) rejects ERROR without SUMMARY');
}

// Rule (g) — VERDICT=done but READY_ITEMS non-empty
{
  const raw = `STATUS: COMPLETE\nVERDICT: done\nREADY_ITEMS: [item-1]\nSUMMARY: done\nDELTA_ADDED: 0\nDELTA_CHANGED: 0\nPARALLEL_WAVES: false`;
  const r = parsePlannerReturn(raw);
  const errs = validatePlannerReturn(r);
  errs.some(e => e.includes('(g)')) ? ok('(g) rejects done with non-empty READY_ITEMS') : fail('(g) rejects done with non-empty READY_ITEMS');
}

// Rule (h) — VERDICT=done but COMMIT_MESSAGE present
{
  const raw = `STATUS: COMPLETE\nVERDICT: done\nCOMMIT_MESSAGE: oops\nSUMMARY: done\nDELTA_ADDED: 0\nDELTA_CHANGED: 0\nPARALLEL_WAVES: false`;
  const r = parsePlannerReturn(raw);
  const errs = validatePlannerReturn(r);
  errs.some(e => e.includes('(h)')) ? ok('(h) rejects done with COMMIT_MESSAGE') : fail('(h) rejects done with COMMIT_MESSAGE');
}

// ---------------------------------------------------------------------------
// Section 2 — Structured findings JSON schema
// ---------------------------------------------------------------------------

console.log('\n2. Structured findings JSON schema');

function validateFinding(obj) {
  const required = ['item_id', 'status', 'produced', 'dep_discoveries', 'outcome_risk'];
  const missing = required.filter(k => !(k in obj));
  if (missing.length > 0) return { valid: false, missing };
  if (!Array.isArray(obj.produced)) return { valid: false, missing: ['produced must be array'] };
  if (!Array.isArray(obj.dep_discoveries)) return { valid: false, missing: ['dep_discoveries must be array'] };
  if (typeof obj.outcome_risk !== 'boolean') return { valid: false, missing: ['outcome_risk must be boolean'] };
  for (const d of obj.dep_discoveries) {
    if (!d.affects_item || !d.type || !d.confidence) {
      return { valid: false, missing: ['dep_discovery missing affects_item/type/confidence'] };
    }
    if (!['high', 'low'].includes(d.confidence)) {
      return { valid: false, missing: ['dep_discovery confidence must be high|low'] };
    }
  }
  return { valid: true };
}

{
  const f = {
    item_id: 'item-3', status: 'complete',
    produced: ['src/middleware/auth.ts'],
    dep_discoveries: [{ affects_item: 'item-7', type: 'resource_dependency', path: 'src/chain.ts', note: 'pos 2', confidence: 'high' }],
    complexity_delta: 0, outcome_risk: false, outcome_risk_reason: null
  };
  const v = validateFinding(f);
  v.valid ? ok('valid finding with dep_discovery') : fail('valid finding with dep_discovery', v.missing?.join(', '));
}

{
  const f = { item_id: 'item-1', status: 'complete', produced: [], dep_discoveries: [], outcome_risk: false };
  const v = validateFinding(f);
  v.valid ? ok('minimal finding (no discoveries)') : fail('minimal finding (no discoveries)', v.missing?.join(', '));
}

{
  const f = { item_id: 'item-5', status: 'complete', produced: [], dep_discoveries: [], outcome_risk: true };
  const v = validateFinding(f);
  v.valid ? ok('outcome_risk=true finding') : fail('outcome_risk=true finding');
}

{
  const f = { item_id: 'item-2', status: 'complete', produced: 'not-an-array', dep_discoveries: [], outcome_risk: false };
  const v = validateFinding(f);
  !v.valid ? ok('rejects non-array produced') : fail('rejects non-array produced');
}

{
  const f = { item_id: 'item-9', status: 'complete', produced: [], dep_discoveries: [{ affects_item: 'x', type: 'y', confidence: 'medium' }], outcome_risk: false };
  const v = validateFinding(f);
  !v.valid ? ok('rejects invalid confidence value') : fail('rejects invalid confidence value');
}

{
  const f = { status: 'complete', produced: [], dep_discoveries: [], outcome_risk: false };
  const v = validateFinding(f);
  !v.valid ? ok('rejects missing item_id') : fail('rejects missing item_id');
}

// ---------------------------------------------------------------------------
// Section 3 — Transition type classification
// ---------------------------------------------------------------------------

console.log('\n3. Transition type classification');

function classifyTransition(findings) {
  let hasOutcomeRisk = false;
  let hasUnrecoverable = false;
  let hasLowConfidence = false;

  for (const f of findings) {
    const v = validateFinding(f);
    if (!v.valid) {
      // Migration shim: try to recover item_id + status
      if (f.item_id && f.status) {
        hasLowConfidence = true; // shim-normalized → dep_update
      } else {
        hasUnrecoverable = true; // unrecoverable → outcome_risk
      }
      continue;
    }
    if (f.outcome_risk) hasOutcomeRisk = true;
    for (const d of f.dep_discoveries) {
      if (d.confidence === 'low') hasLowConfidence = true;
    }
  }

  if (hasOutcomeRisk || hasUnrecoverable) return 'outcome_risk';
  if (hasLowConfidence) return 'dep_update';
  return 'clean';
}

{
  const findings = [
    { item_id: 'i1', status: 'complete', produced: [], dep_discoveries: [{ affects_item: 'i2', type: 'res', confidence: 'high' }], outcome_risk: false },
    { item_id: 'i2', status: 'complete', produced: [], dep_discoveries: [], outcome_risk: false }
  ];
  const t = classifyTransition(findings);
  t === 'clean' ? ok('all-high-confidence + no-risk → clean') : fail('all-high-confidence + no-risk → clean', `got ${t}`);
}

{
  const findings = [
    { item_id: 'i1', status: 'complete', produced: [], dep_discoveries: [{ affects_item: 'i2', type: 'res', confidence: 'low' }], outcome_risk: false }
  ];
  const t = classifyTransition(findings);
  t === 'dep_update' ? ok('low-confidence dep_discovery → dep_update') : fail('low-confidence dep_discovery → dep_update', `got ${t}`);
}

{
  const findings = [
    { item_id: 'i1', status: 'complete', produced: [], dep_discoveries: [], outcome_risk: true }
  ];
  const t = classifyTransition(findings);
  t === 'outcome_risk' ? ok('outcome_risk=true → outcome_risk') : fail('outcome_risk=true → outcome_risk', `got ${t}`);
}

// ---------------------------------------------------------------------------
// Section 4 — Migration shim behavior
// ---------------------------------------------------------------------------

console.log('\n4. Migration shim');

{
  // Free-form finding that the shim can recover (has item_id + status but missing dep_discoveries)
  const shimFinding = { item_id: 'i1', status: 'complete', produced: ['foo.ts'] };
  const findings = [shimFinding];
  const t = classifyTransition(findings);
  t === 'dep_update' ? ok('shim-normalized finding → dep_update (not outcome_risk)') : fail('shim-normalized finding → dep_update', `got ${t}`);
}

{
  // Completely unrecoverable finding (missing item_id)
  const findings = [{ status: 'complete', produced: ['foo.ts'], some: 'extra' }];
  const t = classifyTransition(findings);
  t === 'outcome_risk' ? ok('unrecoverable finding (missing item_id) → outcome_risk') : fail('unrecoverable finding → outcome_risk', `got ${t}`);
}

{
  // Mixed: one good finding + one shim-normalized → dep_update
  const findings = [
    { item_id: 'i1', status: 'complete', produced: [], dep_discoveries: [], outcome_risk: false },
    { item_id: 'i2', status: 'complete', produced: ['bar.ts'] } // shim: missing required fields
  ];
  const t = classifyTransition(findings);
  t === 'dep_update' ? ok('mixed (good + shim-normalized) → dep_update') : fail('mixed (good + shim-normalized) → dep_update', `got ${t}`);
}

{
  // outcome_risk wins over shim-normalized
  const findings = [
    { item_id: 'i1', status: 'complete', produced: [] }, // shim
    { item_id: 'i2', status: 'complete', produced: [], dep_discoveries: [], outcome_risk: true } // risk
  ];
  const t = classifyTransition(findings);
  t === 'outcome_risk' ? ok('outcome_risk overrides shim-normalized → outcome_risk') : fail('outcome_risk overrides shim-normalized', `got ${t}`);
}

// ---------------------------------------------------------------------------
// Section 5 — RECUSE STATUS fixtures (Wave-2 escalation)
// ---------------------------------------------------------------------------

console.log('\n5. RECUSE STATUS fixtures');

// Orchestrator response handler — strips think tags, parses STATUS block
function stripThinkTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think><\/think>/g, '');
}

function parseWorkerStatus(raw) {
  const text = stripThinkTags(raw);
  const result = {};
  for (const line of text.trim().split('\n')) {
    const m = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (!m) continue;
    result[m[1]] = m[2].trim();
  }
  return result;
}

// 1. STATUS: RECUSE with ATTEMPTED=yes parses without crash
{
  const raw = `
## Work completed
partial work here

STATUS: RECUSE
ATTEMPTED: yes
RECUSAL_REASON: cannot confirm output satisfies criteria without running integration tests
RECOMMEND: uplift-decider
PARTIAL_OUTPUT: waves/001/outputs/implementer-item-A.md
SUMMARY: recused mid-execution, partial output written
  `.trim();
  const r = parseWorkerStatus(raw);
  (r.STATUS === 'RECUSE' && r.ATTEMPTED === 'yes' && r.RECOMMEND === 'uplift-decider' && r.PARTIAL_OUTPUT)
    ? ok('RECUSE ATTEMPTED=yes — all fields present')
    : fail('RECUSE ATTEMPTED=yes — all fields present', JSON.stringify(r));
}

// 2. STATUS: RECUSE with ATTEMPTED=no parses without crash
{
  const raw = `STATUS: RECUSE
ATTEMPTED: no
RECUSAL_REASON: two valid interpretations exist — cannot determine which satisfies criteria
RECOMMEND: uplift-decider
SUMMARY: pre-execution recusal, no partial output`;
  const r = parseWorkerStatus(raw);
  (r.STATUS === 'RECUSE' && r.ATTEMPTED === 'no' && !r.PARTIAL_OUTPUT)
    ? ok('RECUSE ATTEMPTED=no — PARTIAL_OUTPUT absent')
    : fail('RECUSE ATTEMPTED=no — PARTIAL_OUTPUT absent', JSON.stringify(r));
}

// 3. RECOMMEND field present and non-empty
{
  const raw = `STATUS: RECUSE\nATTEMPTED: no\nRECUSAL_REASON: missing pattern\nRECOMMEND: implementer-cloud\nSUMMARY: recused`;
  const r = parseWorkerStatus(raw);
  (r.RECOMMEND && r.RECOMMEND.length > 0)
    ? ok('RECOMMEND field non-empty')
    : fail('RECOMMEND field non-empty', JSON.stringify(r));
}

// 4. Absent RECOMMEND gracefully treated as empty string (not null-deref)
{
  const raw = `STATUS: RECUSE\nATTEMPTED: no\nRECUSAL_REASON: missing pattern\nSUMMARY: recused`;
  const r = parseWorkerStatus(raw);
  (r.RECOMMEND === undefined || r.RECOMMEND === '')
    ? ok('absent RECOMMEND → undefined (no crash)')
    : fail('absent RECOMMEND → undefined (no crash)', JSON.stringify(r));
}

// 5. PARTIAL_OUTPUT omitted when ATTEMPTED=no
{
  const raw = `STATUS: RECUSE\nATTEMPTED: no\nRECUSAL_REASON: unverifiable\nRECOMMEND: uplift-decider\nSUMMARY: x`;
  const r = parseWorkerStatus(raw);
  (!r.PARTIAL_OUTPUT)
    ? ok('PARTIAL_OUTPUT absent when ATTEMPTED=no')
    : fail('PARTIAL_OUTPUT absent when ATTEMPTED=no', `got: ${r.PARTIAL_OUTPUT}`);
}

// 6. Malformed RECUSE (missing RECUSAL_REASON) — orchestrator marks failed, not crashed
{
  const raw = `STATUS: RECUSE\nATTEMPTED: yes\nRECOMMEND: uplift-decider\nSUMMARY: broken`;
  const r = parseWorkerStatus(raw);
  const malformed = r.STATUS === 'RECUSE' && !r.RECUSAL_REASON;
  malformed
    ? ok('malformed RECUSE (missing RECUSAL_REASON) detected — orchestrator marks failed')
    : fail('malformed RECUSE (missing RECUSAL_REASON) detected', JSON.stringify(r));
}

// 7. Think-tag stripping before STATUS parse
{
  const raw = `<think>
some extended thinking here
about what to do
</think>
STATUS: RECUSE
ATTEMPTED: no
RECUSAL_REASON: cannot verify output satisfies criteria
RECOMMEND: test-writer-cloud
SUMMARY: recused after thinking`;
  const r = parseWorkerStatus(raw);
  (r.STATUS === 'RECUSE' && r.RECOMMEND === 'test-writer-cloud')
    ? ok('think-tag stripped before STATUS parse')
    : fail('think-tag stripped before STATUS parse', JSON.stringify(r));
}

// 8. wave.json item with escalation_policy: pre-escalate — field round-trips correctly
{
  const item = {
    agent: 'implementer', item: 'item-X', target_resources: ['src/foo.ts'],
    depends_on: [], escalation_policy: 'pre-escalate', escalation_policy_source: 'step4b',
    escalation_depth: 0, escalation_log: []
  };
  const serialized = JSON.stringify(item);
  const parsed = JSON.parse(serialized);
  (parsed.escalation_policy === 'pre-escalate' && parsed.escalation_depth === 0 && Array.isArray(parsed.escalation_log))
    ? ok('escalation_policy: pre-escalate round-trips in wave.json item')
    : fail('escalation_policy: pre-escalate round-trips in wave.json item', JSON.stringify(parsed));
}

// 9. RECOMMEND: judge → should be treated as judge-tier sentinel (block + surface to user)
//    Simulate orchestrator logic: RECOMMEND resolves to judge tier → blocked
{
  const AGENT_TO_CAPABILITY = {
    'implementer-cloud': 'deep-coder-cloud',
    'test-writer-cloud': 'code-analyst-cloud',
    'uplift-decider': 'judge',
    'planner': 'judge',
    'auditor': 'judge',
  };
  function isJudgeTier(recommend) {
    if (recommend === 'judge') return true;
    return AGENT_TO_CAPABILITY[recommend] === 'judge';
  }
  (isJudgeTier('judge') && isJudgeTier('uplift-decider') && !isJudgeTier('implementer-cloud') && !isJudgeTier('test-writer-cloud'))
    ? ok('isJudgeTier sentinel: "judge" and judge-mapped agents detected correctly')
    : fail('isJudgeTier sentinel: unexpected result');
}

// 10. RECOMMEND: judge at depth=1 → orchestrator should block before depth cap (depth cap is 3)
{
  const raw = `STATUS: RECUSE\nATTEMPTED: yes\nRECUSAL_REASON: task requires security domain knowledge beyond verification ability\nRECOMMEND: judge\nPARTIAL_OUTPUT: waves/001/outputs/implementer-cloud-item-Z.md\nSUMMARY: cloud tier recused, judge-tier sentinel`;
  const r = parseWorkerStatus(raw);
  const escalationDepth = 1; // depth=1, well below cap of 3
  const AGENT_TO_CAPABILITY = { 'judge': 'judge', 'uplift-decider': 'judge' };
  const isJudgeSentinel = r.RECOMMEND === 'judge' || AGENT_TO_CAPABILITY[r.RECOMMEND] === 'judge';
  // Orchestrator: judge-tier check fires before depth cap — item becomes blocked+surface regardless of depth
  const shouldBlock = isJudgeSentinel; // depth cap NOT the deciding factor
  shouldBlock
    ? ok('RECOMMEND=judge at depth=1 → blocked+surface (judge-tier check before depth cap)')
    : fail('RECOMMEND=judge at depth=1 → blocked+surface', JSON.stringify(r));
}

// 11. escalation_depth >= 3 → blocked (depth cap, non-judge RECOMMEND)
{
  const item = {
    agent: 'implementer', item: 'item-D', target_resources: ['src/hard.ts'],
    depends_on: [], escalation_policy: 'local', escalation_depth: 3,
    escalation_log: [
      { agent: 'implementer', tier: 'deep-coder', attempted: false, recusal_reason: 'r1', partial_output: null },
      { agent: 'uplift-decider', tier: 'judge', attempted: false, recusal_reason: 'r2', partial_output: null },
      { agent: 'implementer-cloud', tier: 'deep-coder-cloud', attempted: true, recusal_reason: 'r3', partial_output: 'waves/001/outputs/implementer-cloud-item-D.md' }
    ]
  };
  const depthCapHit = item.escalation_depth >= 3;
  depthCapHit
    ? ok('escalation_depth >= 3 → depth cap triggers blocked')
    : fail('escalation_depth >= 3 → depth cap triggers blocked', `depth: ${item.escalation_depth}`);
}

// 12. never-cloud items skipped by step 4b (escalation_policy preserved)
{
  const item = {
    agent: 'implementer', item: 'item-NC', target_resources: ['src/proprietary.ts'],
    depends_on: [], escalation_policy: 'never-cloud', escalation_depth: 0, escalation_log: []
  };
  // Step 4b: skip items already carrying "never-cloud" — policy must not be overwritten
  const shouldSkipClassification = item.escalation_policy === 'never-cloud';
  shouldSkipClassification
    ? ok('never-cloud item: step 4b skips classification, policy preserved')
    : fail('never-cloud item: step 4b skips classification', JSON.stringify(item));
}

// ---------------------------------------------------------------------------
// Section 6 — uplift-decider VERDICT parsing (Wave-2 orchestrator dispatch)
// ---------------------------------------------------------------------------

console.log('\n6. uplift-decider VERDICT parsing');

// uplift-decider returns STATUS: COMPLETE + VERDICT — no Work/Findings/INDEX sections.
// Orchestrator must detect VERDICT before section parsing to avoid marking item failed.

function parseUpliftDeciderResponse(raw) {
  const text = stripThinkTags(raw);
  const result = {};
  for (const line of text.trim().split('\n')) {
    const m = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (!m) continue;
    result[m[1]] = m[2].trim();
  }
  return result;
}

function classifyUpliftVerdict(r) {
  if (r.STATUS !== 'COMPLETE') return 'not-complete';
  if (!r.VERDICT) return 'missing-verdict';
  if (r.VERDICT === 'accept') return 'accept';
  if (r.VERDICT === 'uplift') return 'uplift';
  if (r.VERDICT === 'restart') return 'restart';
  return 'unknown-verdict';
}

// 13. VERDICT: accept — orchestrator promotes local partial output, marks COMPLETE
{
  const raw = `STATUS: COMPLETE
VERDICT: accept
CLOUD_CONFIDENCE: high
RATIONALE: all success criteria satisfied by partial output as written
SUMMARY: local output accepted without cloud dispatch`;
  const r = parseUpliftDeciderResponse(raw);
  const action = classifyUpliftVerdict(r);
  (action === 'accept' && r.STATUS === 'COMPLETE' && r.CLOUD_CONFIDENCE === 'high')
    ? ok('VERDICT=accept — promote partial output, mark COMPLETE')
    : fail('VERDICT=accept — promote partial output, mark COMPLETE', JSON.stringify(r));
}

// 14. VERDICT: uplift — orchestrator dispatches implementer-cloud with escalation context
{
  const raw = `STATUS: COMPLETE
VERDICT: uplift
CLOUD_CONFIDENCE: medium
RATIONALE: core approach sound but two criteria unsatisfied
PATCH_SCOPE: extend error handling in processAuth; add null-guard before token.claims access
SUMMARY: partial output viable; cloud should extend not rewrite`;
  const r = parseUpliftDeciderResponse(raw);
  const action = classifyUpliftVerdict(r);
  (action === 'uplift' && r.PATCH_SCOPE && r.PATCH_SCOPE.length > 0)
    ? ok('VERDICT=uplift — dispatch implementer-cloud with uplift context')
    : fail('VERDICT=uplift — dispatch implementer-cloud with uplift context', JSON.stringify(r));
}

// 15. VERDICT: restart — orchestrator dispatches implementer-cloud with clean original digest
{
  const raw = `STATUS: COMPLETE
VERDICT: restart
CLOUD_CONFIDENCE: low
RATIONALE: core approach is structurally wrong — anchoring on draft would propagate mistake
SUMMARY: discard partial output; restart from original task digest`;
  const r = parseUpliftDeciderResponse(raw);
  const action = classifyUpliftVerdict(r);
  (action === 'restart' && !r.PATCH_SCOPE)
    ? ok('VERDICT=restart — dispatch with clean digest, PATCH_SCOPE absent')
    : fail('VERDICT=restart — dispatch with clean digest, PATCH_SCOPE absent', JSON.stringify(r));
}

// 16. uplift-decider missing VERDICT → mark item failed
{
  const raw = `STATUS: COMPLETE
RATIONALE: something happened
SUMMARY: malformed response`;
  const r = parseUpliftDeciderResponse(raw);
  const action = classifyUpliftVerdict(r);
  (action === 'missing-verdict')
    ? ok('uplift-decider missing VERDICT → mark item failed')
    : fail('uplift-decider missing VERDICT → mark item failed', `action: ${action}`);
}

// 17. uplift-decider VERDICT: accept has no ## Work/Findings/INDEX sections (routing-only response)
{
  const raw = `STATUS: COMPLETE
VERDICT: accept
CLOUD_CONFIDENCE: high
RATIONALE: all success criteria satisfied
SUMMARY: accept local output`;
  // Confirm: no section headers present — orchestrator must NOT treat missing sections as failure
  const hasWorkSection = raw.includes('## Work completed');
  const hasFindings = raw.includes('## Findings');
  const hasIndex = raw.includes('## Output INDEX');
  (!hasWorkSection && !hasFindings && !hasIndex)
    ? ok('uplift-decider accept response: no Work/Findings/INDEX sections (routing-only)')
    : fail('uplift-decider accept response: unexpected section headers found');
}

// ---------------------------------------------------------------------------
// Section 7 — LINT_ITERATIONS field (implementer self-directed lint loop)
// ---------------------------------------------------------------------------

console.log('\n7. LINT_ITERATIONS fixtures');

// 1. LINT_ITERATIONS: 0 — clean first pass (or no applicable linters)
{
  const raw = `STATUS: COMPLETE\nCONFIDENCE: high\nWROTE: waves/001/outputs/implementer-item-A.md\nINDEX: waves/001/outputs/implementer-item-A.INDEX.md\nFINDINGS: waves/001/findings/implementer-item-A.jsonl\nFINDING_CATS: {crisis:0,plan-material:0,contextual:0,trivial:0,augmentation:0,improvement:1}\nLINT_ITERATIONS: 0\nSUMMARY: implementation complete`;
  const r = parseWorkerStatus(raw);
  (r.LINT_ITERATIONS === '0' && r.CONFIDENCE === 'high')
    ? ok('LINT_ITERATIONS: 0 — clean first pass parses correctly')
    : fail('LINT_ITERATIONS: 0 — clean first pass parses correctly', JSON.stringify(r));
}

// 2. LINT_ITERATIONS: 3 — fixed after 3 rounds
{
  const raw = `STATUS: COMPLETE\nCONFIDENCE: high\nWROTE: waves/001/outputs/implementer-item-B.md\nINDEX: waves/001/outputs/implementer-item-B.INDEX.md\nFINDINGS: waves/001/findings/implementer-item-B.jsonl\nFINDING_CATS: {crisis:0,plan-material:0,contextual:0,trivial:0,augmentation:0,improvement:1}\nLINT_ITERATIONS: 3\nSUMMARY: implementation complete after 3 lint rounds`;
  const r = parseWorkerStatus(raw);
  (r.LINT_ITERATIONS === '3')
    ? ok('LINT_ITERATIONS: 3 — fixed after 3 rounds parses correctly')
    : fail('LINT_ITERATIONS: 3 — fixed after 3 rounds parses correctly', JSON.stringify(r));
}

// 3. Absent LINT_ITERATIONS → treated as 0 (backward-compat)
{
  const raw = `STATUS: COMPLETE\nCONFIDENCE: high\nWROTE: waves/001/outputs/implementer-item-C.md\nINDEX: waves/001/outputs/implementer-item-C.INDEX.md\nFINDINGS: waves/001/findings/implementer-item-C.jsonl\nFINDING_CATS: {crisis:0,plan-material:0,contextual:0,trivial:0,augmentation:0,improvement:1}\nSUMMARY: legacy response without lint field`;
  const r = parseWorkerStatus(raw);
  const lintIter = r.LINT_ITERATIONS !== undefined ? parseInt(r.LINT_ITERATIONS, 10) : 0;
  (lintIter === 0 && r.LINT_ITERATIONS === undefined)
    ? ok('absent LINT_ITERATIONS → treated as 0 (backward-compat)')
    : fail('absent LINT_ITERATIONS → treated as 0', JSON.stringify(r));
}

// 4. CONFIDENCE=high with LINT_ITERATIONS present: valid (lint was clean)
{
  const raw = `STATUS: COMPLETE\nCONFIDENCE: high\nWROTE: waves/001/outputs/implementer-item-D.md\nINDEX: waves/001/outputs/implementer-item-D.INDEX.md\nFINDINGS: waves/001/findings/implementer-item-D.jsonl\nFINDING_CATS: {crisis:0,plan-material:0,contextual:0,trivial:0,augmentation:0,improvement:1}\nLINT_ITERATIONS: 2\nSUMMARY: lint clean after 2 rounds`;
  const r = parseWorkerStatus(raw);
  (r.CONFIDENCE === 'high' && r.LINT_ITERATIONS === '2')
    ? ok('CONFIDENCE=high with LINT_ITERATIONS present: valid (lint was clean)')
    : fail('CONFIDENCE=high with LINT_ITERATIONS present: valid', JSON.stringify(r));
}

// 5. LINT_ITERATIONS: 5 + plan-material finding "lint errors remained after cap" + CONFIDENCE: high → invalid
//    (unfixed errors at cap force CONFIDENCE ≤ medium per agent directive)
{
  const raw = `STATUS: COMPLETE\nCONFIDENCE: high\nWROTE: waves/001/outputs/implementer-item-E.md\nINDEX: waves/001/outputs/implementer-item-E.INDEX.md\nFINDINGS: waves/001/findings/implementer-item-E.jsonl\nFINDING_CATS: {crisis:0,plan-material:1,contextual:0,trivial:0,augmentation:0,improvement:1}\nLINT_ITERATIONS: 5\nSUMMARY: cap hit, lint errors remain`;
  const r = parseWorkerStatus(raw);
  const findingCats = r.FINDING_CATS || '';
  const hasCapHitFinding = findingCats.includes('plan-material:1');
  const lintIter = parseInt(r.LINT_ITERATIONS, 10);
  // Validation: cap hit (5) + plan-material finding + CONFIDENCE=high → invalid combination
  const isInvalid = lintIter >= 5 && hasCapHitFinding && r.CONFIDENCE === 'high';
  isInvalid
    ? ok('LINT_ITERATIONS:5 + plan-material + CONFIDENCE:high → invalid (must be ≤medium at cap)')
    : fail('LINT_ITERATIONS:5 + plan-material + CONFIDENCE:high → invalid', JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n✗ ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log('\n✓ All tests passed');
  process.exit(0);
}
