#!/usr/bin/env node
/**
 * c-thru-plan-harness.js — Deterministic wave-lifecycle helpers.
 *
 * Responsibilities (5 subcommands):
 *   batch           Topo-sort READY_ITEMS + resource-conflict batching → wave.json
 *                   Migrated from: agents/plan-orchestrator.md Step 3
 *   batch-abort     Evaluate batch-abort threshold (>50% failed, or ≥2 in batch of ≤3)
 *                   Migrated from: agents/plan-orchestrator.md Batch-abort threshold section
 *   calibrate       Emit per-item calibration tuple → cascade/<item>.jsonl
 *                   Migrated from: agents/plan-orchestrator.md Step 6b
 *   concat          Cat findings/*.jsonl → findings.jsonl; outputs/*.md → artifact.md
 *                   Migrated from: agents/plan-orchestrator.md Step 7
 *   inject-contract Prepend shared/_worker-contract.md to each digest file
 *                   Enables: shared/worker-contract.md → B1 drift elimination
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
 * @returns {Map<string, {id:string, status:string, depends_on:string[], target_resources:string[], agent:string|null}>}
 */
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
 * @description Produce wave.json from current.md + READY_ITEMS list.
 * Writes the file atomically (tmp + rename). Exits non-zero on cycle.
 * Migrated from plan-orchestrator.md Step 3.
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

  const batches = assignBatches(sorted, specs);

  // Build wave.json structure matching plan-orchestrator Step 3 schema
  const wave = {
    wave_id:        waveId,
    commit_message: commitMsg,
    batches: batches.map(b => ({
      parallel: b.parallel,
      items: b.items.map(id => {
        const spec = specs.get(id) || {};
        return {
          agent:                    spec.agent || 'implementer',
          item:                     id,
          target_resources:         spec.target_resources || [],
          depends_on:               spec.depends_on || [],
          escalation_policy:        escalPolicy,
          escalation_policy_source: 'harness-batch',
          escalation_depth:         0,
          escalation_log:           [],
        };
      }),
    })),
  };

  // Atomic write: tmp file + rename
  const tmp = outputPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(wave, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, outputPath);

  process.stdout.write(`batch: wrote ${batches.length} batch(es) for ${sorted.length} item(s) → ${outputPath}\n`);
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
  const separator = '\n\n---\n\n## Worker contract\n\n';

  const digests = fs.readdirSync(digestsDir)
    .filter(f => f.endsWith('.md'))
    .sort();

  let injectedCount = 0;
  for (const file of digests) {
    const digestPath    = path.join(digestsDir, file);
    const digestContent = fs.readFileSync(digestPath, 'utf8');
    // Idempotent: skip if already injected (guard against double-run on resume)
    if (digestContent.includes('## Worker contract')) continue;
    fs.writeFileSync(digestPath, digestContent + separator + contractContent, 'utf8');
    injectedCount++;
  }

  const skipped = digests.length - injectedCount;
  process.stdout.write(
    `inject-contract: injected into ${injectedCount}/${digests.length} digest(s)` +
    (skipped > 0 ? ` (${skipped} already had contract — skipped)` : '') +
    ` in ${digestsDir}\n`
  );
}

// ── Main dispatch ──────────────────────────────────────────────────────────────

const [,, subcmd, ...rest] = process.argv;

const USAGE = `
c-thru-plan-harness — deterministic wave-lifecycle helpers

Subcommands:
  batch           --current-md <path> --items <id1,id2,...> --wave-id <N>
                  --commit-msg <msg> --output <wave.json> [--escal-policy <policy>]
  batch-abort     --failed <N> --total <N> [--wave-dir <path>]
  calibrate       --item <id> --agent <name> --confidence <high|medium|low>
                  --verify-pass <true|false|null> [--has-confidence] --wave-dir <path>
  concat          --wave-dir <path>
  inject-contract --contract <path> --digests-dir <path>

Exit codes: 0 success, 1 abort/error, 2 cycle detected (batch)
`.trimStart();

switch (subcmd) {
  case 'batch':           cmdBatch(rest);          break;
  case 'batch-abort':     cmdBatchAbort(rest);     break;
  case 'calibrate':       cmdCalibrate(rest);      break;
  case 'concat':          cmdConcat(rest);         break;
  case 'inject-contract': cmdInjectContract(rest); break;
  default:
    process.stdout.write(USAGE);
    process.exit(subcmd ? 1 : 0);
}
