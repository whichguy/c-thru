#!/usr/bin/env node
'use strict';
// Passive per-AGENT offload telemetry from Claude Code session transcripts.
//
// WHY — the proxy can only report per-CAPABILITY usage (usage-stats.json's by_agent
// map is keyed by capability; the hook collapses agent -> capability before the
// proxy sees the request). So the proxy literally cannot tell you how often
// `reviewer-plan` vs `code-reviewer` ran, or `plan-scheduler` vs `fast-generalist`.
// This tool reads the transcripts Claude Code writes anyway and aggregates by the
// REAL subagent name — agent-precise, retroactive over existing sessions, with zero
// runtime overhead (it touches no proxy, no live session).
//
// Source: <config>/projects/<project>/<session>.jsonl, parsed via
// tools/agent-offload-lib.js (PARSE-not-grep; see that file). config dir =
// $CLAUDE_CONFIG_DIR or ~/.claude.
//
// Usage:
//   node tools/c-thru-agent-usage.js [--since <YYYY-MM-DD>] [--project <slug>]
//                                    [--json] [--config-dir <path>]
//   --since       only delegations on/after this date (ISO prefix compare)
//   --project     only transcripts whose project dir name contains <slug>
//   --json        machine-readable output
//   --config-dir  override the Claude config dir (default $CLAUDE_CONFIG_DIR or ~/.claude)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractDelegations, aggregateByAgent } = require('./agent-offload-lib.js');

// Read the value for a value-taking flag, refusing to swallow the next flag.
// Mirrors extractFlagValue in tools/c-thru-config-helpers.js: an undefined value
// or one that startsWith('--') is not a real value — error out instead of
// consuming the following flag (C47).
function takeFlagValue(argv, i, flag) {
  const val = argv[i + 1];
  if (val === undefined || val.startsWith('--')) {
    console.error(`${flag} requires a value`);
    process.exit(2);
  }
  return val;
}

function parseArgs(argv) {
  const opts = { since: null, project: null, json: false, configDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--since') { opts.since = takeFlagValue(argv, i, '--since'); i++; }
    else if (a === '--project') { opts.project = takeFlagValue(argv, i, '--project'); i++; }
    else if (a === '--config-dir') { opts.configDir = takeFlagValue(argv, i, '--config-dir'); i++; }
    else if (a === '-h' || a === '--help') opts.help = true;
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  // --since must be an ISO date prefix (YYYY-MM-DD); reject anything else so a
  // typo can't silently match nothing / everything.
  if (opts.since !== null && !/^\d{4}-\d{2}-\d{2}/.test(opts.since)) {
    console.error(`--since must be an ISO date (YYYY-MM-DD), got: ${opts.since}`);
    process.exit(2);
  }
  return opts;
}

function findTranscripts(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_e) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findTranscripts(full));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function fmtInt(n) { return n.toLocaleString('en-US'); }
function fmtDate(iso) { return iso ? iso.slice(0, 10) : '—'; }

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node tools/c-thru-agent-usage.js [--since YYYY-MM-DD] [--project slug] [--json] [--config-dir path]');
    process.exit(0);
  }

  const configDir = opts.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const projectsDir = path.join(configDir, 'projects');

  if (!fs.existsSync(projectsDir)) {
    const msg = `no transcripts: ${projectsDir} does not exist`;
    if (opts.json) console.log(JSON.stringify({ error: msg, agents: [] }, null, 2));
    else console.log(msg);
    process.exit(0);
  }

  let files = findTranscripts(projectsDir);
  if (opts.project) {
    files = files.filter((f) => path.relative(projectsDir, f).split(path.sep)[0].includes(opts.project));
  }

  let delegations = [];
  let filesRead = 0;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); }
    catch (_e) { continue; }
    filesRead++;
    delegations = delegations.concat(extractDelegations(text));
  }
  if (opts.since) delegations = delegations.filter((d) => d.ts && d.ts >= opts.since);

  const agg = aggregateByAgent(delegations);
  const rows = Object.values(agg).sort((a, b) => b.calls - a.calls || b.tokens - a.tokens);

  const totals = rows.reduce(
    (t, r) => { t.calls += r.calls; t.completed += r.completed; t.tokens += r.tokens; t.durationMs += r.durationMs; return t; },
    { calls: 0, completed: 0, tokens: 0, durationMs: 0 }
  );

  if (opts.json) {
    console.log(JSON.stringify({
      configDir, filesScanned: files.length, filesRead,
      since: opts.since || null, project: opts.project || null,
      totals, agents: rows,
    }, null, 2));
    return;
  }

  console.log(`c-thru agent-usage — per-agent offload from transcripts (agent-precise; proxy stats are capability-grained)`);
  console.log(`  config: ${configDir}   transcripts: ${filesRead}${opts.project ? `   project~"${opts.project}"` : ''}${opts.since ? `   since: ${opts.since}` : ''}`);
  console.log('');
  if (rows.length === 0) {
    console.log('  (no Agent/Task delegations found)');
    return;
  }

  const nameW = Math.max(5, ...rows.map((r) => r.agent.length));
  const head = `  ${'AGENT'.padEnd(nameW)}  ${'CALLS'.padStart(6)}  ${'DONE'.padStart(5)}  ${'TOKENS'.padStart(12)}  ${'AVG ms'.padStart(8)}  LAST SEEN`;
  console.log(head);
  console.log(`  ${'-'.repeat(nameW)}  ${'-'.repeat(6)}  ${'-'.repeat(5)}  ${'-'.repeat(12)}  ${'-'.repeat(8)}  ${'-'.repeat(10)}`);
  for (const r of rows) {
    const avg = r.completed > 0 ? Math.round(r.durationMs / r.completed) : 0;
    console.log(`  ${r.agent.padEnd(nameW)}  ${fmtInt(r.calls).padStart(6)}  ${fmtInt(r.completed).padStart(5)}  ${fmtInt(r.tokens).padStart(12)}  ${fmtInt(avg).padStart(8)}  ${fmtDate(r.lastSeen)}`);
  }
  console.log(`  ${'-'.repeat(nameW)}  ${'-'.repeat(6)}  ${'-'.repeat(5)}  ${'-'.repeat(12)}  ${'-'.repeat(8)}  ${'-'.repeat(10)}`);
  console.log(`  ${'TOTAL'.padEnd(nameW)}  ${fmtInt(totals.calls).padStart(6)}  ${fmtInt(totals.completed).padStart(5)}  ${fmtInt(totals.tokens).padStart(12)}`);
}

main();
