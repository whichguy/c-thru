#!/usr/bin/env node
/**
 * c-thru-plan-harness.test.js — Unit tests for tools/c-thru-plan-harness.js
 *
 * Covers:
 *   - parseCurrentMd: item parsing, status, attributes
 *   - parseWaveMd: frontmatter, needs field, marker alphabet, batch field
 *   - writeWaveMd / batch round-trip: depends_on → needs rename, computed fields
 *   - Dual-vocabulary boundary: needs: in wave.md; depends_on: in current.md; never mixed
 *   - topoSort: ordering, cycle detection, simplest-first within tier
 *   - assignBatches: resource conflict, no-resource own-batch, parallel grouping
 *   - batch-abort threshold: 50% rule + small-batch rule
 *   - calibrate: confidence normalization, compliance flag
 *   - inject-contract: idempotency, content prepend
 *   - update-marker: state transitions (pending → complete/blocked/extend), produced: appended
 *   - targets: sorted unique paths, exit codes
 *   - Concurrent write rejection: update-marker lock contention
 *   - Cycle detection: batch exit 2
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

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

// ── Inline imports (mirrored from harness source) ──────────────────────────────
// NOTE: these must stay in sync with the implementations in tools/c-thru-plan-harness.js.
// Update both locations together when the parser logic changes.

function parseCurrentMd(content) {
  const items = new Map();
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const itemMatch = line.match(/^-\s+\[([x ])\]\s+([\w-]+)\s*:\s*(.*)/i);
    if (itemMatch) {
      const status = itemMatch[1].toLowerCase() === 'x' ? 'done' : 'pending';
      const id = itemMatch[2];
      const description = itemMatch[3].trim();
      const item = { id, description, status, depends_on: [], target_resources: [], agent: null };
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

const MARKER_TO_STATUS = { ' ': 'pending', '~': 'in_progress', 'x': 'complete', '!': 'blocked', '+': 'extend' };

function parseWaveMd(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) throw new Error('wave.md: missing YAML frontmatter');
  const fm = fmMatch[1];
  const waveIdM = fm.match(/^wave_id:\s*(\d+)/m);
  if (!waveIdM) throw new Error('wave.md: missing wave_id in frontmatter');
  const wave_id = parseInt(waveIdM[1], 10);
  const commitM = fm.match(/^commit_message:\s*"((?:[^"\\]|\\.)*)"/m);
  const commit_message = commitM
    ? commitM[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    : '';
  const contractM = fm.match(/^contract_version:\s*(\d+)/m);
  const contract_version = contractM ? parseInt(contractM[1], 10) : 3;
  const batchesM = fm.match(/^batches:\s*(\[.+\])\s*(?:#.*)?$/m);
  let batches = [];
  if (batchesM) { try { batches = JSON.parse(batchesM[1]); } catch (_) {} }
  const items = new Map();
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const itemM = line.match(/^-\s+\[([ x~!+])\]\s+([\w-]+)\s*:\s*(.*)/i);
    if (itemM) {
      const status = MARKER_TO_STATUS[itemM[1].toLowerCase()] || 'pending';
      const id = itemM[2];
      const description = itemM[3].trim();
      const item = {
        id, description, status, agent: null, needs: [], batch: null,
        target_resources: [], escalation_policy: 'local', escalation_policy_source: 'harness-batch',
        escalation_depth: 0, escalation_log: [], produced: [], wave_num: null,
      };
      i++;
      while (i < lines.length && (lines[i].match(/^\s+\S/) || lines[i].trim() === '')) {
        const attr = lines[i].trim().replace(/\s*#.*$/, '').trim();
        const needsM   = attr.match(/^needs:\s*\[([^\]]*)\]/);
        const resM     = attr.match(/^target_resources:\s*\[([^\]]*)\]/);
        const agM      = attr.match(/^agent:\s*(\S+)/);
        const batchM   = attr.match(/^batch:\s*(\d+)/);
        const ePolM    = attr.match(/^escalation_policy:\s*(\S+)/);
        const eSrcM    = attr.match(/^escalation_policy_source:\s*(\S+)/);
        const eDepM    = attr.match(/^escalation_depth:\s*(\d+)/);
        const eLogM    = attr.match(/^escalation_log:\s*(\[.*\])/);
        const prodM    = attr.match(/^produced:\s*\[([^\]]*)\]/);
        const waveNM   = attr.match(/^wave:\s*(\d+)/);
        if (needsM)  item.needs = needsM[1].split(',').map(s => s.trim()).filter(Boolean);
        else if (resM) item.target_resources = resM[1].split(',').map(s => s.trim()).filter(Boolean);
        else if (agM)  item.agent = agM[1];
        else if (batchM) item.batch = parseInt(batchM[1], 10);
        else if (ePolM)  item.escalation_policy = ePolM[1];
        else if (eSrcM)  item.escalation_policy_source = eSrcM[1];
        else if (eDepM)  item.escalation_depth = parseInt(eDepM[1], 10);
        else if (eLogM)  { try { item.escalation_log = JSON.parse(eLogM[1]); } catch (_) {} }
        else if (prodM)  item.produced = prodM[1].split(',').map(s => s.trim()).filter(Boolean);
        else if (waveNM) item.wave_num = parseInt(waveNM[1], 10);
        i++;
      }
      items.set(id, item);
    } else { i++; }
  }
  return { wave_id, commit_message, contract_version, batches, items };
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

// Sample current.md (uses depends_on — authoritative field for current.md)
const sampleCurrentMd = `
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

// ── 1. parseCurrentMd ─────────────────────────────────────────────────────────

console.log('\n1. parseCurrentMd — item parsing');

const parsed = parseCurrentMd(sampleCurrentMd);
assert(parsed.size === 4, 'parses 4 items');
assert(parsed.get('item-1').status === 'pending', 'item-1 status=pending');
assert(parsed.get('item-2').status === 'done', 'item-2 status=done');
assert(deepEq(parsed.get('item-1').depends_on, []), 'item-1 depends_on=[]');
assert(deepEq(parsed.get('item-3').depends_on, ['item-2']), 'item-3 depends_on=[item-2]');
assert(deepEq(parsed.get('item-1').target_resources, ['src/widget.js', 'src/index.js']), 'item-1 target_resources correct');
assert(parsed.get('item-1').agent === 'scaffolder', 'item-1 agent=scaffolder');
assert(deepEq(parsed.get('item-4').target_resources, []), 'item-4 target_resources=[]');
assert(parsed.get('item-1').description === 'create widget skeleton', 'item-1 description captured');

// Dual-vocabulary boundary: current.md must NOT contain needs:
assert(!sampleCurrentMd.includes('\n  needs:'), 'current.md uses depends_on (not needs)');

// ── 2. parseWaveMd ────────────────────────────────────────────────────────────

console.log('\n2. parseWaveMd — frontmatter + needs field + marker alphabet');

const sampleWaveMd = `---
wave_id:          2
commit_message:   "add auth middleware and route guards"
contract_version: 3
batches:          [["item-1","item-3"],["item-5"]]   # computed by harness — do not edit by hand
---

# Wave 002 — add auth middleware and route guards

## Tasks

- [ ] item-1: Add auth middleware
  agent: implementer
  needs: []               # what must be [x] before this dispatches (authoritative)
  batch: 1                # computed — do not edit
  target_resources: [src/middleware/auth.ts, test/auth.test.js]
  escalation_policy: local
  escalation_policy_source: harness-batch
  escalation_depth: 0
  escalation_log: []

- [ ] item-3: Scaffold route config
  agent: scaffolder
  needs: []
  batch: 1                # computed — do not edit
  target_resources: [src/routes/config.ts]
  escalation_policy: local
  escalation_policy_source: harness-batch
  escalation_depth: 0
  escalation_log: []

- [~] item-5: Wire auth into router
  agent: integrator
  needs: [item-1, item-3]
  batch: 2                # computed — do not edit
  target_resources: [src/router/index.ts]
  escalation_policy: pre-escalate
  escalation_policy_source: step4b
  escalation_depth: 0
  escalation_log: []
`;

const waveData = parseWaveMd(sampleWaveMd);
assert(waveData.wave_id === 2, 'wave_id = 2');
assert(waveData.commit_message === 'add auth middleware and route guards', 'commit_message parsed');
assert(waveData.contract_version === 3, 'contract_version = 3');
assert(deepEq(waveData.batches, [['item-1', 'item-3'], ['item-5']]), 'batches frontmatter parsed');
assert(waveData.items.size === 3, '3 items parsed');
assert(waveData.items.get('item-1').status === 'pending', 'item-1 pending ([ ])');
assert(waveData.items.get('item-5').status === 'in_progress', 'item-5 in_progress ([~])');
assert(deepEq(waveData.items.get('item-1').needs, []), 'item-1 needs=[]');
assert(deepEq(waveData.items.get('item-5').needs, ['item-1', 'item-3']), 'item-5 needs=[item-1, item-3]');
assert(waveData.items.get('item-1').batch === 1, 'item-1 batch=1');
assert(waveData.items.get('item-5').batch === 2, 'item-5 batch=2');
assert(waveData.items.get('item-5').escalation_policy === 'pre-escalate', 'item-5 escalation_policy=pre-escalate');
assert(waveData.items.get('item-5').escalation_policy_source === 'step4b', 'item-5 escalation_policy_source=step4b');
assert(waveData.items.get('item-1').description === 'Add auth middleware', 'item-1 description parsed');

// Full marker alphabet
const markerFixtures = [
  ['[ ]', 'pending', ' '],
  ['[~]', 'in_progress', '~'],
  ['[x]', 'complete', 'x'],
  ['[!]', 'blocked', '!'],
  ['[+]', 'extend', '+'],
];
for (const [marker, expectedStatus, char] of markerFixtures) {
  const fixture = `---\nwave_id: 1\ncommit_message: "t"\ncontract_version: 3\nbatches: [["x"]]\n---\n\n- ${marker} x: desc\n  agent: implementer\n  needs: []\n  batch: 1\n  target_resources: []\n  escalation_policy: local\n  escalation_policy_source: harness-batch\n  escalation_depth: 0\n  escalation_log: []\n`;
  const d = parseWaveMd(fixture);
  assert(d.items.get('x').status === expectedStatus, `marker ${marker} → status=${expectedStatus}`);
}

// Uppercase [X] must parse as 'complete' (not silently degrade to 'pending')
{
  const fixture = `---\nwave_id: 1\ncommit_message: "t"\ncontract_version: 3\nbatches: [["x"]]\n---\n\n- [X] x: desc\n  agent: implementer\n  needs: []\n  batch: 1\n  target_resources: []\n  escalation_policy: local\n  escalation_policy_source: harness-batch\n  escalation_depth: 0\n  escalation_log: []\n`;
  const d = parseWaveMd(fixture);
  assert(d.items.get('x').status === 'complete', 'uppercase [X] normalizes to complete (not pending)');
}

// wave.md must NOT contain depends_on:
assert(!sampleWaveMd.includes('\n  depends_on:'), 'wave.md uses needs (not depends_on)');

// ── 3. batch CLI — wave.md output + field rename fidelity ─────────────────────

console.log('\n3. batch CLI — wave.md output, depends_on→needs rename, frontmatter consistency');

{
  const tmp  = tmpDir();
  const cMd  = path.join(tmp, 'current.md');
  const wMd  = path.join(tmp, 'wave.md');
  fs.writeFileSync(cMd, sampleCurrentMd);

  const r = runHarness(['batch',
    '--current-md', cMd,
    '--items', 'item-1,item-3',
    '--wave-id', '1',
    '--commit-msg', 'scaffold widget',
    '--output', wMd,
  ]);
  assert(r.code === 0, 'batch exits 0');
  assert(fs.existsSync(wMd), 'wave.md written');

  const content = fs.readFileSync(wMd, 'utf8');

  // Dual-vocabulary: wave.md must use needs:, not depends_on:
  assert(!content.includes('\n  depends_on:'), 'wave.md does not contain depends_on: (field rename applied)');
  assert(content.includes('\n  needs:'), 'wave.md contains needs: (renamed from depends_on)');

  // Parse round-trip
  const wd = parseWaveMd(content);
  assert(wd.wave_id === 1, 'wave_id round-trips');
  assert(wd.commit_message === 'scaffold widget', 'commit_message round-trips');
  assert(wd.contract_version === 3, 'contract_version=3 written');
  assert(wd.items.has('item-1'), 'item-1 present');
  assert(wd.items.has('item-3'), 'item-3 present');
  assert(wd.items.get('item-1').status === 'pending', 'items start as pending');
  assert(wd.items.get('item-1').escalation_policy === 'local', 'escalation_policy default');
  assert(deepEq(wd.items.get('item-3').needs, ['item-2']), 'item-3 needs=[item-2] (from depends_on)');

  // Frontmatter batches: must match per-item batch annotations
  const batchesFlat = wd.batches.flat();
  for (const [id, item] of wd.items) {
    const batchIdx = wd.batches.findIndex(b => b.includes(id));
    assert(batchIdx !== -1, `${id} appears in frontmatter batches`);
    assert(item.batch === batchIdx + 1, `${id} per-item batch: matches frontmatter position`);
  }
}

// ── 4. Computed field integrity (caller-provided batch: overwritten on write) ──

console.log('\n4. Computed field integrity — harness overwrites stale batch: values');

{
  const tmp = tmpDir();
  const cMd = path.join(tmp, 'current.md');
  const wMd = path.join(tmp, 'wave.md');
  fs.writeFileSync(cMd, sampleCurrentMd);

  runHarness(['batch',
    '--current-md', cMd,
    '--items', 'item-1',
    '--wave-id', '5',
    '--commit-msg', 'test',
    '--output', wMd,
  ]);

  const wd = parseWaveMd(fs.readFileSync(wMd, 'utf8'));
  // item-1 has no deps → must be in batch 1 regardless of any hand-edit
  assert(wd.items.get('item-1').batch === 1, 'item-1 computed batch=1 (dep-graph driven)');
}

// ── 5. topoSort ───────────────────────────────────────────────────────────────

console.log('\n5. topoSort — ordering and cycle detection');

{
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
  const specsSimple = new Map([
    ['A', { depends_on: [], target_resources: ['f1'],      agent: null }],
    ['B', { depends_on: [], target_resources: ['f2','f3'], agent: null }],
  ]);
  const sorted = topoSort(['A', 'B'], specsSimple);
  assert(sorted[0] === 'A', 'simplest-first: fewer resources comes first');
}

{
  const specsCycle = new Map([
    ['X', { depends_on: ['Y'], target_resources: [], agent: null }],
    ['Y', { depends_on: ['X'], target_resources: [], agent: null }],
  ]);
  let threw = false;
  try { topoSort(['X', 'Y'], specsCycle); } catch { threw = true; }
  assert(threw, 'throws on cycle');
}

// ── 6. assignBatches ─────────────────────────────────────────────────────────

console.log('\n6. assignBatches — resource conflict and parallel grouping');

{
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
  const specs = new Map([
    ['A', { depends_on: [], target_resources: ['shared.js'], agent: null }],
    ['B', { depends_on: [], target_resources: ['shared.js'], agent: null }],
  ]);
  const batches = assignBatches(['A', 'B'], specs);
  assert(batches.length === 2, 'overlapping resources → 2 batches');
}

{
  const specs = new Map([
    ['A', { depends_on: [], target_resources: [],       agent: null }],
    ['B', { depends_on: [], target_resources: ['b.js'], agent: null }],
  ]);
  const batches = assignBatches(['A', 'B'], specs);
  assert(batches.find(b => b.items.includes('A')).parallel === false, 'no-resource item has parallel=false');
  assert(batches.length === 2, 'no-resource item gets own batch');
}

{
  const specs = new Map([
    ['A', { depends_on: [],    target_resources: ['a.js'], agent: null }],
    ['B', { depends_on: ['A'], target_resources: ['b.js'], agent: null }],
  ]);
  const batches = assignBatches(['A', 'B'], specs);
  assert(batches.length === 2, 'dep relationship → separate batches');
  assert(batches[0].items[0] === 'A', 'A first (no deps)');
}

// batch 0 items must all have empty needs (or deps only to completed items)
{
  const tmp = tmpDir();
  const cMd = path.join(tmp, 'current.md');
  const wMd = path.join(tmp, 'wave.md');
  fs.writeFileSync(cMd, sampleCurrentMd);
  runHarness(['batch',
    '--current-md', cMd, '--items', 'item-1,item-3',
    '--wave-id', '1', '--commit-msg', 'test', '--output', wMd,
  ]);
  const wd = parseWaveMd(fs.readFileSync(wMd, 'utf8'));
  const firstBatchIds = wd.batches[0] || [];
  for (const id of firstBatchIds) {
    const item = wd.items.get(id);
    // needs must be empty or reference already-completed items (item-2 is done in fixture)
    const unresolvedNeeds = (item.needs || []).filter(n => {
      const dep = wd.items.get(n);
      return dep && dep.status !== 'complete';
    });
    assert(unresolvedNeeds.length === 0, `batch-1 item ${id}: no unresolved needs`);
  }
}

// ── 7. update-marker — state transitions ──────────────────────────────────────

console.log('\n7. update-marker — [~] → [x] with produced: appended');

{
  const tmp = tmpDir();
  const cMd = path.join(tmp, 'current.md');
  const wMd = path.join(tmp, 'wave.md');
  fs.writeFileSync(cMd, sampleCurrentMd);

  runHarness(['batch',
    '--current-md', cMd, '--items', 'item-1',
    '--wave-id', '1', '--commit-msg', 'scaffold', '--output', wMd,
  ]);

  // Mark in_progress
  let r = runHarness(['update-marker', '--wave-md', wMd, '--item', 'item-1', '--status', '~']);
  assert(r.code === 0, 'update-marker: pending → in_progress (exit 0)');
  let wd = parseWaveMd(fs.readFileSync(wMd, 'utf8'));
  assert(wd.items.get('item-1').status === 'in_progress', 'item-1 now in_progress');

  // Mark complete with produced paths
  r = runHarness(['update-marker', '--wave-md', wMd, '--item', 'item-1', '--status', 'x',
    '--produced', 'src/widget.js,src/index.js', '--wave', '1']);
  assert(r.code === 0, 'update-marker: in_progress → complete (exit 0)');
  wd = parseWaveMd(fs.readFileSync(wMd, 'utf8'));
  assert(wd.items.get('item-1').status === 'complete', 'item-1 now complete');
  assert(deepEq(wd.items.get('item-1').produced, ['src/widget.js', 'src/index.js']), 'produced: appended');
  assert(wd.items.get('item-1').wave_num === 1, 'wave: field appended');
}

// blocked marker
{
  const tmp = tmpDir();
  const cMd = path.join(tmp, 'current.md');
  const wMd = path.join(tmp, 'wave.md');
  fs.writeFileSync(cMd, sampleCurrentMd);
  runHarness(['batch', '--current-md', cMd, '--items', 'item-1', '--wave-id', '1', '--commit-msg', 't', '--output', wMd]);
  const r = runHarness(['update-marker', '--wave-md', wMd, '--item', 'item-1', '--status', '!']);
  assert(r.code === 0, 'update-marker: → blocked (exit 0)');
  const wd = parseWaveMd(fs.readFileSync(wMd, 'utf8'));
  assert(wd.items.get('item-1').status === 'blocked', 'item-1 now blocked');
}

// extend marker
{
  const tmp = tmpDir();
  const cMd = path.join(tmp, 'current.md');
  const wMd = path.join(tmp, 'wave.md');
  fs.writeFileSync(cMd, sampleCurrentMd);
  runHarness(['batch', '--current-md', cMd, '--items', 'item-1', '--wave-id', '1', '--commit-msg', 't', '--output', wMd]);
  const r = runHarness(['update-marker', '--wave-md', wMd, '--item', 'item-1', '--status', '+']);
  assert(r.code === 0, 'update-marker: → extend (exit 0)');
  const wd = parseWaveMd(fs.readFileSync(wMd, 'utf8'));
  assert(wd.items.get('item-1').status === 'extend', 'item-1 now extend');
}

// escalation policy update via update-marker
{
  const tmp = tmpDir();
  const cMd = path.join(tmp, 'current.md');
  const wMd = path.join(tmp, 'wave.md');
  fs.writeFileSync(cMd, sampleCurrentMd);
  runHarness(['batch', '--current-md', cMd, '--items', 'item-1', '--wave-id', '1', '--commit-msg', 't', '--output', wMd]);
  runHarness(['update-marker', '--wave-md', wMd, '--item', 'item-1', '--status', '~',
    '--escal-policy', 'pre-escalate', '--escal-policy-source', 'step4b']);
  const wd = parseWaveMd(fs.readFileSync(wMd, 'utf8'));
  assert(wd.items.get('item-1').escalation_policy === 'pre-escalate', 'escalation_policy updated');
  assert(wd.items.get('item-1').escalation_policy_source === 'step4b', 'escalation_policy_source updated');
}

// escalation_log append via --escal-log-append
{
  const tmp = tmpDir();
  const cMd = path.join(tmp, 'current.md');
  const wMd = path.join(tmp, 'wave.md');
  fs.writeFileSync(cMd, sampleCurrentMd);
  runHarness(['batch', '--current-md', cMd, '--items', 'item-1', '--wave-id', '1', '--commit-msg', 't', '--output', wMd]);

  const entry1 = { agent: 'implementer', tier: 'deep-coder', attempted: true, recusal_reason: 'no pattern', partial_output: null };
  runHarness(['update-marker', '--wave-md', wMd, '--item', 'item-1', '--status', '~',
    '--escal-log-append', JSON.stringify(entry1), '--escal-depth', '1']);
  let wd = parseWaveMd(fs.readFileSync(wMd, 'utf8'));
  assert(wd.items.get('item-1').escalation_log.length === 1, 'first escal-log-append: 1 entry');
  assert(wd.items.get('item-1').escalation_log[0].agent === 'implementer', 'log entry agent correct');
  assert(wd.items.get('item-1').escalation_depth === 1, 'escalation_depth updated to 1');

  const entry2 = { agent: 'implementer-cloud', tier: 'deep-coder-cloud', attempted: true, recusal_reason: 'judge sentinel', partial_output: null };
  runHarness(['update-marker', '--wave-md', wMd, '--item', 'item-1', '--status', '!',
    '--escal-log-append', JSON.stringify(entry2), '--escal-depth', '2']);
  wd = parseWaveMd(fs.readFileSync(wMd, 'utf8'));
  assert(wd.items.get('item-1').escalation_log.length === 2, 'second escal-log-append: 2 entries');
  assert(wd.items.get('item-1').escalation_log[1].agent === 'implementer-cloud', 'second log entry agent correct');
  assert(wd.items.get('item-1').status === 'blocked', 'status updated to blocked');
}

// ── 8. update-marker — concurrent write rejection ─────────────────────────────

console.log('\n8. update-marker — concurrent write rejection (lock)');

{
  const tmp = tmpDir();
  const cMd = path.join(tmp, 'current.md');
  const wMd = path.join(tmp, 'wave.md');
  fs.writeFileSync(cMd, sampleCurrentMd);
  runHarness(['batch', '--current-md', cMd, '--items', 'item-1', '--wave-id', '1', '--commit-msg', 't', '--output', wMd]);

  // Simulate concurrent caller: create the lock file manually
  const lockPath = wMd + '.lock';
  const lockFd = fs.openSync(lockPath, 'wx');
  try {
    const r = runHarness(['update-marker', '--wave-md', wMd, '--item', 'item-1', '--status', 'x']);
    assert(r.code === 1, 'update-marker exits 1 when lock held');
    assert(r.stderr.includes('locked'), 'stderr mentions lock');
  } finally {
    fs.closeSync(lockFd);
    try { fs.unlinkSync(lockPath); } catch (_) {}
  }
}

// Lock cleanup on error: item not found — lock must be released so next call succeeds
{
  const tmp = tmpDir();
  const cMd = path.join(tmp, 'current.md');
  const wMd = path.join(tmp, 'wave.md');
  fs.writeFileSync(cMd, sampleCurrentMd);
  runHarness(['batch', '--current-md', cMd, '--items', 'item-1', '--wave-id', '1', '--commit-msg', 't', '--output', wMd]);

  // Request a non-existent item — should error but must release the lock
  const r1 = runHarness(['update-marker', '--wave-md', wMd, '--item', 'no-such-item', '--status', 'x']);
  assert(r1.code === 1, 'update-marker exits 1 on missing item');

  // Lock must be gone — next call must not see stale lock
  const lockPath = wMd + '.lock';
  assert(!fs.existsSync(lockPath), 'lock file removed after error');

  // Verify the next update-marker succeeds (would hang/fail if lock not released)
  const r2 = runHarness(['update-marker', '--wave-md', wMd, '--item', 'item-1', '--status', 'x']);
  assert(r2.code === 0, 'subsequent update-marker succeeds after error cleanup');
}

// ── 9. targets subcommand ─────────────────────────────────────────────────────

console.log('\n9. targets — sorted unique paths, exit codes');

{
  const tmp = tmpDir();
  const cMd = path.join(tmp, 'current.md');
  const wMd = path.join(tmp, 'wave.md');
  fs.writeFileSync(cMd, sampleCurrentMd);
  runHarness(['batch', '--current-md', cMd, '--items', 'item-1,item-3', '--wave-id', '1', '--commit-msg', 't', '--output', wMd]);

  const r = runHarness(['targets', '--wave-md', wMd]);
  assert(r.code === 0, 'targets exits 0 on valid wave.md');
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  // item-1: src/widget.js, src/index.js; item-3: test/widget.test.js
  assert(lines.length === 3, 'targets emits 3 unique paths');
  assert(JSON.stringify(lines) === JSON.stringify([...lines].sort()), 'targets output is sorted');
  assert(!lines.includes(''), 'no empty path lines');
}

{
  // Exit 1 on missing file
  const r = runHarness(['targets', '--wave-md', '/nonexistent/wave.md']);
  assert(r.code === 1, 'targets exits 1 on missing wave.md');
}

{
  // Exit 1 on malformed wave.md (no frontmatter)
  const tmp = tmpDir();
  const bad = path.join(tmp, 'wave.md');
  fs.writeFileSync(bad, '# No frontmatter here\n- [ ] item-1: desc\n');
  const r = runHarness(['targets', '--wave-md', bad]);
  assert(r.code === 1, 'targets exits 1 on malformed wave.md');
}

// ── 10. Cycle detection (batch exit 2) ────────────────────────────────────────

console.log('\n10. Cycle detection — batch exit 2');

{
  const tmp = tmpDir();
  const cycleMd = `## Items\n- [ ] cx: task cx\n  depends_on: [cy]\n  target_resources: []\n  agent: implementer\n- [ ] cy: task cy\n  depends_on: [cx]\n  target_resources: []\n  agent: implementer\n`;
  const cMd = path.join(tmp, 'current.md');
  const wMd = path.join(tmp, 'wave.md');
  fs.writeFileSync(cMd, cycleMd);
  const r = runHarness(['batch', '--current-md', cMd, '--items', 'cx,cy', '--wave-id', '1', '--commit-msg', 'cycle', '--output', wMd]);
  assert(r.code === 2, 'batch exits 2 on dependency cycle');
  const out = JSON.parse(r.stdout.trim());
  assert(out.error === 'cycle', 'stdout JSON has error=cycle');
}

// ── 11. batch-abort threshold ─────────────────────────────────────────────────

console.log('\n11. batch-abort — threshold and small-batch rules');

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
  const tmp = tmpDir();
  const r = runHarness(['batch-abort', '--failed', '2', '--total', '3', '--wave-dir', tmp]);
  assert(r.code === 1, 'abort: small-batch rule (2/3)');
  assert(r.stdout.includes('small-batch'), 'output cites small-batch rule');
}

{
  const tmp = tmpDir();
  const r = runHarness(['batch-abort', '--failed', '1', '--total', '3', '--wave-dir', tmp]);
  assert(r.code === 0, 'continue: 1/3 — neither rule fires');
}

// ── 12. calibrate ─────────────────────────────────────────────────────────────

console.log('\n12. calibrate — tuple emit and confidence normalization');

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

// ── 13. inject-contract ───────────────────────────────────────────────────────

console.log('\n13. inject-contract — prepend and idempotency');

{
  const tmp      = tmpDir();
  const digestsD = path.join(tmp, 'digests');
  fs.mkdirSync(digestsD);

  const contractFile = path.join(tmp, 'worker-contract.md');
  fs.writeFileSync(contractFile, '## Shared contract\nRubric goes here.\n');
  fs.writeFileSync(path.join(digestsD, 'implementer-item1.md'), '# Digest\nTask details.\n');

  runHarness(['inject-contract', '--contract', contractFile, '--digests-dir', digestsD]);

  const injected = fs.readFileSync(path.join(digestsD, 'implementer-item1.md'), 'utf8');
  assert(injected.includes('## Worker contract'), 'contract section injected');
  assert(injected.includes('Rubric goes here'), 'contract content present');
  assert(injected.startsWith('# Digest'), 'original digest content preserved at top');

  // Idempotency
  runHarness(['inject-contract', '--contract', contractFile, '--digests-dir', digestsD]);
  const afterSecond = fs.readFileSync(path.join(digestsD, 'implementer-item1.md'), 'utf8');
  const count = (afterSecond.match(/## Worker contract/g) || []).length;
  assert(count === 1, 'inject-contract is idempotent (section appears exactly once)');
}

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\nc-thru-plan-harness tests\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
