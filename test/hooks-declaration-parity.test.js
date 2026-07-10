#!/usr/bin/env node
'use strict';
// Drift guard: the c-thru hook set is declared in TWO places that must agree —
//   1. plugins/c-thru/hooks/hooks.json   (plugin-install mode; real JSON)
//   2. the node -e script inside write_ephemeral_settings() in tools/c-thru
//      (CLI launch mode; real JS executed with sentinel argv, producing real
//      JSON via JSON.stringify)
// Before this guard they had diverged: a dead PostCompact (vs the live
// PreCompact), proxy-health 3-vs-5, classify 5-vs-8, map-changed */Write|Edit.
// hooks.json was read by no test.
//
// This guard extracts {event, script-basename, matcher, timeout} from BOTH —
// by executing the real node -e script for the ephemeral side, JSON.parse for
// hooks.json — and asserts agreement for the SHARED hook set. CLI-only hooks
// (the agent-router across its PreToolUse matchers, the EnterPlanMode planner
// hint, the MCP server) are allowlisted as intentionally ephemeral-only.
//
// It is a GUARD, not a generator: the dual source stays, but can no longer
// drift silently. Negative control: change one shared hook's timeout in
// hooks.json and this fails.
//
// Run: node test/hooks-declaration-parity.test.js

const { assert, assertEq, summary } = require('./helpers');
const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const CTHRU_PATH = path.join(REPO, 'tools', 'c-thru');
const HOOKS_JSON_PATH = path.join(REPO, 'plugins', 'c-thru', 'hooks', 'hooks.json');

// Hooks that legitimately exist ONLY in the CLI ephemeral block (no plugin
// hooks.json equivalent). Keyed by normalized script basename.
const CLI_ONLY = new Set([
  'c-thru-agent-router-hook', // PreToolUse Agent|WebSearch|WebFetch|Monitor|Plan — capability routing
  'c-thru-enter-plan-hook',   // PreToolUse EnterPlanMode — advisory /c-thru-plan hint
]);

const norm = b => b.replace(/\.sh$/, '');

// ── Extract from the real node -e script in write_ephemeral_settings() ──────
// write_ephemeral_settings() builds EPHEMERAL_SETTINGS_JSON via `node -e`
// (JSON.stringify), taking resolved tool paths as argv (see tools/c-thru).
// Rather than regex against templated bash, we extract the actual JS source,
// execute it with sentinel argv (one distinct sentinel per positional arg,
// each carrying its own basename so the reverse-lookup below is unambiguous),
// and parse the REAL JSON it emits — a stronger check than pattern-matching
// source text, since a real syntax/logic error in the script would also fail.
function extractEphemeral(src) {
  // 1. var → script-basename map, from the find_tool_path assignments (still
  //    used to resolve which sentinel corresponds to which hook script).
  const varMap = {};
  for (const m of src.matchAll(/(\w+)="\$\(find_tool_path ([\w.-]+)\)"/g)) {
    varMap[m[1]] = m[2];
  }

  // 2. Extract the node -e script body and its trailing argv variable list.
  const scriptMatch = src.match(/EPHEMERAL_SETTINGS_JSON=\$\(node -e '\n([\s\S]*?)\n  ' ((?:"\$\w+" ?)+)\)/);
  if (!scriptMatch) throw new Error('could not locate the EPHEMERAL_SETTINGS_JSON node -e script in tools/c-thru');
  const jsBody = scriptMatch[1];
  const argVarNames = [...scriptMatch[2].matchAll(/\$(\w+)/g)].map(m => m[1]);

  // 3. Build sentinel argv: one visibly-distinct fake path per positional arg,
  //    embedding the shell var name so we can map back to a hook basename via
  //    varMap (e.g. "session_cmd" → SENTINEL__session_cmd).
  const sentinelArgs = argVarNames.map(name => `SENTINEL__${name}`);

  // 4. Execute the real script with sentinel argv and parse its real JSON output.
  const result = spawnSync(process.execPath, ['-e', jsBody, '--', ...sentinelArgs], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`ephemeral node -e script failed: ${result.stderr || result.error}`);
  }
  const settings = JSON.parse(result.stdout);

  // Reverse map: sentinel command string → shell var name → hook basename.
  const sentinelToVar = {};
  for (const name of argVarNames) sentinelToVar[`SENTINEL__${name}`] = name;

  const tuples = [];
  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    for (const entry of entries) {
      const matcher = ('matcher' in entry) ? entry.matcher : '(absent)';
      for (const h of (entry.hooks || [])) {
        if (typeof h.command !== 'string') continue;
        const varName = sentinelToVar[h.command];
        if (!varName) throw new Error(`ephemeral: command sentinel '${h.command}' not in argv var list`);
        const basename = varMap[varName];
        if (!basename) throw new Error(`ephemeral: $${varName} not resolved by any find_tool_path assignment`);
        tuples.push({
          event,
          matcher,
          basename: norm(basename),
          timeout: h.timeout,
          async: h.async === true,
          asyncRewake: h.asyncRewake === true,
        });
      }
    }
  }
  return tuples;
}

// ── Extract from the real-JSON plugin hooks.json ─────────────────────────────
function extractHooksJson(json) {
  const tuples = [];
  for (const [event, entries] of Object.entries(json.hooks || {})) {
    for (const entry of entries) {
      const matcher = ('matcher' in entry) ? entry.matcher : '(absent)';
      for (const h of (entry.hooks || [])) {
        if (typeof h.command !== 'string') continue;
        tuples.push({
          event,
          matcher,
          basename: norm(path.basename(h.command)),
          timeout: h.timeout,
          async: h.async === true,
          asyncRewake: h.asyncRewake === true,
        });
      }
    }
  }
  return tuples;
}

function byBasename(tuples) {
  const m = new Map();
  for (const t of tuples) {
    if (!m.has(t.basename)) m.set(t.basename, []);
    m.get(t.basename).push(t);
  }
  return m;
}

function main() {
  console.log('hook-declaration parity (ephemeral c-thru ↔ plugin hooks.json)\n');

  const ephemeral = extractEphemeral(fs.readFileSync(CTHRU_PATH, 'utf8'));
  const hooksJson = extractHooksJson(JSON.parse(fs.readFileSync(HOOKS_JSON_PATH, 'utf8')));

  // Guard the guard: a broken regex that extracts nothing must FAIL, not pass.
  assert(ephemeral.length >= 5, `extracted a non-trivial ephemeral hook set (got ${ephemeral.length})`);
  assert(hooksJson.length >= 4, `extracted a non-trivial hooks.json hook set (got ${hooksJson.length})`);

  const ephMap = byBasename(ephemeral);
  const jsonMap = byBasename(hooksJson);

  const ephNames  = new Set(ephMap.keys());
  const jsonNames = new Set(jsonMap.keys());
  const shared = [...jsonNames].filter(n => ephNames.has(n)).sort();

  console.log(`  ephemeral hooks: ${[...ephNames].sort().join(', ')}`);
  console.log(`  hooks.json hooks: ${[...jsonNames].sort().join(', ')}`);
  console.log(`  shared: ${shared.join(', ')}\n`);

  // Every ephemeral-only hook must be an intentional CLI-only one.
  for (const name of ephNames) {
    if (jsonNames.has(name)) continue;
    assert(CLI_ONLY.has(name),
      `ephemeral-only hook '${name}' is allowlisted as CLI-only (or it is unreconciled drift — add to hooks.json or to CLI_ONLY)`);
  }

  // No hook may exist ONLY in hooks.json (the plugin can't carry a hook the CLI lacks).
  for (const name of jsonNames) {
    assert(ephNames.has(name) || CLI_ONLY.has(name),
      `hooks.json hook '${name}' also exists in the ephemeral block (a hooks.json-only hook is undeclared drift)`);
  }

  // There must be a real shared set to compare (not everything siloed).
  assert(shared.length >= 4, `shared hook set is non-trivial (got ${shared.length})`);

  // Field-by-field agreement on the shared set.
  for (const name of shared) {
    const e = ephMap.get(name);
    const j = jsonMap.get(name);
    assertEq(e.length, 1, `${name}: appears once in the ephemeral block`);
    assertEq(j.length, 1, `${name}: appears once in hooks.json`);
    const ee = e[0], jj = j[0];
    assertEq(ee.event,       jj.event,       `${name}: event agrees`);
    assertEq(ee.matcher,     jj.matcher,     `${name}: matcher agrees`);
    assertEq(ee.timeout,     jj.timeout,     `${name}: timeout agrees`);
    assertEq(ee.async,       jj.async,       `${name}: async agrees`);
    assertEq(ee.asyncRewake, jj.asyncRewake, `${name}: asyncRewake agrees`);
  }

  // The compaction hook must be on the LIVE event (PreCompact), not the dead PostCompact.
  const compaction = shared.find(n => /postcompact-context/.test(n));
  if (compaction) {
    assertEq(jsonMap.get(compaction)[0].event, 'PreCompact',
      `${compaction}: registered on the live PreCompact event (PostCompact never fires)`);
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main();
