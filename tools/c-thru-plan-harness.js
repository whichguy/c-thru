#!/usr/bin/env node
/**
 * c-thru-plan-harness.js — Deterministic wave-lifecycle helpers.
 *
 * Responsibilities (7 subcommands):
 *   batch           Topo-sort READY_ITEMS + resource-conflict batching → wave.md
 *                   Migrated from: agents/plan-orchestrator.md Step 3
 *   batch-abort     Evaluate batch-abort threshold (>50% failed, or ≥2 in batch of ≤3)
 *                   Migrated from: agents/plan-orchestrator.md Batch-abort threshold section
 *   calibrate       Emit per-item calibration tuple → cascade/<item>.jsonl
 *                   Migrated from: agents/plan-orchestrator.md Step 6b
 *   concat          Cat findings/*.jsonl → findings.jsonl; outputs/*.md → artifact.md
 *                   Migrated from: agents/plan-orchestrator.md Step 7
 *   inject-contract Prepend shared/_worker-contract.md to each digest file
 *                   Enables: shared/worker-contract.md → B1 drift elimination
 *   update-marker   Read-modify-write item checkbox state in wave.md (x|~|!|+) with file lock
 *                   Called by orchestrator only — workers never write wave.md directly
 *   targets         Emit sorted unique target_resources paths from wave.md; exit 1 on parse error
 *
 * STATUS/CONFIDENCE contract: docs/agent-architecture.md §12.1
 * Source agent: agents/plan-orchestrator.md
 * No external dependencies — Node.js stdlib only.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Argument helpers ───────────────────────────────────────────────────────────

function arg(args, flag, required) {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    if (required) { die(`missing required flag: ${flag}`); }
    return null;
  }
  const val = args[idx + 1];
  if (val === undefined || val.startsWith('--')) { die(`flag ${flag} requires a value`); }
  return val;
}

function flag(args, f) { return args.includes(f); }
function die(msg) { process.stderr.write(`c-thru-plan-harness: ${msg}\n`); process.exit(1); }

// ── current.md parser ──────────────────────────────────────────────────────────

/**
 * @description Parse items from current.md into a Map.
 * Handles markdown list format: `- [ ] id: desc` with indented YAML-like attributes.
 * @param {string} content - full text of current.md
 * @returns {Map<string, {id:string, description:string, status:string, depends_on:string[], target_resources:string[], agent:string|null}>}
 */
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
      // Read indented attribute lines
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

// ── wave.md parser ─────────────────────────────────────────────────────────────

// Marker char → status name
const MARKER_TO_STATUS = { ' ': 'pending', '~': 'in_progress', 'x': 'complete', '!': 'blocked', '+': 'extend' };
// Status name → marker char
const STATUS_TO_MARKER = { pending: ' ', in_progress: '~', complete: 'x', blocked: '!', extend: '+' };

/**
 * @description Parse wave.md into a structured object.
 * Reads YAML frontmatter + checkbox item blocks. Field: needs (forward edges only;
 * no reverse edges stored — use findDependents() to derive on demand).
 * @param {string} content - full text of wave.md
 * @returns {{wave_id:number, commit_message:string, contract_version:number, batches:string[][], items:Map}}
 * @throws {Error} on missing frontmatter or missing wave_id
 */
function parseWaveMd(content) {
  // YAML frontmatter block
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

  // batches: [["id1","id2"],["id3"]]   # computed — greedy match to last ] on line
  const batchesM = fm.match(/^batches:\s*(\[.+\])\s*(?:#.*)?$/m);
  let batches = [];
  if (batchesM) {
    try { batches = JSON.parse(batchesM[1]); } catch (_) { batches = []; }
  }

  // Parse item blocks
  const items = new Map();
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Match: - [marker] item-id: description
    const itemM = line.match(/^-\s+\[([ x~!+])\]\s+([\w-]+)\s*:\s*(.*)/i);
    if (itemM) {
      const status = MARKER_TO_STATUS[itemM[1].toLowerCase()] || 'pending';
      const id = itemM[2];
      const description = itemM[3].trim();
      const item = {
        id, description, status,
        agent: null, needs: [], batch: null,
        target_resources: [],
        escalation_policy: 'local',
        escalation_policy_source: 'harness-batch',
        escalation_depth: 0,
        escalation_log: [],
        produced: [],
        wave_num: null,
      };
      i++;
      // Read indented attribute lines (strip inline comments before matching)
      while (i < lines.length && (lines[i].match(/^\s+\S/) || lines[i].trim() === '')) {
        const attr = lines[i].trim().replace(/\s*#.*$/, '').trim();
        const needsM    = attr.match(/^needs:\s*\[([^\]]*)\]/);
        const resM      = attr.match(/^target_resources:\s*\[([^\]]*)\]/);
        const agM       = attr.match(/^agent:\s*(\S+)/);
        const batchM    = attr.match(/^batch:\s*(\d+)/);
        const ePolM     = attr.match(/^escalation_policy:\s*(\S+)/);
        const eSrcM     = attr.match(/^escalation_policy_source:\s*(\S+)/);
        const eDepM     = attr.match(/^escalation_depth:\s*(\d+)/);
        const eLogM     = attr.match(/^escalation_log:\s*(\[.*\])/);
        const prodM     = attr.match(/^produced:\s*\[([^\]]*)\]/);
        const waveNumM  = attr.match(/^wave:\s*(\d+)/);
        if (needsM)   item.needs = needsM[1].split(',').map(s => s.trim()).filter(Boolean);
        else if (resM) item.target_resources = resM[1].split(',').map(s => s.trim()).filter(Boolean);
        else if (agM)  item.agent = agM[1];
        else if (batchM) item.batch = parseInt(batchM[1], 10);
        else if (ePolM)  item.escalation_policy = ePolM[1];
        else if (eSrcM)  item.escalation_policy_source = eSrcM[1];
        else if (eDepM)  item.escalation_depth = parseInt(eDepM[1], 10);
        else if (eLogM)  { try { item.escalation_log = JSON.parse(eLogM[1]); } catch (_) {} }
        else if (prodM)  item.produced = prodM[1].split(',').map(s => s.trim()).filter(Boolean);
        else if (waveNumM) item.wave_num = parseInt(waveNumM[1], 10);
        i++;
      }
      items.set(id, item);
    } else {
      i++;
    }
  }

  return { wave_id, commit_message, contract_version, batches, items };
}

// ── wave.md writer ─────────────────────────────────────────────────────────────

/**
 * @description Write wave.md atomically (tmp + rename).
 * Items are serialized in batch order. The `needs:` field carries forward edges
 * (translated from `depends_on:` in current.md). No reverse `dependents:` field
 * is written — use findDependents() to derive on demand.
 * `batch:` and frontmatter `batches:` are computed artifacts; labeled as such.
 * @param {{wave_id:number, commit_message:string, batches:string[][], items:Map<string,object>}} waveData
 * @param {string} outPath
 */
function writeWaveMd(waveData, outPath) {
  const { wave_id, commit_message, batches, items } = waveData;

  // Build item → batch number lookup
  const itemBatchNum = new Map();
  for (let bi = 0; bi < batches.length; bi++) {
    for (const id of batches[bi]) {
      itemBatchNum.set(id, bi + 1);
    }
  }

  // Escape commit_message for YAML double-quoted scalar
  const escapedMsg = commit_message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const waveNum = String(wave_id).padStart(3, '0');
  const batchesJson = JSON.stringify(batches);

  let out = '---\n';
  out += `wave_id:          ${wave_id}\n`;
  out += `commit_message:   "${escapedMsg}"\n`;
  out += `contract_version: 3\n`;
  out += `batches:          ${batchesJson}   # computed by harness — do not edit by hand\n`;
  out += '---\n\n';
  out += `# Wave ${waveNum} — ${commit_message}\n\n`;
  out += '## Tasks\n';

  // Render items in batch order, then any orphans
  const ordered = [...batches.flat()];
  const orphans = [...items.keys()].filter(id => !ordered.includes(id));

  for (const id of [...ordered, ...orphans]) {
    const item = items.get(id);
    if (!item) continue;

    const marker   = STATUS_TO_MARKER[item.status] || ' ';
    const needsStr = (item.needs || []).length ? `[${item.needs.join(', ')}]` : '[]';
    const resStr   = (item.target_resources || []).length ? `[${item.target_resources.join(', ')}]` : '[]';
    const batchNum = itemBatchNum.get(id) || '?';
    const desc     = item.description || id;
    const agent    = item.agent || 'implementer';
    const ePol     = item.escalation_policy || 'local';
    const eSrc     = item.escalation_policy_source || 'harness-batch';
    const eLogStr  = JSON.stringify(item.escalation_log || []);

    out += `\n- [${marker}] ${id}: ${desc}\n`;
    out += `  agent: ${agent}\n`;
    out += `  needs: ${needsStr}               # what must be [x] before this dispatches (authoritative)\n`;
    out += `  batch: ${batchNum}                # computed — do not edit\n`;
    out += `  target_resources: ${resStr}\n`;
    out += `  escalation_policy: ${ePol}\n`;
    out += `  escalation_policy_source: ${eSrc}\n`;
    out += `  escalation_depth: ${item.escalation_depth || 0}\n`;
    out += `  escalation_log: ${eLogStr}\n`;
    // produced: and wave: appended only when set (post-completion fields)
    if (item.produced && item.produced.length > 0) {
      out += `  produced: [${item.produced.join(', ')}]\n`;
    }
    if (item.wave_num !== null && item.wave_num !== undefined) {
      out += `  wave: ${item.wave_num}\n`;
    }
  }

  const tmp = outPath + '.tmp';
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, outPath);
}

// ── Reverse edge helper ────────────────────────────────────────────────────────

/**
 * @description Find all items that depend on itemId by scanning needs: fields.
 * O(N) where N = items in the wave — no reverse edges stored in wave.md.
 * @param {string} itemId
 * @param {Map<string, {needs:string[]}>} items - from parseWaveMd
 * @returns {string[]} IDs of items that have itemId in their needs list
 */
function findDependents(itemId, items) {
  const result = [];
  for (const [id, item] of items) {
    if ((item.needs || []).includes(itemId)) result.push(id);
  }
  return result;
}

// ── Legacy wave.json fallback (read-only) ──────────────────────────────────────

/**
 * @description Read legacy wave.json for in-flight v2 plans. Emits deprecation warning.
 * Translates depends_on → needs for orchestrator compatibility.
 * @param {string} waveJsonPath - path to wave.json (not wave.md)
 * @returns {{wave_id:number, commit_message:string, batches:string[][], items:Map}|null}
 */
function readWaveJson(waveJsonPath) {
  if (!fs.existsSync(waveJsonPath)) return null;
  process.stderr.write(
    `c-thru-plan-harness: DEPRECATION — reading legacy wave.json at ${waveJsonPath}` +
    ` (see pre-processor.log)\n`
  );
  try {
    const raw = JSON.parse(fs.readFileSync(waveJsonPath, 'utf8'));
    const batches = (raw.batches || []).map(b => (b.items || []).map(it => it.item));
    const items = new Map();
    for (const b of raw.batches || []) {
      for (const it of b.items || []) {
        items.set(it.item, {
          id: it.item,
          description: it.item,
          status: 'pending',
          agent: it.agent,
          needs: it.depends_on || [],   // translate depends_on → needs
          batch: null,
          target_resources: it.target_resources || [],
          escalation_policy: it.escalation_policy || 'local',
          escalation_policy_source: it.escalation_policy_source || 'harness-batch',
          escalation_depth: it.escalation_depth || 0,
          escalation_log: it.escalation_log || [],
          produced: [],
          wave_num: null,
        });
      }
    }
    return { wave_id: raw.wave_id, commit_message: raw.commit_message, batches, items };
  } catch (e) {
    process.stderr.write(`c-thru-plan-harness: failed to read legacy wave.json: ${e.message}\n`);
    return null;
  }
}

// ── Topo-sort (Kahn's algorithm) ───────────────────────────────────────────────

/**
 * @description Topological sort of items using Kahn's algorithm. Only edges between
 * items in readyItems are considered (deps outside the ready set are already done).
 * Within the same topological tier: fewest depends_on → smallest target_resources.
 * Migrated from plan-orchestrator.md Step 3 (items 1–2).
 * @param {string[]} readyItems - item IDs to sort
 * @param {Map<string, {depends_on:string[], target_resources:string[]}>} specs
 * @returns {string[]} topologically sorted IDs
 * @throws {Error} on cycle detection
 */
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

  // Simplest-first comparator within the same tier (plan-orchestrator Step 3 item 2)
  const simplestFirst = (a, b) => {
    const aSpec = specs.get(a) || {};
    const bSpec = specs.get(b) || {};
    const dA = (aSpec.depends_on || []).length;
    const dB = (bSpec.depends_on || []).length;
    if (dA !== dB) return dA - dB;
    return (aSpec.target_resources || []).length - (bSpec.target_resources || []).length;
  };

  const queue  = readyItems.filter(id => inDegree.get(id) === 0).sort(simplestFirst);
  const result = [];

  while (queue.length > 0) {
    const id = queue.shift();
    result.push(id);
    const nexts = (adj.get(id) || []).sort(simplestFirst);
    for (const next of nexts) {
      const deg = inDegree.get(next) - 1;
      inDegree.set(next, deg);
      if (deg === 0) {
        // Insert in simplest-first position
        let pos = queue.length;
        while (pos > 0 && simplestFirst(next, queue[pos - 1]) < 0) pos--;
        queue.splice(pos, 0, next);
      }
    }
  }

  if (result.length !== readyItems.length) {
    throw new Error('dependency cycle in READY_ITEMS — check driver validation');
  }
  return result;
}

/**
 * @description Assign topo-sorted items into parallel batches based on resource conflicts.
 * Non-overlapping target_resources → same batch. Overlapping or ancestor/descendant → new batch.
 * Items with no target_resources → own batch.
 * Migrated from plan-orchestrator.md Step 3 items 3–5.
 * @param {string[]} sorted - topologically sorted IDs
 * @param {Map<string, {depends_on:string[], target_resources:string[]}>} specs
 * @returns {{parallel:boolean, items:string[]}[]}
 */
function assignBatches(sorted, specs) {
  const batches = [];

  for (const id of sorted) {
    const spec      = specs.get(id) || {};
    const resources = new Set(spec.target_resources || []);

    if (resources.size === 0) {
      // Own batch per orchestrator rule (item 5)
      batches.push({ parallel: false, items: [id] });
      continue;
    }

    // Attempt to merge into last batch
    const last = batches[batches.length - 1];
    if (last && last.parallel !== false) {
      const depConflict = (spec.depends_on || []).some(dep => last.items.includes(dep));
      const resConflict = last.items.some(existId => {
        const er = specs.get(existId) || {};
        return (er.target_resources || []).some(r => resources.has(r));
      });
      if (!depConflict && !resConflict) {
        last.items.push(id);
        continue;
      }
    }

    batches.push({ parallel: true, items: [id] });
  }

  return batches;
}

// ── Subcommand: batch ──────────────────────────────────────────────────────────

/**
 * @description Produce wave.md from current.md + READY_ITEMS list.
 * Field rename: depends_on (current.md) → needs (wave.md). No reverse edges stored.
 * Writes atomically (tmp + rename). Exits non-zero on cycle.
 * @param {string[]} cliArgs - remaining CLI arguments after 'batch'
 */
function cmdBatch(cliArgs) {
  const currentMdPath = arg(cliArgs, '--current-md', true);
  const itemsList     = arg(cliArgs, '--items', true);
  const waveId        = parseInt(arg(cliArgs, '--wave-id', true), 10);
  const commitMsg     = arg(cliArgs, '--commit-msg', true);
  const outputPath    = arg(cliArgs, '--output', true);
  const escalPolicy   = arg(cliArgs, '--escal-policy') || 'local';

  const currentMd = fs.readFileSync(currentMdPath, 'utf8');
  const specs     = parseCurrentMd(currentMd);
  const readyIds  = itemsList.split(',').map(s => s.trim()).filter(Boolean);

  // Validate all requested IDs exist
  for (const id of readyIds) {
    if (!specs.has(id)) { die(`item '${id}' not found in ${currentMdPath}`); }
  }

  let sorted;
  try {
    sorted = topoSort(readyIds, specs);
  } catch (e) {
    process.stderr.write(`c-thru-plan-harness: ${e.message}\n`);
    process.stdout.write(JSON.stringify({
      error: 'cycle',
      STATUS: 'ERROR',
      SUMMARY: 'dependency cycle in READY_ITEMS — driver validation gap',
    }, null, 2) + '\n');
    process.exit(2);
  }

  const batchesRaw = assignBatches(sorted, specs);

  // Build batch groups (list of lists of IDs) for frontmatter
  const batchGroups = batchesRaw.map(b => b.items);

  // Build item data map (depends_on → needs translation happens here)
  const itemsMap = new Map();
  for (const b of batchesRaw) {
    for (const id of b.items) {
      const spec = specs.get(id) || {};
      itemsMap.set(id, {
        id,
        description: spec.description || id,
        status: 'pending',
        agent: spec.agent || 'implementer',
        needs: spec.depends_on || [],   // field rename: depends_on → needs
        target_resources: spec.target_resources || [],
        escalation_policy: escalPolicy,
        escalation_policy_source: 'harness-batch',
        escalation_depth: 0,
        escalation_log: [],
        produced: [],
        wave_num: null,
      });
    }
  }

  writeWaveMd({ wave_id: waveId, commit_message: commitMsg, batches: batchGroups, items: itemsMap }, outputPath);

  // Schema validation: re-parse to confirm round-trip fidelity
  const check = parseWaveMd(fs.readFileSync(outputPath, 'utf8'));
  if (!Number.isFinite(check.wave_id) || !check.commit_message || check.items.size === 0) {
    die('schema validation failed after write: wave_id, commit_message, or items missing');
  }

  process.stdout.write(`batch: wrote ${batchGroups.length} batch(es) for ${sorted.length} item(s) → ${outputPath}\n`);
}

// ── Subcommand: batch-abort ────────────────────────────────────────────────────

/**
 * @description Evaluate batch-abort threshold. Prints decision to stdout.
 * Exit 0 = continue. Exit 1 = abort.
 * Migrated from plan-orchestrator.md Batch-abort threshold section.
 * @param {string[]} cliArgs
 */
function cmdBatchAbort(cliArgs) {
  const failed = parseInt(arg(cliArgs, '--failed', true), 10);
  const total  = parseInt(arg(cliArgs, '--total',  true), 10);

  if (isNaN(failed) || isNaN(total) || total < 0 || failed < 0) {
    die('--failed and --total must be non-negative integers');
  }

  const waveDir = arg(cliArgs, '--wave-dir') || '.';

  // Small-batch rule: ≥2 failures in batch of ≤3 (plan-orchestrator Batch-abort section)
  const smallBatchAbort = total <= 3 && failed >= 2;
  // Standard threshold: >50%
  const thresholdAbort  = total > 0 && (failed / total) > 0.5;
  const abort           = smallBatchAbort || thresholdAbort;

  const reason = smallBatchAbort
    ? `small-batch rule (${failed}/${total} failed in batch of ≤3)`
    : thresholdAbort
      ? `threshold rule (${failed}/${total} = ${Math.round(100 * failed / total)}% > 50%)`
      : `within threshold (${failed}/${total})`;

  const logEntry = JSON.stringify({
    timestamp:   new Date().toISOString(),
    failed, total, abort, reason,
  }) + '\n';

  // Append to batch-abort.log if wave-dir provided
  const logPath = path.join(waveDir, 'batch-abort.log');
  try { fs.appendFileSync(logPath, logEntry); } catch (_) { /* best-effort */ }

  process.stdout.write(`batch-abort: ${abort ? 'ABORT' : 'CONTINUE'} — ${reason}\n`);
  process.exit(abort ? 1 : 0);
}

// ── Subcommand: calibrate ──────────────────────────────────────────────────────

/**
 * @description Emit one calibration tuple to wave_dir/cascade/<item>.jsonl.
 * See docs/agent-architecture.md §12.1 for CONFIDENCE contract.
 * Migrated from plan-orchestrator.md Step 6b.
 * @param {string[]} cliArgs
 */
function cmdCalibrate(cliArgs) {
  const item          = arg(cliArgs, '--item',           true);
  const agent         = arg(cliArgs, '--agent',          true);
  const confidence    = arg(cliArgs, '--confidence',     true);
  const verifyPassRaw = arg(cliArgs, '--verify-pass',    true);
  const hasConf       = flag(cliArgs, '--has-confidence');
  const waveDir       = arg(cliArgs, '--wave-dir',       true);

  const validConf = new Set(['high', 'medium', 'low']);
  const conf = validConf.has(confidence) ? confidence : 'medium'; // graceful degradation per §12.1

  let verifyPass;
  if (verifyPassRaw === 'null' || verifyPassRaw === 'none') verifyPass = null;
  else if (verifyPassRaw === 'true')  verifyPass = true;
  else if (verifyPassRaw === 'false') verifyPass = false;
  else verifyPass = null;

  const tuple = {
    item,
    agent,
    confidence:  conf,
    verify_pass: verifyPass,
    // compliance: true if CONFIDENCE was present in worker STATUS block (tracks rubric adoption)
    compliance:  hasConf,
  };

  const cascadeDir = path.join(waveDir, 'cascade');
  fs.mkdirSync(cascadeDir, { recursive: true });
  const outPath = path.join(cascadeDir, `${item}.jsonl`);
  fs.appendFileSync(outPath, JSON.stringify(tuple) + '\n', 'utf8');

  process.stdout.write(`calibrate: wrote tuple for ${item} (${agent}, ${conf}) → ${outPath}\n`);
}

// ── Subcommand: concat ─────────────────────────────────────────────────────────

/**
 * @description Concatenate findings/*.jsonl → findings.jsonl and outputs/*.md → artifact.md.
 * Migrated from plan-orchestrator.md Step 7.
 * @param {string[]} cliArgs
 */
function cmdConcat(cliArgs) {
  const waveDir = arg(cliArgs, '--wave-dir', true);

  const findingsDir = path.join(waveDir, 'findings');
  const outputsDir  = path.join(waveDir, 'outputs');

  // findings.jsonl
  let findingsLines = '';
  if (fs.existsSync(findingsDir)) {
    const jls = fs.readdirSync(findingsDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .map(f => path.join(findingsDir, f));
    for (const f of jls) {
      const content = fs.readFileSync(f, 'utf8');
      if (content.trim()) findingsLines += content + (content.endsWith('\n') ? '' : '\n');
    }
  }
  fs.writeFileSync(path.join(waveDir, 'findings.jsonl'), findingsLines, 'utf8');

  // artifact.md
  let artifact = '';
  if (fs.existsSync(outputsDir)) {
    const mds = fs.readdirSync(outputsDir)
      .filter(f => f.endsWith('.md') && !f.endsWith('.INDEX.md'))
      .sort()
      .map(f => path.join(outputsDir, f));
    for (const f of mds) {
      const content = fs.readFileSync(f, 'utf8');
      if (content.trim()) artifact += content + (content.endsWith('\n') ? '' : '\n');
    }
  }
  fs.writeFileSync(path.join(waveDir, 'artifact.md'), artifact, 'utf8');

  process.stdout.write(`concat: findings.jsonl (${findingsLines.split('\n').filter(Boolean).length} lines) + artifact.md (${artifact.split('\n').length} lines) → ${waveDir}\n`);
}

// ── Subcommand: inject-contract ────────────────────────────────────────────────

/**
 * @description Prepend shared/_worker-contract.md content to every digest file
 * in the given digests directory. Enables B1: workers drop inline boilerplate;
 * harness supplies it deterministically at dispatch time.
 * @param {string[]} cliArgs
 */
function cmdInjectContract(cliArgs) {
  const contractPath  = arg(cliArgs, '--contract',    true);
  const digestsDir    = arg(cliArgs, '--digests-dir', true);

  if (!fs.existsSync(contractPath)) { die(`contract file not found: ${contractPath}`); }
  if (!fs.existsSync(digestsDir))   { die(`digests directory not found: ${digestsDir}`); }

  const contractContent = fs.readFileSync(contractPath, 'utf8');
  const separator = '\n\n---\n\n';

  const digests = fs.readdirSync(digestsDir)
    .filter(f => f.endsWith('.md'))
    .sort();

  let injectedCount = 0;
  for (const file of digests) {
    const digestPath    = path.join(digestsDir, file);
    const digestContent = fs.readFileSync(digestPath, 'utf8');
    
    // Idempotent: skip if already injected
    if (digestContent.includes('### REQUIRED RESPONSE TEMPLATE')) continue;

    // Extract agent type from YAML frontmatter
    const agentMatch = digestContent.match(/^agent:\s*(\S+)/m);
    const agent = agentMatch ? agentMatch[1] : 'implementer';

    let template = '\n\n### REQUIRED RESPONSE TEMPLATE\n\n' +
                   '## Work completed\n' +
                   '[Briefly describe what you did here. If you discovered new patterns or invariants, add a `### Learnings` subsection below.]\n\n' +
                   '## Findings (jsonl)\n' +
                   '```jsonl\n' +
                   '{"class":"improvement","text":"[Required: what would make the next iteration easier?]","detail":"[optional prose]"}\n' +
                   '[Add other trivial|contextual|plan-material|crisis findings here]\n' +
                   '```\n\n' +
                   '## Output INDEX\n' +
                   '[List changed sections, e.g., src/main.js: 10-50]\n\n' +
                   'STATUS: [COMPLETE|PARTIAL|ERROR|RECUSE]\n';

    if (agent === 'discovery-advisor' || agent === 'explorer') {
      template += 'ANSWERED: [yes|no]\n' +
                  'GAPS: [number of remaining unknown areas]\n';
    } else if (agent === 'uplift-decider') {
      template = '\n\n### REQUIRED RESPONSE TEMPLATE\n\n' +
                 'STATUS: COMPLETE\n' +
                 'VERDICT: [accept|uplift|restart]\n' +
                 'CLOUD_CONFIDENCE: [high|medium|low]\n' +
                 'RATIONALE: [One sentence explaining why the local output is accepted or why escalation is needed]\n' +
                 'SUMMARY: [≤20 words summary]\n';
    } else {
      // Standard worker (implementer, test-writer, scaffolder, etc)
      template += 'CONFIDENCE: [high|medium|low]\n' +
                  'UNCERTAINTY_REASONS: [List rubric bullets if medium/low; omit if high]\n' +
                  'WROTE: [comma-separated paths from target_resources]\n' +
                  'INDEX: [output.INDEX.md path or none]\n' +
                  'FINDINGS: [findings.jsonl path or none]\n' +
                  'FINDING_CATS: {crisis:0,plan-material:0,contextual:0,trivial:0,augmentation:0,improvement:1}\n' +
                  'LINT_ITERATIONS: [number]\n';
    }

    if (agent !== 'uplift-decider') {
      template += 'SUMMARY: [≤20 words summary]\n\n' +
                  '**Note for RECUSE:** If you recuse, use `STATUS: RECUSE` and provide `RECUSAL_REASON: [reason]` and `ATTEMPTED: [yes|no]`. Omit WROTE, INDEX, and FINDINGS.\n';
    }

    const reminder = '\n\nIMPORTANT: You MUST complete the template above. Replace all `[...]` placeholders with actual content. Do not leave the brackets in your final response.';
    
    fs.writeFileSync(digestPath, digestContent + separator + contractContent + template + reminder, 'utf8');
    injectedCount++;
  }

  const skipped = digests.length - injectedCount;
  process.stdout.write(
    `inject-contract: injected into ${injectedCount}/${digests.length} digest(s)` +
    (skipped > 0 ? ` (${skipped} already had contract — skipped)` : '') +
    ` in ${digestsDir}\n`
  );
}

// ── Subcommand: update-marker ──────────────────────────────────────────────────

/**
 * @description Read-modify-write a single item's marker state in wave.md.
 * Takes an advisory file lock (atomic open with O_EXCL) to serialize concurrent callers.
 * Only the orchestrator calls this — workers never write wave.md directly.
 *
 * Usage:
 *   update-marker --wave-md <path> --item <id> --status <x|~|!|+>
 *                 [--produced <csv>] [--wave <N>]
 *                 [--escal-policy <policy>] [--escal-policy-source <source>]
 *                 [--escal-depth <N>]
 *                 [--escal-log-append <json-object>]
 *
 * --escal-log-append: JSON string of a single log entry to append to escalation_log[].
 *   Reads current log, appends the entry, writes back — all inside the lock.
 *   Example: '{"agent":"implementer","tier":"deep-coder","attempted":true,"recusal_reason":"..."}'
 *
 * Exit codes: 0 success, 1 error (item not found, lock contention, parse failure)
 * @param {string[]} cliArgs
 */
function cmdUpdateMarker(cliArgs) {
  const waveMdPath     = arg(cliArgs, '--wave-md',             true);
  const itemId         = arg(cliArgs, '--item',                true);
  const newStatus      = arg(cliArgs, '--status',              true);
  const producedCsv    = arg(cliArgs, '--produced');
  const waveNumArg     = arg(cliArgs, '--wave');
  const escalPol       = arg(cliArgs, '--escal-policy');
  const escalSrc       = arg(cliArgs, '--escal-policy-source');
  const escalDepArg    = arg(cliArgs, '--escal-depth');
  const escalLogAppend = arg(cliArgs, '--escal-log-append');

  const VALID_STATUS = new Set(['x', '~', '!', '+']);
  if (!VALID_STATUS.has(newStatus)) {
    die(`--status must be one of: x ~ ! +; got: ${newStatus}`);
  }

  // Advisory file lock: atomic create with O_EXCL (stdlib only, no npm deps)
  const lockPath = waveMdPath + '.lock';
  let lockFd;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
  } catch (e) {
    die(`wave.md is locked by concurrent update-marker: ${lockPath}`);
  }

  // Use throw inside the lock scope instead of die() — process.exit() skips finally,
  // which would leave the lock file orphaned. Catch at the outer level, then release
  // the lock before exiting.
  let lockError = null;
  try {
    if (!fs.existsSync(waveMdPath)) throw new Error(`wave.md not found: ${waveMdPath}`);

    const content  = fs.readFileSync(waveMdPath, 'utf8');
    const waveData = parseWaveMd(content);
    const item     = waveData.items.get(itemId);
    if (!item) throw new Error(`item '${itemId}' not found in ${waveMdPath}`);

    const STATUS_MAP = { 'x': 'complete', '~': 'in_progress', '!': 'blocked', '+': 'extend' };
    item.status = STATUS_MAP[newStatus];
    if (producedCsv)   item.produced  = producedCsv.split(',').map(s => s.trim()).filter(Boolean);
    if (waveNumArg)    item.wave_num  = parseInt(waveNumArg, 10);
    if (escalPol)      item.escalation_policy = escalPol;
    if (escalSrc)      item.escalation_policy_source = escalSrc;
    if (escalDepArg)   item.escalation_depth = parseInt(escalDepArg, 10);
    if (escalLogAppend) {
      let entry;
      try { entry = JSON.parse(escalLogAppend); } catch (e) {
        throw new Error(`--escal-log-append is not valid JSON: ${e.message}`);
      }
      item.escalation_log = [...(item.escalation_log || []), entry];
    }

    writeWaveMd(waveData, waveMdPath);
    process.stdout.write(`update-marker: ${itemId} → [${newStatus}] (${STATUS_MAP[newStatus]})\n`);
  } catch (e) {
    lockError = e;
  } finally {
    fs.closeSync(lockFd);
    try { fs.unlinkSync(lockPath); } catch (_) {}
  }

  if (lockError) die(lockError.message);
}

// ── Subcommand: targets ────────────────────────────────────────────────────────

/**
 * @description Emit sorted unique target_resources paths from wave.md, one per line.
 * Pure reader — no state mutation. Orchestrator uses this in Step 12 git commit
 * (replaces `jq -r '.batches[].items[].target_resources[]'` on wave.json).
 *
 * Exit codes: 0 success (even empty), 1 unreadable/malformed wave.md
 * @param {string[]} cliArgs
 */
function cmdTargets(cliArgs) {
  const waveMdPath = arg(cliArgs, '--wave-md', true);

  if (!fs.existsSync(waveMdPath)) {
    process.stderr.write(`c-thru-plan-harness: wave.md not found: ${waveMdPath}\n`);
    process.exit(1);
  }

  let waveData;
  try {
    const content = fs.readFileSync(waveMdPath, 'utf8');
    waveData = parseWaveMd(content);
  } catch (e) {
    process.stderr.write(`c-thru-plan-harness: failed to parse wave.md: ${e.message}\n`);
    process.exit(1);
  }

  const allPaths = new Set();
  for (const [, item] of waveData.items) {
    for (const r of (item.target_resources || [])) {
      if (r) allPaths.add(r);
    }
  }

  const sorted = [...allPaths].sort();
  if (sorted.length > 0) {
    process.stdout.write(sorted.join('\n') + '\n');
  }
  process.exit(0);
}

// ── Main dispatch ──────────────────────────────────────────────────────────────

const [,, subcmd, ...rest] = process.argv;

const USAGE = `
c-thru-plan-harness — deterministic wave-lifecycle helpers

Subcommands:
  batch           --current-md <path> --items <id1,id2,...> --wave-id <N>
                  --commit-msg <msg> --output <wave.md> [--escal-policy <policy>]
  batch-abort     --failed <N> --total <N> [--wave-dir <path>]
  calibrate       --item <id> --agent <name> --confidence <high|medium|low>
                  --verify-pass <true|false|null> [--has-confidence] --wave-dir <path>
  concat          --wave-dir <path>
  inject-contract --contract <path> --digests-dir <path>
  update-marker   --wave-md <path> --item <id> --status <x|~|!|+>
                  [--produced <csv>] [--wave <N>]
                  [--escal-policy <policy>] [--escal-policy-source <source>]
                  [--escal-depth <N>] [--escal-log-append <json-object>]
  targets         --wave-md <path>

Exit codes: 0 success, 1 abort/error, 2 cycle detected (batch)
`.trimStart();

switch (subcmd) {
  case 'batch':           cmdBatch(rest);          break;
  case 'batch-abort':     cmdBatchAbort(rest);     break;
  case 'calibrate':       cmdCalibrate(rest);      break;
  case 'concat':          cmdConcat(rest);         break;
  case 'inject-contract': cmdInjectContract(rest); break;
  case 'update-marker':   cmdUpdateMarker(rest);   break;
  case 'targets':         cmdTargets(rest);        break;
  default:
    process.stdout.write(USAGE);
    process.exit(subcmd ? 1 : 0);
}

