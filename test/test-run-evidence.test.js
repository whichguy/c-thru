#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL = path.resolve(__dirname, '..', 'tools', 'test-run-evidence.js');
const evidenceLib = require(TOOL);
const SECRET_CANARY = 'CTHRU_SECRET_CANARY_DO_NOT_PERSIST_7f31';

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
    passed += 1;
  } else {
    console.error(`  FAIL  ${message}`);
    failed += 1;
  }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 20000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function runCli(args, options = {}) {
  return run(process.execPath, [TOOL, ...args], options);
}

function git(repo, args) {
  const result = run('git', args, {
    cwd: repo,
    env: {
      PATH: process.env.PATH || '',
      HOME: repo,
      LC_ALL: 'C',
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-evidence-repo-'));
  fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'baseline\n');
  fs.writeFileSync(
    path.join(repo, 'config', 'model-map.json'),
    `${JSON.stringify({ routes: {}, canary: SECRET_CANARY })}\n`,
  );
  const fakeClaude = path.join(repo, 'fake-claude');
  fs.writeFileSync(
    fakeClaude,
    `#!/bin/sh\nprintf '%s\\n' 'Claude Code 9.8.7 ${SECRET_CANARY}'\n`,
    { mode: 0o755 },
  );
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'evidence@example.invalid']);
  git(repo, ['config', 'user.name', 'Evidence Test']);
  git(repo, ['config', 'core.hooksPath', '/dev/null']);
  git(repo, ['add', 'tracked.txt', 'config/model-map.json', 'fake-claude']);
  git(repo, ['commit', '-q', '-m', 'fixture']);
  return { repo, fakeClaude };
}

function fixtureEnv(repo, fakeClaude, additions = {}) {
  return {
    PATH: process.env.PATH || '',
    HOME: repo,
    LC_ALL: 'C',
    LANG: 'C',
    CLAUDE_BIN: fakeClaude,
    CLAUDE_MODEL_MAP_PATH: path.join(repo, 'config', 'model-map.json'),
    CLAUDE_MODEL_MAP_LAUNCH_CWD: repo,
    ANTHROPIC_API_KEY: SECRET_CANARY,
    OPENAI_API_KEY: SECRET_CANARY,
    GOOGLE_API_KEY: SECRET_CANARY,
    C_THRU_TEST_PROMPT: `raw prompt ${SECRET_CANARY}`,
    ...additions,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

console.log('test-run evidence tests\n');

{
  const allocation = runCli(['allocate']);
  const allocatedPath = allocation.stdout.trim();
  try {
    check(allocation.status === 0 && path.isAbsolute(allocatedPath),
      'default allocation returns an absolute path');
    const mode = fs.statSync(path.dirname(allocatedPath)).mode & 0o777;
    check(mode === 0o700, `default allocation owns a private 0700 directory (got ${mode.toString(8)})`);
  } finally {
    if (allocatedPath) {
      fs.rmSync(path.dirname(allocatedPath), { recursive: true, force: true });
    }
  }
}

{
  const { repo, fakeClaude } = makeRepo();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-evidence-output-'));
  const evidencePath = path.join(outputDir, 'evidence.json');
  const env = fixtureEnv(repo, fakeClaude);
  try {
    const initialized = runCli([
      'init',
      '--path', evidencePath,
      '--repo', repo,
      '--mode', 'hermetic',
    ], { cwd: repo, env });
    check(initialized.status === 0, `initialization succeeds (${initialized.stderr.trim()})`);

    const evidence = readJson(evidencePath);
    check(evidence.schema_version === 1 &&
      evidence.schema_id === 'c-thru-test-run-evidence' &&
      evidence.run.status === 'running',
    'initial evidence is versioned and running before suites');
    check(/^[0-9a-f]{40}$/.test(evidence.initial_identity.repository.head) &&
      evidence.initial_identity.repository.root === fs.realpathSync(repo) &&
      /^[0-9a-f]{64}$/.test(evidence.initial_identity.repository.tracked_diff_sha256) &&
      /^[0-9a-f]{64}$/.test(evidence.initial_identity.repository.untracked_content_sha256) &&
      /^[0-9a-f]{64}$/.test(evidence.initial_identity.repository.snapshot_sha256) &&
      /^[0-9a-f]{64}$/.test(evidence.initial_identity.combined_snapshot_sha256),
    'repository identity contains HEAD and versioned SHA-256 snapshot digests');
    check(evidence.initial_identity.repository.dirty === false,
      'clean fixture repository is recorded as clean');
    check(evidence.initial_identity.entrypoint_model_map.realpath ===
      fs.realpathSync(path.join(repo, 'config', 'model-map.json')) &&
      /^[0-9a-f]{64}$/.test(evidence.initial_identity.entrypoint_model_map.sha256),
    'effective entrypoint model-map realpath and hash are recorded');
    check(evidence.initial_identity.claude.path === fs.realpathSync(fakeClaude) &&
      evidence.initial_identity.claude.version === '9.8.7',
    'Claude path and parsed version are recorded without retaining raw output');
    check(typeof evidence.initial_identity.runtime.node === 'string' &&
      typeof evidence.initial_identity.runtime.os.platform === 'string' &&
      Object.prototype.hasOwnProperty.call(evidence.initial_identity.plugin_parity, 'in_sync'),
    'Node, OS, and plugin parity identity fields are present');
    check(!fs.readFileSync(evidencePath, 'utf8').includes(SECRET_CANARY),
      'credential, prompt, model-map, untracked, and Claude-output canary is not persisted');
    check((fs.statSync(evidencePath).mode & 0o777) === 0o600,
      'evidence file is mode 0600');

    const started = runCli([
      'suite-start',
      '--path', evidencePath,
      '--kind', 'ordinary',
      '--label', 'fixture suite',
    ], { cwd: repo, env });
    const suiteId = started.stdout.trim();
    const partial = readJson(evidencePath);
    check(started.status === 0 && partial.suites.length === 1 &&
      partial.suites[0].status === 'running' &&
      partial.suites[0].finished_at === null,
    'suite start is atomically retained as a partial running record');

    const finished = runCli([
      'suite-finish',
      '--path', evidencePath,
      '--id', suiteId,
      '--status', 'passed',
      '--exit-code', '0',
      '--reason', 'all_contracts_exercised',
    ], { cwd: repo, env });
    const finishedRecord = readJson(evidencePath).suites[0];
    check(finished.status === 0 && finishedRecord.status === 'passed' &&
      finishedRecord.reason === 'all_contracts_exercised' &&
      Number.isInteger(finishedRecord.duration_ms) && finishedRecord.duration_ms >= 0,
    'suite finish atomically records terminal status, safe reason, and duration');
    check(!fs.readdirSync(outputDir).some(name => name.includes('.tmp-')),
      'atomic updates leave no temporary evidence files');

    const finalized = runCli([
      'finalize',
      '--path', evidencePath,
      '--repo', repo,
      '--passed', '1',
      '--failed', '0',
      '--skipped', '0',
      '--blocked', '0',
      '--status', 'passed',
    ], { cwd: repo, env });
    const complete = readJson(evidencePath);
    check(finalized.status === 0 && complete.run.status === 'passed' &&
      complete.run.counts.passed === 1 && complete.consistency.consistent === true,
    'consistent finalization records counts/status and succeeds');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

{
  const { repo, fakeClaude } = makeRepo();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-evidence-malformed-'));
  const malformedPath = path.join(outputDir, 'malformed.json');
  const env = fixtureEnv(repo, fakeClaude);
  try {
    const malformed = '{"schema_version":';
    fs.writeFileSync(malformedPath, malformed);
    const result = runCli([
      'suite-start',
      '--path', malformedPath,
      '--kind', 'ordinary',
      '--label', 'must not run',
    ], { cwd: repo, env });
    check(result.status !== 0 && fs.readFileSync(malformedPath, 'utf8') === malformed,
      'malformed evidence fails closed without overwriting the bad artifact');

    const directoryTarget = path.join(outputDir, 'directory-target');
    fs.mkdirSync(directoryTarget);
    const writeFailure = runCli([
      'init',
      '--path', directoryTarget,
      '--repo', repo,
      '--mode', 'hermetic',
    ], { cwd: repo, env });
    check(writeFailure.status !== 0 && fs.statSync(directoryTarget).isDirectory(),
      'atomic write failure returns non-zero and preserves the existing target');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

{
  const { repo, fakeClaude } = makeRepo();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-evidence-forged-counts-'));
  const evidencePath = path.join(outputDir, 'evidence.json');
  const env = fixtureEnv(repo, fakeClaude);
  try {
    const initialized = runCli([
      'init',
      '--path', evidencePath,
      '--repo', repo,
      '--mode', 'hermetic',
    ], { cwd: repo, env });
    const started = runCli([
      'suite-start',
      '--path', evidencePath,
      '--kind', 'ordinary',
      '--label', 'failed fixture suite',
    ], { cwd: repo, env });
    const finished = runCli([
      'suite-finish',
      '--path', evidencePath,
      '--id', started.stdout.trim(),
      '--status', 'failed',
      '--exit-code', '1',
      '--reason', 'fixture_failure',
    ], { cwd: repo, env });
    const forged = runCli([
      'finalize',
      '--path', evidencePath,
      '--repo', repo,
      '--passed', '1',
      '--failed', '0',
      '--skipped', '0',
      '--blocked', '0',
      '--status', 'passed',
    ], { cwd: repo, env });
    const evidence = initialized.status === 0 && finished.status === 0
      ? readJson(evidencePath)
      : null;
    check(initialized.status === 0 && started.status === 0 && finished.status === 0 &&
      forged.status !== 0 &&
      evidence?.run.status === 'inconsistent' &&
      evidence?.consistency.changed_sections.includes('summary_counts') &&
      evidence?.consistency.changed_sections.includes('summary_status'),
    'a failed suite cannot be finalized as passed with forged passed/failed counts');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

{
  const { repo, fakeClaude } = makeRepo();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-evidence-strict-rollup-'));
  const evidencePath = path.join(outputDir, 'evidence.json');
  const env = fixtureEnv(repo, fakeClaude);
  try {
    const initialized = runCli([
      'init',
      '--path', evidencePath,
      '--repo', repo,
      '--mode', 'live',
    ], { cwd: repo, env });
    const blocked = runCli([
      'suite-start',
      '--path', evidencePath,
      '--kind', 'live',
      '--label', 'blocked fixture suite',
    ], { cwd: repo, env });
    const blockedFinished = runCli([
      'suite-finish',
      '--path', evidencePath,
      '--id', blocked.stdout.trim(),
      '--status', 'blocked',
      '--exit-code', '2',
      '--reason', 'quota',
    ], { cwd: repo, env });
    const skipped = runCli([
      'suite-start',
      '--path', evidencePath,
      '--kind', 'live',
      '--label', 'skipped fixture suite',
    ], { cwd: repo, env });
    const skippedFinished = runCli([
      'suite-finish',
      '--path', evidencePath,
      '--id', skipped.stdout.trim(),
      '--status', 'skipped',
      '--reason', 'missing_credential',
    ], { cwd: repo, env });
    const finalized = runCli([
      'finalize',
      '--path', evidencePath,
      '--repo', repo,
      '--passed', '0',
      '--failed', '2',
      '--skipped', '1',
      '--blocked', '1',
      '--status', 'failed',
    ], { cwd: repo, env });
    const evidence = initialized.status === 0 &&
      blockedFinished.status === 0 && skippedFinished.status === 0
      ? readJson(evidencePath)
      : null;
    check(initialized.status === 0 && blocked.status === 0 &&
      blockedFinished.status === 0 && skipped.status === 0 &&
      skippedFinished.status === 0 && finalized.status === 0 &&
      evidence?.run.status === 'failed' &&
      evidence?.consistency.consistent === true,
    'strict failed rollup may include all blocked and skipped suite outcomes');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

{
  const { repo, fakeClaude } = makeRepo();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-evidence-unfinished-'));
  const evidencePath = path.join(outputDir, 'evidence.json');
  const env = fixtureEnv(repo, fakeClaude);
  try {
    const initialized = runCli([
      'init',
      '--path', evidencePath,
      '--repo', repo,
      '--mode', 'hermetic',
    ], { cwd: repo, env });
    const started = runCli([
      'suite-start',
      '--path', evidencePath,
      '--kind', 'ordinary',
      '--label', 'unfinished fixture suite',
    ], { cwd: repo, env });
    const finalized = runCli([
      'finalize',
      '--path', evidencePath,
      '--repo', repo,
      '--passed', '0',
      '--failed', '0',
      '--skipped', '0',
      '--blocked', '0',
      '--status', 'passed',
    ], { cwd: repo, env });
    const evidence = initialized.status === 0 && started.status === 0
      ? readJson(evidencePath)
      : null;
    check(initialized.status === 0 && started.status === 0 &&
      finalized.status !== 0 &&
      evidence?.run.status === 'inconsistent' &&
      evidence?.consistency.changed_sections.includes('suite_records'),
    'unfinished suite records prevent aggregate finalization');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

{
  const { repo, fakeClaude } = makeRepo();
  const env = fixtureEnv(repo, fakeClaude);
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-evidence-dirty-'));
  const evidencePath = path.join(evidenceDir, 'evidence.json');
  try {
    const clean = evidenceLib.captureRepository(repo);
    fs.appendFileSync(path.join(repo, 'tracked.txt'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'z-untracked.txt'), 'zeta\n');
    fs.writeFileSync(path.join(repo, 'a-untracked.txt'), 'alpha\n');
    const first = evidenceLib.captureRepository(repo);
    check(first.dirty === true && first.untracked_file_count === 2 &&
      first.tracked_diff_sha256 !== clean.tracked_diff_sha256,
    'dirty flag and tracked diff hash change for tracked plus untracked WIP');

    fs.rmSync(path.join(repo, 'a-untracked.txt'));
    fs.rmSync(path.join(repo, 'z-untracked.txt'));
    fs.writeFileSync(path.join(repo, 'a-untracked.txt'), 'alpha\n');
    fs.writeFileSync(path.join(repo, 'z-untracked.txt'), 'zeta\n');
    const reordered = evidenceLib.captureRepository(repo);
    check(reordered.untracked_content_sha256 === first.untracked_content_sha256 &&
      reordered.worktree_content_sha256 === first.worktree_content_sha256,
    'sorted untracked hashing is independent of creation order');

    fs.writeFileSync(path.join(repo, 'a-untracked.txt'), 'alpha changed\n');
    const mutated = evidenceLib.captureRepository(repo);
    check(mutated.untracked_content_sha256 !== first.untracked_content_sha256 &&
      mutated.worktree_content_sha256 !== first.worktree_content_sha256,
    'untracked content changes both its digest and combined worktree digest');

    fs.writeFileSync(path.join(repo, 'a-untracked.txt'), `${SECRET_CANARY}\n`);
    const initialized = runCli([
      'init',
      '--path', evidencePath,
      '--repo', repo,
      '--mode', 'hermetic',
    ], { cwd: repo, env });
    check(initialized.status === 0, 'dirty snapshot can be initialized without raw diff content');
    check(!fs.readFileSync(evidencePath, 'utf8').includes(SECRET_CANARY),
      'untracked secret canary contributes only a digest, never raw content');
    fs.appendFileSync(path.join(repo, 'tracked.txt'), 'changed after init\n');
    const inconsistent = runCli([
      'finalize',
      '--path', evidencePath,
      '--repo', repo,
      '--passed', '0',
      '--failed', '0',
      '--skipped', '0',
      '--blocked', '0',
      '--status', 'passed',
    ], { cwd: repo, env });
    const record = readJson(evidencePath);
    check(inconsistent.status !== 0 && record.run.status === 'inconsistent' &&
      record.consistency.consistent === false &&
      record.consistency.changed_sections.includes('repository'),
    'final snapshot mismatch is recorded and finalization fails closed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(evidenceDir, { recursive: true, force: true });
  }
}

{
  const { repo, fakeClaude } = makeRepo();
  const evidencePath = path.join(repo, '.run-evidence.json');
  const env = fixtureEnv(repo, fakeClaude);
  try {
    const initialized = runCli([
      'init',
      '--path', evidencePath,
      '--repo', repo,
      '--mode', 'hermetic',
    ], { cwd: repo, env });
    const finalized = runCli([
      'finalize',
      '--path', evidencePath,
      '--repo', repo,
      '--passed', '0',
      '--failed', '0',
      '--skipped', '0',
      '--blocked', '0',
      '--status', 'passed',
    ], { cwd: repo, env });
    const record = initialized.status === 0 ? readJson(evidencePath) : null;
    const after = initialized.status === 0
      ? evidenceLib.captureRepository(repo, evidencePath)
      : null;
    const changedFields = record && after
      ? Object.keys(after).filter(key =>
        after[key] !== record.initial_identity.repository[key])
      : [];
    check(initialized.status === 0 && finalized.status === 0,
      `an explicit evidence artifact inside the repository is excluded from its own snapshot` +
      ` (changed: ${record?.consistency?.changed_sections?.join(',') || 'none'}; fields: ${changedFields.join(',') || 'none'})`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
