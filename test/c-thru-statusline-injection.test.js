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
  const scriptMatch = src.match(/EPHEMERAL_SETTINGS_JSON=\$\(node -e '\n([\s\S]*?)\n  '([^\n]*)\) \|\| \{/);
  if (!scriptMatch) throw new Error('could not locate the EPHEMERAL_SETTINGS_JSON node -e script in tools/c-thru');
  const argSource = scriptMatch[2].trim();
  const argPattern = /"\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\})"(?:\s+|$)/y;
  const argVarNames = [];
  let offset = 0;
  while (offset < argSource.length) {
    argPattern.lastIndex = offset;
    const argMatch = argPattern.exec(argSource);
    if (!argMatch) throw new Error(`unsupported EPHEMERAL_SETTINGS_JSON argv near: ${argSource.slice(offset)}`);
    argVarNames.push(argMatch[1] || argMatch[2]);
    offset = argPattern.lastIndex;
  }
  return {
    jsBody: scriptMatch[1],
    argVarNames,
  };
}

function runEphemeral(extracted, userSettingsPath, extraEnv = {}) {
  const args = extracted.argVarNames.map(name => `SENTINEL__${name}`);
  const userSettingsIndex = extracted.argVarNames.indexOf('user_settings_path');
  const callerSettingsIndex = extracted.argVarNames.indexOf('caller_settings_payloads_json');
  const statuslineIndex = extracted.argVarNames.indexOf('statusline_cmd');
  if (userSettingsIndex < 0 || callerSettingsIndex < 0 || statuslineIndex < 0) {
    throw new Error('ephemeral argv list is missing user_settings_path, caller_settings_payloads_json, or statusline_cmd');
  }
  args[userSettingsIndex] = userSettingsPath;
  args[callerSettingsIndex] = '[]';

  const result = spawnSync(process.execPath, ['-e', extracted.jsBody, '--', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`ephemeral node -e script failed: ${result.stderr || result.error}`);
  }
  const output = JSON.parse(result.stdout);
  return { settings: output.settings, statuslineCommand: args[statuslineIndex] };
}

function main() {
  console.log('statusline absent-only injection (default when unspecified)\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-statusline-injection-'));
  try {
    const extracted = extractEphemeral(fs.readFileSync(CTHRU_PATH, 'utf8'));
    assert(extracted.argVarNames.includes('C_THRU_COORDINATOR_ACTIVE'),
      'extractor retains the appended defaulted coordinator argv');

    const envNoOptOut = { ...process.env };
    delete envNoOptOut.C_THRU_NO_STATUSLINE;

    const absentPath = path.join(tmpDir, 'absent-settings.json');
    fs.writeFileSync(absentPath, JSON.stringify({}));
    const absentDefault = runEphemeral(extracted, absentPath, envNoOptOut);
    assertEq(absentDefault.settings.statusLine.type, 'command', 'absent statusLine injects default statusline');
    assertEq(absentDefault.settings.statusLine.command, absentDefault.statuslineCommand,
      'default statusLine uses the resolved c-thru-statusline command');

    const presentPath = path.join(tmpDir, 'present-settings.json');
    const ownStatusLine = { type: 'command', command: '/my/own/statusline' };
    fs.writeFileSync(presentPath, JSON.stringify({ statusLine: ownStatusLine }));
    const present = runEphemeral(extracted, presentPath, envNoOptOut);
    assert(present.settings.statusLine && present.settings.statusLine.type === 'command',
      'existing user statusLine remains present');
    assertEq(present.settings.statusLine.command, ownStatusLine.command,
      'existing user statusLine command is never overwritten');

    const optOut = runEphemeral(extracted, absentPath, { ...envNoOptOut, C_THRU_NO_STATUSLINE: '1' });
    assert(!optOut.settings.statusLine,
      'C_THRU_NO_STATUSLINE=1 skips default statusLine inject when none specified');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main();
