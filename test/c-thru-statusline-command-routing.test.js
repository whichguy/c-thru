#!/usr/bin/env node
'use strict';
// T-C: static contract — slash command + skills route clear/statusline to
// the helpers and POST /c-thru/stats/clear (no spawn, no network).
// Run: node test/c-thru-statusline-command-routing.test.js

const fs = require('fs');
const path = require('path');
const { assert, assertEq, summary } = require('./helpers');

const REPO = path.resolve(__dirname, '..');

console.log('c-thru statusline/command routing (static)\n');

function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

// ── commands/c-thru-status.md ──────────────────────────────────────────────
console.log('1. commands/c-thru-status.md');
const cmd = read('commands/c-thru-status.md');
assert(/c-thru-managed:\s*c-thru-status/.test(cmd), 'managed version marker present');
assert(/statusline-status/.test(cmd), 'routes statusline status → statusline-status');
assert(/statusline-on/.test(cmd), 'routes statusline on → statusline-on');
assert(/statusline-off/.test(cmd), 'routes statusline off → statusline-off');
assert(/statusline-style/.test(cmd), 'routes statusline style → statusline-style');
assert(/\/c-thru\/stats\/clear/.test(cmd) || /stats clear/.test(cmd),
  'clear path mentions stats clear or POST /c-thru/stats/clear');
assert(/restart/i.test(cmd), 'mentions restart required for statusline enable');

// ── skills/c-thru-config/SKILL.md ──────────────────────────────────────────
console.log('2. skills/c-thru-config/SKILL.md');
const config = read('skills/c-thru-config/SKILL.md');
assert(/statusline/.test(config), 'config skill documents statusline');
assert(/statusline-status/.test(config) || /statusline status/.test(config),
  'config skill statusline status surface');
assert(/statusline-on|statusline on/.test(config), 'config skill statusline on surface');
assert(/statusline-style|statusline style/.test(config), 'config skill style surface');
assert(/C_THRU_ORIGINAL_PROFILE_DIR/.test(config),
  'config skill durable profile resolver documented');

// ── skills/c-thru-control/SKILL.md ─────────────────────────────────────────
console.log('3. skills/c-thru-control/SKILL.md');
const control = read('skills/c-thru-control/SKILL.md');
assert(/\/c-thru\/stats\/clear/.test(control),
  'control skill documents POST /c-thru/stats/clear');
assert(/clear|reset/i.test(control), 'control skill mentions clear/reset');
assert(/lifetime ledger|usage-stats|machine-wide/i.test(control),
  'control skill clarifies machine-wide ledger (not per session)');

// ── product: empty _ct_args safe expansion still present ─────────────────
console.log('4. tools/c-thru empty-array curl expansion (W0 contract)');
const cthru = read('tools/c-thru');
const curlLines = cthru.split('\n').filter(l => /curl /.test(l) && /_ct_args/.test(l));
assert(curlLines.length >= 2, `at least two curl+_ct_args lines (got ${curlLines.length})`);
for (const line of curlLines) {
  // Strip the safe form first so any remaining "${_ct_args[@]}" is the bare bug.
  const stripped = line.replace(/\$\{_ct_args\[@\]\+"\$\{_ct_args\[@\]\}"\}/g, 'SAFE_CT_ARGS');
  assert(!/"\$\{_ct_args\[@\]\}"/.test(stripped),
    `no bare quoted empty-array form on curl line: ${line.trim()}`);
  assert(/SAFE_CT_ARGS/.test(stripped) || /\$\{_ct_args\[@\]\+"\$\{_ct_args\[@\]\}"\}/.test(line),
    `safe expansion form present: ${line.trim()}`);
}

process.exit(summary() ? 1 : 0);
