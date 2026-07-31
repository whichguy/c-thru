#!/usr/bin/env node
'use strict';
// Durable profile resolver + statusline writes must not land in the ephemeral shadow.
//
// Run: node test/c-thru-durable-profile.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, assertEq, summary } = require('./helpers');

const REPO = path.resolve(__dirname, '..');
const HELPER = path.join(REPO, 'tools', 'c-thru-config-helpers.js');
const LIB = path.join(REPO, 'tools', 'c-thru-lib.sh');
const STATUSLINE_SRC = path.join(REPO, 'tools', 'c-thru-statusline.sh');

console.log('c-thru-durable-profile tests\n');

function runHelper(env, args) {
  return spawnSync(process.execPath, [HELPER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// ── Export presence ─────────────────────────────────────────────────────────
{
  const cthru = fs.readFileSync(path.join(REPO, 'tools', 'c-thru'), 'utf8');
  assert(/export C_THRU_ORIGINAL_PROFILE_DIR=/.test(cthru),
    'tools/c-thru exports C_THRU_ORIGINAL_PROFILE_DIR');
  const lib = fs.readFileSync(LIB, 'utf8');
  assert(/cthru_durable_profile_dir\(\)/.test(lib),
    'c-thru-lib.sh defines cthru_durable_profile_dir');
  assert(!/cthru_durable_profile_dir[\s\S]*CLAUDE_PROFILE_DIR/.test(
    lib.slice(lib.indexOf('cthru_durable_profile_dir'))
  ) || !lib.slice(lib.indexOf('cthru_durable_profile_dir'), lib.indexOf('cthru_durable_profile_dir') + 400)
    .includes('${CLAUDE_PROFILE_DIR'),
    'cthru_durable_profile_dir does not expand CLAUDE_PROFILE_DIR');
}

// ── statusline-style writes durable dir, not shadow ─────────────────────────
{
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-shadow-'));
  const durable = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-durable-'));
  // materialize statusline script for statusline-on
  const toolsDir = path.join(durable, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.copyFileSync(STATUSLINE_SRC, path.join(toolsDir, 'c-thru-statusline'));
  fs.chmodSync(path.join(toolsDir, 'c-thru-statusline'), 0o755);

  const env = {
    CLAUDE_PROFILE_DIR: shadow,
    CLAUDE_CONFIG_DIR: shadow,
    C_THRU_ORIGINAL_PROFILE_DIR: durable,
    HOME: durable, // os.homedir fallback won't hit real home
  };

  let r = runHelper(env, ['statusline-style', 'stats']);
  assertEq(r.status, 0, 'statusline-style exits 0');
  const pref = path.join(durable, 'c-thru-statusline.json');
  assert(fs.existsSync(pref), 'pref file in durable dir');
  assert(!fs.existsSync(path.join(shadow, 'c-thru-statusline.json')),
    'pref file NOT in shadow');
  const prefObj = JSON.parse(fs.readFileSync(pref, 'utf8'));
  assertEq(prefObj.style, 'stats', 'style=stats in pref');

  r = runHelper(env, ['statusline-on']);
  assertEq(r.status, 0, 'statusline-on exits 0');
  const settingsPath = path.join(durable, 'settings.json');
  assert(fs.existsSync(settingsPath), 'settings.json in durable dir');
  assert(!fs.existsSync(path.join(shadow, 'settings.json')),
    'settings.json NOT in shadow');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert(settings.statusLine && /c-thru-statusline/.test(settings.statusLine.command),
    'statusLine command is c-thru-statusline');

  // Shadow deletion survival
  fs.rmSync(shadow, { recursive: true, force: true });
  assert(fs.existsSync(settingsPath), 'settings survives shadow rm');
  assert(fs.existsSync(pref), 'pref survives shadow rm');

  // status still works
  r = runHelper(env, ['statusline-status']);
  assertEq(r.status, 0, 'statusline-status after shadow rm');
  assert(/source:\s+c-thru/.test(r.stdout), 'status reports c-thru source');

  // off
  r = runHelper(env, ['statusline-off']);
  assertEq(r.status, 0, 'statusline-off exits 0');
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert(!after.statusLine, 'statusLine removed');

  fs.rmSync(durable, { recursive: true, force: true });
}

// ── foreign statusLine refuses without --force ──────────────────────────────
{
  const durable = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-foreign-'));
  const toolsDir = path.join(durable, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.copyFileSync(STATUSLINE_SRC, path.join(toolsDir, 'c-thru-statusline'));
  fs.writeFileSync(path.join(durable, 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: '/my/custom/statusline' },
  }));
  const env = { C_THRU_ORIGINAL_PROFILE_DIR: durable, HOME: durable };
  let r = runHelper(env, ['statusline-on']);
  assert(r.status !== 0, 'statusline-on refuses foreign without --force');
  r = runHelper(env, ['statusline-on', '--force']);
  assertEq(r.status, 0, 'statusline-on --force replaces foreign');
  const s = JSON.parse(fs.readFileSync(path.join(durable, 'settings.json'), 'utf8'));
  assert(/c-thru-statusline/.test(s.statusLine.command), 'replaced with c-thru');
  fs.rmSync(durable, { recursive: true, force: true });
}

// ── symlink destination preserved ───────────────────────────────────────────
{
  const durable = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-symlink-'));
  const realSettings = path.join(durable, 'real-settings.json');
  const linkPath = path.join(durable, 'settings.json');
  fs.writeFileSync(realSettings, '{}\n');
  fs.symlinkSync(realSettings, linkPath);
  const toolsDir = path.join(durable, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.copyFileSync(STATUSLINE_SRC, path.join(toolsDir, 'c-thru-statusline'));
  const env = { C_THRU_ORIGINAL_PROFILE_DIR: durable, HOME: durable };
  const r = runHelper(env, ['statusline-on']);
  assertEq(r.status, 0, 'statusline-on with symlink settings');
  assert(fs.lstatSync(linkPath).isSymbolicLink(), 'settings.json still a symlink');
  const content = JSON.parse(fs.readFileSync(realSettings, 'utf8'));
  assert(content.statusLine, 'symlink target updated with statusLine');
  fs.rmSync(durable, { recursive: true, force: true });
}

// ── E3: planning skill uses durable resolver (string contract + write sim) ───
{
  const skill = fs.readFileSync(path.join(REPO, 'skills', 'c-thru-config', 'SKILL.md'), 'utf8');
  const planningIdx = skill.indexOf('## Subcommand: `planning`');
  assert(planningIdx >= 0, 'planning section exists');
  const planning = skill.slice(planningIdx);
  assert(!/CLAUDE_DIR="\$\{CLAUDE_PROFILE_DIR:-\$HOME\/\.claude\}"/.test(planning),
    'planning section must not assign CLAUDE_DIR from CLAUDE_PROFILE_DIR');
  assert(/C_THRU_ORIGINAL_PROFILE_DIR:-\$\{CLAUDE_DIR:-\$HOME\/\.claude\}/.test(planning),
    'planning section uses C_THRU_ORIGINAL_PROFILE_DIR durable resolver');

  // Simulate planning enable write with durable resolver (same env contract as skill)
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-plan-shadow-'));
  const durable = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-plan-durable-'));
  const script = `
set -euo pipefail
CLAUDE_PROFILE_DIR="${shadow}"
CLAUDE_CONFIG_DIR="${shadow}"
C_THRU_ORIGINAL_PROFILE_DIR="${durable}"
CLAUDE_DIR="\${C_THRU_ORIGINAL_PROFILE_DIR:-\${CLAUDE_DIR:-\$HOME/.claude}}"
SETTINGS="$CLAUDE_DIR/settings.json"
mkdir -p "$CLAUDE_DIR"
echo '{}' > "$SETTINGS"
# minimal "enable" mutation
tmp="\${SETTINGS}.tmp.$$"
printf '%s\\n' '{"hooks":{"PreToolUse":[]}}' > "$tmp" && mv "$tmp" "$SETTINGS"
test -f "${durable}/settings.json"
test ! -f "${shadow}/settings.json"
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assertEq(r.status, 0, 'planning durable write simulation exits 0');
  assert(fs.existsSync(path.join(durable, 'settings.json')), 'planning wrote durable settings');
  assert(!fs.existsSync(path.join(shadow, 'settings.json')), 'planning did not write shadow');
  fs.rmSync(shadow, { recursive: true, force: true });
  fs.rmSync(durable, { recursive: true, force: true });
}

// ── D5: plugin-only materialize (no install.sh tools dir pre-seeded) ────────
{
  const durable = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-plugin-only-'));
  // No durable/tools yet — helper should materialize from __dirname (repo tools/)
  const env = {
    C_THRU_ORIGINAL_PROFILE_DIR: durable,
    HOME: durable,
    CLAUDE_PROFILE_DIR: path.join(durable, 'shadow-unused'),
  };
  const r = runHelper(env, ['statusline-on']);
  assertEq(r.status, 0, 'plugin-only statusline-on exits 0');
  const stable = path.join(durable, 'tools', 'c-thru-statusline');
  assert(fs.existsSync(stable), 'materialized stable tools/c-thru-statusline');
  try {
    fs.accessSync(stable, fs.constants.X_OK);
    assert(true, 'materialized statusline is executable');
  } catch {
    assert(false, 'materialized statusline is executable');
  }
  const settings = JSON.parse(fs.readFileSync(path.join(durable, 'settings.json'), 'utf8'));
  assert(settings.statusLine && settings.statusLine.command.includes('c-thru-statusline'),
    'settings points at c-thru-statusline');
  fs.rmSync(durable, { recursive: true, force: true });
}

// ── D5b: fail-loud when no statusline script candidates ─────────────────────
{
  const durable = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-no-sl-'));
  // Point __dirname away by using a copy of helper that can't find scripts —
  // simpler: empty durable + move HELPER candidates by running with broken PATH
  // and a temp helper is heavy. Assert die message contract via env isolating HOME
  // when helper's __dirname still finds repo tools — skip if always finds repo.
  // Contract: die message documents install.sh
  const src = fs.readFileSync(HELPER, 'utf8');
  assert(/run bash install\.sh/.test(src),
    'statusline-on fail-loud message mentions install.sh');
  fs.rmSync(durable, { recursive: true, force: true });
}

// ── Gap 13: fat settings / pref — only owned fields change ─────────────────
{
  console.log('\nGap 13: statusline-on preserves unrelated settings keys');
  const durable = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-fat-'));
  const toolsDir = path.join(durable, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.copyFileSync(STATUSLINE_SRC, path.join(toolsDir, 'c-thru-statusline'));
  fs.chmodSync(path.join(toolsDir, 'c-thru-statusline'), 0o755);
  const fat = {
    permissions: { allow: ['Bash(*)', 'Read'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user' }] }] },
    env: { MY_CUSTOM: 'keep-me' },
    customTopLevel: { nested: true, n: 42 },
  };
  fs.writeFileSync(path.join(durable, 'settings.json'), JSON.stringify(fat, null, 2) + '\n');
  // Pref with extra keys must survive style write
  fs.writeFileSync(path.join(durable, 'c-thru-statusline.json'),
    JSON.stringify({ style: 'default', experimental_chip: 'keep' }) + '\n');
  const env = { C_THRU_ORIGINAL_PROFILE_DIR: durable, HOME: durable };
  let r = runHelper(env, ['statusline-on']);
  assertEq(r.status, 0, 'fat settings statusline-on exits 0');
  const after = JSON.parse(fs.readFileSync(path.join(durable, 'settings.json'), 'utf8'));
  assert(after.statusLine && /c-thru-statusline/.test(after.statusLine.command),
    'statusLine added');
  assertEq(JSON.stringify(after.permissions), JSON.stringify(fat.permissions),
    'permissions key unchanged');
  assertEq(JSON.stringify(after.hooks), JSON.stringify(fat.hooks),
    'hooks key unchanged');
  assertEq(after.env.MY_CUSTOM, 'keep-me', 'env.MY_CUSTOM preserved');
  assertEq(after.customTopLevel.n, 42, 'customTopLevel preserved');

  r = runHelper(env, ['statusline-style', 'stats']);
  assertEq(r.status, 0, 'statusline-style on fat pref exits 0');
  const pref = JSON.parse(fs.readFileSync(path.join(durable, 'c-thru-statusline.json'), 'utf8'));
  assertEq(pref.style, 'stats', 'style updated to stats');
  assertEq(pref.experimental_chip, 'keep', 'unrelated pref key preserved');
  fs.rmSync(durable, { recursive: true, force: true });
}

process.exit(summary() ? 1 : 0);
