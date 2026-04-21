#!/usr/bin/env node
/**
 * c-thru-plan-harness.test.js — Unit tests for tools/c-thru-plan-harness.js
 *
 * Covers:
 *   - parseCurrentMd: item parsing, status, attributes
 *   - topoSort: ordering, cycle detection, simplest-first within tier
 *   - assignBatches: resource conflict, no-resource own-batch, parallel grouping
 *   - batch-abort threshold: 50% rule + small-batch rule
 *   - calibrate: confidence normalization, compliance flag
 *   - inject-contract: idempotency, content prepend
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ── Test harness ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL  ${msg}`);
    failed++;
  }
}

function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// Require the harness internals by re-exporting via a thin wrapper shim.
// Since the harness uses process.argv for dispatch, we test internal functions
// by re-requiring with module isolation (clear cache between requires).
// Functions under test: parseCurrentMd, topoSort, assignBatches.
// We inline them from the source for unit-testability without modifying the harness.

// ── Inline imports (mirrored from harness source) ──────────────────────────────

function parseCurrentMd(content) {
  const items = new Map();
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const itemMatch = line.match(/^-\s+\[([x ])\]\s+([\w-]+)\s*:/i);
    if (itemMatch) {
      const status = itemMatch[1].toLowerCase() === 'x' ? 'done' : 'pending';
      const id = itemMatch[2];
      const item = { id, status, depends_on: [], target_resources: [], agent: null };
      i++;
      while (i < lines.length && (lines[i].match(/^\s+\S/) || lines[i].trim() === '')) {
        const attr = lines[i].trim();
        const depsM = attr.match(/^depends_on:\s*\[([^\]]*)\]/);
        const resM  = attr.match(/^target_resources:\s*\[([^\]]*)\]/);
        const agM   = attr.match(/^agent:\s*(\S+)/);
        if (depsM) item.depends_on = depsM[1].split(',').map(s => s.trim()).filter(Boolean);
        else if (resM) item.target_resources = resM[1].split(',').map(s => s.trim()).filter(Boolean);
        else if (agM) item.agent = agM[1];
        i++;
      }
      items.set(id, item);
    } else {
      i++;
    }
  }
  return items;
}

function topoSort(readyItems, specs) {
  const readySet = new Set(readyItems);
  const inDegree = new Map(readyItems.map(id => [id, 0]));
  const adj      = new Map(readyItems.map(id => [id, []]));
  for (const id of readyItems) {
    const spec = specs.get(id) || {};
    for (const dep of (spec.depends_on || [])) {
      if (readySet.has(dep)) {
        adj.get(dep).push(id);
        inDegree.set(id, inDegree.get(id) + 1);
      }
    }
  }
  const simplestFirst = (a, b) => {
    const aSpec = specs.get(a) || {}, bSpec = specs.get(b) || {};
    const dA = (aSpec.depends_on || []).length, dB = (bSpec.depends_on || []).length;
    if (dA !== dB) return dA - dB;
    return (aSpec.target_resources || []).length - (bSpec.target_resources || []).length;
  };
  const queue  = readyItems.filter(id => inDegree.get(id) === 0).sort(simplestFirst);
  const result = [];
  while (queue.length > 0) {
    const id = queue.shift(); result.push(id);
    const nexts = (adj.get(id) || []).sort(simplestFirst);
    for (const next of nexts) {
      const deg = inDegree.get(next) - 1; inDegree.set(next, deg);
      if (deg === 0) {
        let pos = queue.length;
        while (pos > 0 && simplestFirst(next, queue[pos-1]) < 0) pos--;
        queue.splice(pos, 0, next);
      }
    }
  }
  if (result.length !== readyItems.length) throw new Error('cycle');
  return result;
}

function assignBatches(sorted, specs) {
  const batches = [];
  for (const id of sorted) {
    const spec = specs.get(id) || {};
    const resources = new Set(spec.target_resources || []);
    if (resources.size === 0) { batches.push({ parallel: false, items: [id] }); continue; }
    const last = batches[batches.length - 1];
    if (last && last.parallel !== false) {
      const depC = (spec.depends_on || []).some(dep => last.items.includes(dep));
      const resC = last.items.some(eid => ((specs.get(eid) || {}).target_resources || []).some(r => resources.has(r)));
      if (!depC && !resC) { last.items.push(id); continue; }
    }
    batches.push({ parallel: true, items: [id] });
  }
  return batches;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const HARNESS = path.join(__dirname, '..', 'tools', 'c-thru-plan-harness.js');

function runHarness(args, opts = {}) {
  try {
    const out = execFileSync(process.execPath, [HARNESS, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
}

// ── 1. parseCurrentMd ─────────────────────────────────────────────────────────

console.log('\n1. parseCurrentMd — item parsing');

const sampleMd = `
## Outcome
Build a widget.

## Items

- [ ] item-1: create widget skeleton
  depends_on: []
  target_resources: [src/widget.js, src/index.js]
  agent: scaffolder

- [x] item-2: implement widget logic
  depends_on: [item-1]
  target_resources: [src/widget.js]
  agent: implementer

- [ ] item-3: write widget tests
  depends_on: [item-2]
  target_resources: [test/widget.test.js]
  agent: test-writer

- [ ] item-4: add docs
  depends_on: [item-1, item-2]
  target_resources: []
  agent: doc-writer
`;

const parsed = parseCurrentMd(sampleMd);
assert(parsed.size === 4, 'parses 4 items');
assert(parsed.get('item-1').status === 'pending', 'item-1 status=pending');
assert(parsed.get('item-2').status === 'done', 'item-2 status=done');
assert(deepEq(parsed.get('item-1').depends_on, []), 'item-1 depends_on=[]');
assert(deepEq(parsed.get('item-3').depends_on, ['item-2']), 'item-3 depends_on=[item-2]');
assert(deepEq(parsed.get('item-1').target_resources, ['src/widget.js', 'src/index.js']), 'item-1 target_resources correct');
assert(parsed.get('item-1').agent === 'scaffolder', 'item-1 agent=scaffolder');
assert(deepEq(parsed.get('item-4').target_resources, []), 'item-4 target_resources=[]');

// ── 2. topoSort ───────────────────────────────────────────────────────────────

console.log('\n2. topoSort — ordering and cycle detection');

{
  // Simple linear chain: item-1 → item-3 (item-2 done, excluded from ready set)
  const specs = parsed;
  const ready = ['item-1', 'item-3', 'item-4'];
  const sorted = topoSort(ready, specs);
  const i1 = sorted.indexOf('item-1');
  const i3 = sorted.indexOf('item-3');
  const i4 = sorted.indexOf('item-4');
  assert(i1 < i3, 'item-1 before item-3 (dep order)');
  assert(i1 < i4, 'item-1 before item-4 (dep order)');
  assert(sorted.length === 3, 'all 3 ready items present');
}

{
  // Simplest-first within same tier: A (0 deps, 1 resource) vs B (0 deps, 2 resources)
  const specsSimple = new Map([
    ['A', { depends_on: [], target_resources: ['f1'],     agent: null }],
    ['B', { depends_on: [], target_resources: ['f2','f3'], agent: null }],
  ]);
  const sorted = topoSort(['A', 'B'], specsSimple);
  assert(sorted[0] === 'A', 'simplest-first: fewer resources comes first');
}

{
  // Cycle detection
  const specsCycle = new Map([
    ['X', { depends_on: ['Y'], target_resources: [], agent: null }],
    ['Y', { depends_on: ['X'], target_resources: [], agent: null }],
  ]);
  let threw = false;
  try { topoSort(['X', 'Y'], specsCycle); } catch { threw = true; }
  assert(threw, 'throws on cycle');
}

// ── 3. assignBatches ─────────────────────────────────────────────────────────

console.log('\n3. assignBatches — resource conflict and parallel grouping');

{
  // Non-overlapping resources → same batch
  const specs = new Map([
    ['A', { depends_on: [], target_resources: ['file-a.js'], agent: null }],
    ['B', { depends_on: [], target_resources: ['file-b.js'], agent: null }],
  ]);
  const batches = assignBatches(['A', 'B'], specs);
  assert(batches.length === 1, 'non-overlapping resources → 1 batch');
  assert(batches[0].items.length === 2, 'both items in same batch');
  assert(batches[0].parallel === true, 'batch is parallel');
}

{
  // Overlapping resources → separate batches
  const specs = new Map([
    ['A', { depends_on: [], target_resources: ['shared.js'], agent: null }],
    ['B', { depends_on: [], target_resources: ['shared.js'], agent: null }],
  ]);
  const batches = assignBatches(['A', 'B'], specs);
  assert(batches.length === 2, 'overlapping resources → 2 batches');
}

{
  // No target_resources → own batch
  const specs = new Map([
    ['A', { depends_on: [], target_resources: [],       agent: null }],
    ['B', { depends_on: [], target_resources: ['b.js'], agent: null }],
  ]);
  const batches = assignBatches(['A', 'B'], specs);
  assert(batches.find(b => b.items.includes('A')).parallel === false, 'no-resource item has parallel=false');
  assert(batches.length === 2, 'no-resource item gets own batch');
}

{
  // Ancestor/descendant relationship → separate batches even with non-overlapping resources
  const specs = new Map([
    ['A', { depends_on: [],    target_resources: ['a.js'], agent: null }],
    ['B', { depends_on: ['A'], target_resources: ['b.js'], agent: null }],
  ]);
  const batches = assignBatches(['A', 'B'], specs);
  assert(batches.length === 2, 'dep relationship → separate batches');
  assert(batches[0].items[0] === 'A', 'A first (no deps)');
}

// ── 4. batch-abort threshold (CLI) ────────────────────────────────────────────

console.log('\n4. batch-abort — threshold and small-batch rules');

{
  const tmp = tmpDir();
  const r = runHarness(['batch-abort', '--failed', '1', '--total', '4', '--wave-dir', tmp]);
  assert(r.code === 0, 'continue: 1/4 (25%) ≤ 50%');
  assert(r.stdout.includes('CONTINUE'), 'output says CONTINUE');
}

{
  const tmp = tmpDir();
  const r = runHarness(['batch-abort', '--failed', '3', '--total', '4', '--wave-dir', tmp]);
  assert(r.code === 1, 'abort: 3/4 (75%) > 50%');
  assert(r.stdout.includes('ABORT'), 'output says ABORT');
}

{
  // Small-batch rule: ≥2 failures in batch of ≤3
  const tmp = tmpDir();
  const r = runHarness(['batch-abort', '--failed', '2', '--total', '3', '--wave-dir', tmp]);
  assert(r.code === 1, 'abort: small-batch rule (2/3)');
  assert(r.stdout.includes('small-batch'), 'output cites small-batch rule');
}

{
  // Edge: 1/3 — does NOT trigger small-batch rule
  const tmp = tmpDir();
  const r = runHarness(['batch-abort', '--failed', '1', '--total', '3', '--wave-dir', tmp]);
  assert(r.code === 0, 'continue: 1/3 — neither rule fires');
}

// ── 5. calibrate (CLI) ────────────────────────────────────────────────────────

console.log('\n5. calibrate — tuple emit and confidence normalization');

{
  const tmp = tmpDir();
  runHarness(['calibrate',
    '--item', 'widget-impl',
    '--agent', 'implementer',
    '--confidence', 'high',
    '--verify-pass', 'true',
    '--has-confidence',
    '--wave-dir', tmp,
  ]);
  const outPath = path.join(tmp, 'cascade', 'widget-impl.jsonl');
  assert(fs.existsSync(outPath), 'cascade/<item>.jsonl created');
  const tuple = JSON.parse(fs.readFileSync(outPath, 'utf8').trim());
  assert(tuple.confidence === 'high', 'confidence=high');
  assert(tuple.verify_pass === true, 'verify_pass=true');
  assert(tuple.compliance === true, 'compliance=true when --has-confidence');
}

{
  // Unknown confidence → graceful degradation to 'medium'
  const tmp = tmpDir();
  runHarness(['calibrate',
    '--item', 'x',
    '--agent', 'scaffolder',
    '--confidence', 'unknown-value',
    '--verify-pass', 'null',
    '--wave-dir', tmp,
  ]);
  const tuple = JSON.parse(fs.readFileSync(path.join(tmp, 'cascade', 'x.jsonl'), 'utf8').trim());
  assert(tuple.confidence === 'medium', 'unknown confidence degrades to medium');
  assert(tuple.verify_pass === null, 'verify_pass=null');
  assert(tuple.compliance === false, 'compliance=false when no --has-confidence');
}

// ── 6. inject-contract (CLI) ──────────────────────────────────────────────────

console.log('\n6. inject-contract — prepend and idempotency');

{
  const tmp      = tmpDir();
  const digestsD = path.join(tmp, 'digests');
  fs.mkdirSync(digestsD);

  // Write a dummy digest and a dummy contract
  const contractFile = path.join(tmp, 'worker-contract.md');
  fs.writeFileSync(contractFile, '## Shared contract\nRubric goes here.\n');
  fs.writeFileSync(path.join(digestsD, 'implementer-item1.md'), '# Digest\nTask details.\n');

  runHarness(['inject-contract',
    '--contract', contractFile,
    '--digests-dir', digestsD,
  ]);

  const injected = fs.readFileSync(path.join(digestsD, 'implementer-item1.md'), 'utf8');
  assert(injected.includes('## Worker contract'), 'contract section injected');
  assert(injected.includes('Rubric goes here'), 'contract content present');
  assert(injected.startsWith('# Digest'), 'original digest content preserved at top');

  // Idempotency: run again, should not double-inject
  runHarness(['inject-contract', '--contract', contractFile, '--digests-dir', digestsD]);
  const afterSecond = fs.readFileSync(path.join(digestsD, 'implementer-item1.md'), 'utf8');
  const count = (afterSecond.match(/## Worker contract/g) || []).length;
  assert(count === 1, 'inject-contract is idempotent (section appears exactly once)');
}

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\nc-thru-plan-harness tests\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
