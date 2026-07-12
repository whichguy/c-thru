#!/usr/bin/env node
'use strict';
// Regression guard for c-thru's default statusLine: inject it only when
// neither user settings nor caller --settings supplied one.

const { assert, assertEq, summary } = require('./helpers');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const CTHRU_PATH = path.join(REPO, 'tools', 'c-thru');

function extractEphemeral(src) {
  const scriptMatch = src.match(/EPHEMERAL_SETTINGS_JSON=\$\(node -e '\n([\s\S]*?)\n  ' ((?:"\$\w+" ?)+)\)/);
  if (!scriptMatch) throw new Error('could not locate the EPHEMERAL_SETTINGS_JSON node -e script in tools/c-thru');
  return {
    jsBody: scriptMatch[1],
    argVarNames: [...scriptMatch[2].matchAll(/\$(\w+)/g)].map(m => m[1]),
  };
}

function runEphemeral(extracted, userSettingsPath) {
  const args = extracted.argVarNames.map(name => `SENTINEL__${name}`);
  const userSettingsIndex = extracted.argVarNames.indexOf('user_settings_path');
  const callerSettingsIndex = extracted.argVarNames.indexOf('caller_settings_payloads_json');
  const statuslineIndex = extracted.argVarNames.indexOf('statusline_cmd');
  if (userSettingsIndex < 0 || callerSettingsIndex < 0 || statuslineIndex < 0) {
    throw new Error('ephemeral argv list is missing user_settings_path, caller_settings_payloads_json, or statusline_cmd');
  }
  args[userSettingsIndex] = userSettingsPath;
  args[callerSettingsIndex] = '[]';

  const result = spawnSync(process.execPath, ['-e', extracted.jsBody, '--', ...args], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`ephemeral node -e script failed: ${result.stderr || result.error}`);
  }
  const output = JSON.parse(result.stdout);
  return { settings: output.settings, statuslineCommand: args[statuslineIndex] };
}

function main() {
  console.log('statusline absent-only injection\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-statusline-injection-'));
  try {
    const extracted = extractEphemeral(fs.readFileSync(CTHRU_PATH, 'utf8'));

    const absentPath = path.join(tmpDir, 'absent-settings.json');
    fs.writeFileSync(absentPath, JSON.stringify({}));
    const absent = runEphemeral(extracted, absentPath);
    assertEq(absent.settings.statusLine.type, 'command', 'absent statusLine injects a command statusline');
    assertEq(absent.settings.statusLine.command, absent.statuslineCommand,
      'absent statusLine uses the resolved c-thru-statusline command');

    const presentPath = path.join(tmpDir, 'present-settings.json');
    const ownStatusLine = { type: 'command', command: '/my/own/statusline' };
    fs.writeFileSync(presentPath, JSON.stringify({ statusLine: ownStatusLine }));
    const present = runEphemeral(extracted, presentPath);
    assert(present.settings.statusLine && present.settings.statusLine.type === 'command',
      'existing user statusLine remains present');
    assertEq(present.settings.statusLine.command, ownStatusLine.command,
      'existing user statusLine command is never overwritten');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main();
