#!/usr/bin/env node
'use strict';
// Behavioral self-test for test/run-all.sh's provider-aware outcome runner.
// It executes only the extracted shell functions against synthetic child
// commands; it never starts the repository suite or touches provider networks.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUN_ALL = path.join(__dirname, 'run-all.sh');
const TEST_SUPERVISOR = path.resolve(__dirname, '..', 'tools', 'run-with-hard-timeout.js');
const TEST_EVIDENCE_TOOL = path.resolve(__dirname, '..', 'tools', 'test-run-evidence.js');
const source = fs.readFileSync(RUN_ALL, 'utf8');
const functionsStart = source.indexOf('failure_log_root() {');
const functionsEnd = source.indexOf('\necho ""\necho "c-thru test suite"', functionsStart);
const functions = functionsStart >= 0 && functionsEnd > functionsStart
  ? source.slice(functionsStart, functionsEnd)
  : '';
const lockFunctionsStart = source.indexOf('resolve_test_lock_root() {');
const lockFunctionsEnd = source.indexOf(
  '\n# Full runs are exclusive',
  lockFunctionsStart,
);
const lockFunctions = lockFunctionsStart >= 0 && lockFunctionsEnd > lockFunctionsStart
  ? source.slice(lockFunctionsStart, lockFunctionsEnd)
  : '';

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}

function runFixture(name, strict, command, options = {}) {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), `c-thru-live-outcome-${name}-`));
  const logDir = path.join(logRoot, `c-thru-runall-${name}-fixture`);
  const shell = [
    'set -uo pipefail',
    'PASS=0',
    'FAIL=0',
    'SKIP=0',
    'BLOCKED=0',
    `STRICT_LIVE_PROVIDERS=${strict ? 1 : 0}`,
    `LIVE_SHARD=${shellQuote(options.liveShard || '')}`,
    `EVIDENCE_ENABLED=${options.evidencePath ? 1 : 0}`,
    'EVIDENCE_FAILURE=0',
    `TEST_SUPERVISOR=${shellQuote(TEST_SUPERVISOR)}`,
    `TEST_EVIDENCE_TOOL=${shellQuote(TEST_EVIDENCE_TOOL)}`,
    `TEST_EVIDENCE_PATH=${shellQuote(options.evidencePath || '/dev/null')}`,
    'TEST_TIMEOUT_SECONDS=5',
    functions,
    command,
    'printf "\\nCOUNTS PASS=%s FAIL=%s SKIP=%s BLOCKED=%s\\n" "$PASS" "$FAIL" "$SKIP" "$BLOCKED"',
  ].join('\n');
  const result = spawnSync('/bin/bash', ['-c', shell], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...options.env,
      TMPDIR: logRoot,
      C_THRU_TEST_FAILURE_LOG_DIR: logDir,
    },
    timeout: 15000,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    logDir,
    cleanup() { fs.rmSync(logRoot, { recursive: true, force: true }); },
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForPidGone(pid, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return !pidIsAlive(pid);
}

function checkShardResult(result, { markerCount, counts, absent, message }) {
  const markers = result.stdout.split(/\r?\n/)
    .filter(line => line.startsWith('C_THRU_LIVE_OUTCOME|'));
  assert(result.status === 0 && markers.length === markerCount,
    `${message}: selected commands execute exactly once`);
  assert(result.stdout.includes(counts),
    `${message}: counts include only the selected commands`);
  assert(absent.every(value => !result.stdout.includes(value)),
    `${message}: ordinary and opposite-shard calls are omitted`);
}

console.log('run-all live outcome protocol tests\n');
assert(
  functions.length > 0 &&
    functions.includes('allocate_failure_log_dir() {') &&
    functions.includes('FAIL_LOG_DIR=$(allocate_failure_log_dir)'),
  'provider-aware fixture extracts failure-log allocation helpers with the runner',
);

{
  const marker =
    'C_THRU_LIVE_OUTCOME|provider=test|suite=pass|status=passed|reason=all_mandatory_contracts_exercised';
  const r = runFixture(
    'pass',
    true,
    `run_live_suite test pass "pass fixture" /bin/bash -c 'printf "%s\\\\n" "${marker}"'`
  );
  try {
    assert(r.status === 0, `pass fixture shell exits 0 (got ${r.status}: ${r.stderr})`);
    assert(
      fs.statSync(r.logDir).isDirectory() &&
        (fs.statSync(r.logDir).mode & 0o777) === 0o700 &&
        r.stdout.includes(`C_THRU_TEST_FAILURE_LOG_DIR=${r.logDir}`),
      'extracted runner allocates and records its exact private fixture log directory',
    );
    assert(r.stdout.includes(marker), 'matching passed marker remains the terminal outcome');
    assert(r.stdout.includes('COUNTS PASS=1 FAIL=0 SKIP=0 BLOCKED=0'),
      'passed outcome increments only PASS');
  } finally { r.cleanup(); }
}

{
  const marker =
    'C_THRU_LIVE_OUTCOME|provider=agent|suite=agent-offload-coverage|status=passed|reason=advisory_scorecard_completed';
  const r = runFixture(
    'offload-advisory-pass-strict',
    true,
    `run_live_suite agent agent-offload-coverage "offload advisory fixture" /bin/bash -c 'printf "%s\\\\n" "${marker}"'`
  );
  try {
    assert(r.status === 0, 'completed advisory offload scorecard exits 0 through strict runner');
    assert(r.stdout.includes('COUNTS PASS=1 FAIL=0 SKIP=0 BLOCKED=0'),
      'strict runner counts a completed advisory offload scorecard as passed');
  } finally { r.cleanup(); }
}

{
  const marker =
    'C_THRU_LIVE_OUTCOME|provider=test|suite=opportunistic|status=passed|reason=all_mandatory_contracts_exercised_2_opportunistic_skips';
  const r = runFixture(
    'opportunistic-pass-strict',
    true,
    `run_live_suite test opportunistic "opportunistic fixture" /bin/bash -c 'printf "%s\\\\n" "${marker}"'`
  );
  try {
    assert(r.stdout.includes('COUNTS PASS=1 FAIL=0 SKIP=0 BLOCKED=0'),
      'opportunistic case skips do not turn a mandatory-complete child into a suite skip');
  } finally { r.cleanup(); }
}

{
  const marker =
    'C_THRU_LIVE_OUTCOME|provider=test|suite=skip|status=skipped|reason=1_mandatory_contract_not_exercised';
  const r = runFixture(
    'skipped-advisory',
    false,
    `run_live_suite test skip "skipped advisory fixture" /bin/bash -c 'printf "%s\\\\n" "${marker}"'`
  );
  try {
    assert(r.stdout.includes('SKIP'), 'mandatory skip is labeled SKIP, not passed');
    assert(r.stdout.includes('COUNTS PASS=0 FAIL=0 SKIP=1 BLOCKED=0'),
      'non-strict mandatory skip increments SKIP without failing');
  } finally { r.cleanup(); }
}

{
  const marker =
    'C_THRU_LIVE_OUTCOME|provider=test|suite=blocked|status=blocked|reason=quota';
  const r = runFixture(
    'blocked-advisory',
    false,
    `run_live_suite test blocked "blocked fixture" /bin/bash -c 'printf "%s\\\\n" "${marker}"; exit 2'`
  );
  try {
    assert(r.stdout.includes('BLOCKED'), 'blocked child is labeled BLOCKED, not passed');
    assert(r.stdout.includes('COUNTS PASS=0 FAIL=0 SKIP=0 BLOCKED=1'),
      'non-strict block increments BLOCKED without failing');
  } finally { r.cleanup(); }
}

{
  const marker =
    'C_THRU_LIVE_OUTCOME|provider=test|suite=blocked|status=blocked|reason=quota';
  const r = runFixture(
    'blocked-strict',
    true,
    `run_live_suite test blocked "blocked strict fixture" /bin/bash -c 'printf "%s\\\\n" "${marker}"; exit 2'`
  );
  try {
    assert(r.stdout.includes('COUNTS PASS=0 FAIL=1 SKIP=0 BLOCKED=1'),
      'strict block increments both FAIL and BLOCKED');
    assert(fs.readdirSync(r.logDir).some(name => name.endsWith('.log')),
      'strict block persists child output for diagnosis');
  } finally { r.cleanup(); }
}

{
  const marker =
    'C_THRU_LIVE_OUTCOME|provider=test|suite=skip|status=skipped|reason=missing_key';
  const r = runFixture(
    'skipped-strict',
    true,
    `run_live_suite test skip "skipped strict fixture" /bin/bash -c 'printf "%s\\\\n" "${marker}"; exit 2'`
  );
  try {
    assert(r.stdout.includes('COUNTS PASS=0 FAIL=1 SKIP=1 BLOCKED=0'),
      'strict requested skip increments both FAIL and SKIP');
  } finally { r.cleanup(); }
}

{
  const r = runFixture(
    'missing-marker-exit-zero',
    false,
    'run_live_suite test missing "missing marker fixture" /bin/bash -c \'exit 0\''
  );
  try {
    assert(r.stdout.includes('|status=failed|reason=missing_outcome_marker_exit_0'),
      'exit 0 without a child marker is a protocol failure, never a synthesized pass');
    assert(r.stdout.includes('COUNTS PASS=0 FAIL=1 SKIP=0 BLOCKED=0'),
      'missing marker increments FAIL even outside strict mode');
  } finally { r.cleanup(); }
}

{
  const r = runFixture(
    'missing-marker-nonzero',
    false,
    'run_live_suite test crash "crash fixture" /bin/bash -c \'exit 37\''
  );
  try {
    assert(r.stdout.includes('|status=failed|reason=missing_outcome_marker_exit_37'),
      'non-zero child without a marker records both the protocol defect and exit code');
    assert(r.stdout.includes('COUNTS PASS=0 FAIL=1 SKIP=0 BLOCKED=0'),
      'non-zero child without a marker increments FAIL');
  } finally { r.cleanup(); }
}

{
  const marker =
    'C_THRU_LIVE_OUTCOME|provider=test|suite=failed|status=failed|reason=assertions_failed';
  const r = runFixture(
    'failed-marker-exit-zero',
    false,
    `run_live_suite test failed "failed marker fixture" /bin/bash -c 'printf "%s\\\\n" "${marker}"'`
  );
  try {
    assert(r.stdout.includes('|status=failed|reason=failed_outcome_with_exit_0'),
      'failed marker with exit 0 is rejected as exit-incoherent');
    assert(r.stdout.includes('COUNTS PASS=0 FAIL=1 SKIP=0 BLOCKED=0'),
      'failed-marker/exit-zero mismatch increments FAIL');
  } finally { r.cleanup(); }
}

{
  const marker =
    'C_THRU_LIVE_OUTCOME|provider=test|suite=pass-crash|status=passed|reason=all_mandatory_contracts_exercised';
  const r = runFixture(
    'passed-marker-nonzero',
    false,
    `run_live_suite test pass-crash "passed marker crash fixture" /bin/bash -c 'printf "%s\\\\n" "${marker}"; exit 37'`
  );
  try {
    assert(r.stdout.includes('|status=failed|reason=passed_outcome_with_exit_37'),
      'non-zero exit cannot be hidden by a passed marker');
    assert(r.stdout.includes('COUNTS PASS=0 FAIL=1 SKIP=0 BLOCKED=0'),
      'passed-marker/non-zero mismatch increments FAIL');
  } finally { r.cleanup(); }
}

{
  const marker =
    'C_THRU_LIVE_OUTCOME|provider=test|suite=duplicate|status=passed|reason=all_mandatory_contracts_exercised';
  const r = runFixture(
    'duplicate-markers',
    false,
    `run_live_suite test duplicate "duplicate marker fixture" /bin/bash -c 'printf "%s\\\\n%s\\\\n" "${marker}" "${marker}"'`
  );
  try {
    assert(r.stdout.includes('|status=failed|reason=multiple_outcome_markers_2_exit_0'),
      'multiple terminal markers are rejected as ambiguous');
    assert(r.stdout.includes('COUNTS PASS=0 FAIL=1 SKIP=0 BLOCKED=0'),
      'duplicate markers increment FAIL');
  } finally { r.cleanup(); }
}

{
  const marker =
    'C_THRU_LIVE_OUTCOME|provider=wrong|suite=mismatch|status=passed|reason=all_mandatory_contracts_exercised';
  const r = runFixture(
    'mismatched-marker',
    false,
    `run_live_suite test mismatch "mismatched marker fixture" /bin/bash -c 'printf "%s\\\\n" "${marker}"'`
  );
  try {
    assert(r.stdout.includes('|status=failed|reason=invalid_or_mismatched_outcome_marker_exit_0'),
      'provider/suite mismatch is rejected');
    assert(r.stdout.includes('COUNTS PASS=0 FAIL=1 SKIP=0 BLOCKED=0'),
      'mismatched marker increments FAIL');
  } finally { r.cleanup(); }
}

{
  const r = runFixture(
    'missing-credential',
    true,
    'block_live_suite openai live "missing credential fixture" "missing OPENAI_API_KEY"'
  );
  try {
    assert(r.stdout.includes('|status=blocked|reason=missing_OPENAI_API_KEY'),
      'missing credential emits sanitized blocked outcome');
    assert(r.stdout.includes('COUNTS PASS=0 FAIL=1 SKIP=0 BLOCKED=1'),
      'strict missing credential increments both FAIL and BLOCKED');
  } finally { r.cleanup(); }
}

{
  const selectionMarker =
    'C_THRU_LIVE_OUTCOME|provider=anthropic|suite=agent-selection-llm-judge|status=passed|reason=selected';
  const agentMarker =
    'C_THRU_LIVE_OUTCOME|provider=agent|suite=agent-contract-live|status=passed|reason=selected';
  const command = [
    'run_suite "ordinary omitted" /bin/false',
    'skip_suite "ordinary skip omitted"',
    `run_live_suite anthropic agent-selection-llm-judge "selection selected" /bin/bash -c 'printf "%s\\\\n" "${selectionMarker}"'`,
    `run_live_suite agent agent-contract-live "agent selected" /bin/bash -c 'printf "%s\\\\n" "${agentMarker}"'`,
    'run_live_suite gemini provider-only "provider omitted" /bin/false',
    'block_live_suite openai provider-blocked "provider block omitted" quota',
  ].join('\n');
  const r = runFixture('agent-shard', false, command, { liveShard: 'agent' });
  try {
    checkShardResult(r, {
      markerCount: 2,
      counts: 'COUNTS PASS=2 FAIL=0 SKIP=0 BLOCKED=0',
      absent: ['ordinary omitted', 'ordinary skip omitted', 'provider omitted', 'provider block omitted'],
      message: 'agent shard selects only provider=agent plus agent-selection-llm-judge',
    });
  } finally { r.cleanup(); }
}

{
  const providerMarker =
    'C_THRU_LIVE_OUTCOME|provider=gemini|suite=provider-only|status=passed|reason=selected';
  const command = [
    'run_suite "ordinary omitted" /bin/false',
    'skip_suite "ordinary skip omitted"',
    'run_live_suite anthropic agent-selection-llm-judge "selection omitted" /bin/false',
    'run_live_suite agent agent-contract-live "agent omitted" /bin/false',
    `run_live_suite gemini provider-only "provider selected" /bin/bash -c 'printf "%s\\\\n" "${providerMarker}"'`,
    'block_live_suite openai provider-blocked "provider block selected" quota',
  ].join('\n');
  const r = runFixture('provider-shard', false, command, { liveShard: 'provider' });
  try {
    checkShardResult(r, {
      markerCount: 2,
      counts: 'COUNTS PASS=1 FAIL=0 SKIP=0 BLOCKED=1',
      absent: ['ordinary omitted', 'ordinary skip omitted', 'selection omitted', 'agent omitted'],
      message: 'provider shard selects every remaining live protocol suite',
    });
  } finally { r.cleanup(); }
}

{
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-runner-evidence-'));
  const evidencePath = path.join(evidenceDir, 'evidence.json');
  const repo = path.resolve(__dirname, '..');
  const initialized = spawnSync(process.execPath, [
    TEST_EVIDENCE_TOOL,
    'init',
    '--path', evidencePath,
    '--repo', repo,
    '--mode', 'extracted-runner',
  ], { encoding: 'utf8', timeout: 15000 });
  const marker =
    'C_THRU_LIVE_OUTCOME|provider=test|suite=evidence-live|status=passed|reason=SECRET_CANARY_DO_NOT_PERSIST_7f31';
  const r = runFixture(
    'incremental-evidence',
    false,
    [
      'run_suite "ordinary evidence pass" /bin/bash -c \'exit 0\'',
      `run_live_suite test evidence-live "live evidence pass" /bin/bash -c 'printf "%s\\\\n" "${marker}"'`,
      'block_live_suite test evidence-block "blocked evidence" quota',
      'skip_suite "skipped evidence"',
    ].join('\n'),
    { evidencePath },
  );
  try {
    const evidence = initialized.status === 0 ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) : null;
    assert(initialized.status === 0 && r.status === 0,
      `extracted runner writes incremental evidence (${initialized.stderr || r.stderr})`);
    assert(evidence && evidence.suites.map(record => record.status).join(',') ===
      'passed,passed,blocked,skipped',
    'ordinary/live/block/skip runner paths finish sanitized evidence records');
    assert(evidence && evidence.suites.every(record =>
      record.finished_at && record.status !== 'running' &&
      Number.isInteger(record.duration_ms) && record.duration_ms >= 0 &&
      !Object.prototype.hasOwnProperty.call(record, 'output')),
    'runner evidence contains terminal metadata but no child output');
    assert(evidence &&
      evidence.suites[0].reason === null &&
      evidence.suites[1].reason === 'redacted_sensitive_reason' &&
      evidence.suites[2].reason === 'quota' &&
      !fs.readFileSync(evidencePath, 'utf8').includes('SECRET_CANARY_DO_NOT_PERSIST_7f31'),
    'runner stores safe terminal reasons and redacts secret-shaped child reasons');
  } finally {
    r.cleanup();
    fs.rmSync(evidenceDir, { recursive: true, force: true });
  }
}

{
  const invalid = spawnSync('/bin/bash', [RUN_ALL, '--skip-smoke'], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      C_THRU_LIVE_SHARD: 'invalid',
      C_THRU_TEST_TIMEOUT_SECONDS: '30',
    },
  });
  assert(invalid.status === 2 &&
    invalid.stderr.includes('C_THRU_LIVE_SHARD must be provider or agent'),
  'invalid live shard exits 2 before running suites');
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-hermetic-no-lock-'));
  const invalidLockRoot = path.join(scratch, 'invalid-lock-root');
  const evidencePath = path.join(scratch, 'evidence.json');
  const failureLogDir = path.join(scratch, 'c-thru-runall-hermetic-no-lock');
  fs.mkdirSync(invalidLockRoot, { mode: 0o700 });
  fs.chmodSync(invalidLockRoot, 0o755);
  try {
    const result = spawnSync('/bin/bash', [RUN_ALL, '--skip-smoke'], {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        TMPDIR: scratch,
        C_THRU_LIVE_SHARD: 'agent',
        C_THRU_TEST_LOCK_ROOT: invalidLockRoot,
        C_THRU_TEST_EVIDENCE_PATH: evidencePath,
        C_THRU_TEST_FAILURE_LOG_DIR: failureLogDir,
        C_THRU_TEST_TIMEOUT_SECONDS: '30',
      },
    });
    assert(result.status === 0 &&
      !result.stderr.includes('C_THRU_TEST_LOCK_ROOT') &&
      fs.existsSync(evidencePath),
    `--skip-smoke does not resolve or require the full-run lock root (${result.stderr.trim()})`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-early-evidence-lock-'));
  const lockRoot = path.join(scratch, 'stable-lock-root');
  const lockDir = path.join(lockRoot, 'c-thru-run-all.lock');
  const evidencePath = path.join(scratch, 'evidence.json');
  const runPidPath = path.join(scratch, 'run.pid');
  const descendantPidPath = path.join(scratch, 'descendant.pid');
  const commandSecret = 'SECRET_CANARY_RAW_COMMAND_EARLY_LOCK_9c2d';
  fs.mkdirSync(lockRoot, { mode: 0o700 });
  fs.mkdirSync(lockDir, { mode: 0o700 });
  fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
  try {
    const result = spawnSync(process.execPath, [
      TEST_SUPERVISOR,
      '--timeout-seconds', '5',
      '--',
      '/bin/bash', '-c',
      [
        `"$4" -e 'const fs=require("fs");` +
          `fs.writeFileSync(process.argv[1],String(process.pid));` +
          `setInterval(()=>{},1000)' "$2" >/dev/null 2>&1 &`,
        'printf "%s\\n" "$$" > "$1"',
        'exec /bin/bash "$3" "$5"',
      ].join('\n'),
      'early-evidence-lock-wrapper',
      runPidPath,
      descendantPidPath,
      RUN_ALL,
      process.execPath,
      commandSecret,
    ], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        TMPDIR: scratch,
        C_THRU_LIVE_SHARD: 'agent',
        C_THRU_TEST_LOCK_ROOT: lockRoot,
        C_THRU_TEST_EVIDENCE_PATH: evidencePath,
        C_THRU_TEST_TIMEOUT_SECONDS: '300',
      },
    });
    const runPid = fs.existsSync(runPidPath)
      ? Number(fs.readFileSync(runPidPath, 'utf8'))
      : null;
    const descendantPid = fs.existsSync(descendantPidPath)
      ? Number(fs.readFileSync(descendantPidPath, 'utf8'))
      : null;
    let evidence = null;
    let evidenceRaw = '';
    try {
      evidenceRaw = fs.readFileSync(evidencePath, 'utf8');
      evidence = JSON.parse(evidenceRaw);
    } catch {}

    assert(result.status === 124 && !result.error,
      `held full/live lock reaches the hard deadline with exit 124 (got ${result.status})`);
    assert(evidence &&
      evidence.schema_id === 'c-thru-test-run-evidence' &&
      evidence.run.status === 'running' &&
      evidence.run.mode === 'live-agent' &&
      evidence.run.live_shard === 'agent' &&
      evidence.consistency.checked === false,
    'configured aggregate evidence is parseable and running before the live-shard lock wait');
    assert(!evidenceRaw.includes(commandSecret),
      'early aggregate evidence does not retain a raw command secret');
    assert(waitForPidGone(runPid) && waitForPidGone(descendantPid),
      'hard timeout reaps the waiting aggregate and its owned descendant');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-shared-lock-'));
  const lockRoot = path.join(scratch, 'lock-root');
  const tmpOne = path.join(scratch, 'tmp-one');
  const tmpTwo = path.join(scratch, 'tmp-two');
  const events = path.join(scratch, 'events');
  const unrelatedRootFile = path.join(lockRoot, 'unrelated.keep');
  const unrelatedSibling = path.join(scratch, 'unrelated-sibling.keep');
  const harnessPath = path.join(scratch, 'lock-contender.sh');
  const orchestratorPath = path.join(scratch, 'orchestrate.sh');
  const resolverPath = path.join(scratch, 'resolve-lock.sh');
  const fixtureHome = path.join(scratch, 'home');
  const invalidRoot = path.join(scratch, 'invalid-root');
  fs.mkdirSync(lockRoot, { mode: 0o700 });
  fs.mkdirSync(tmpOne, { mode: 0o700 });
  fs.mkdirSync(tmpTwo, { mode: 0o700 });
  fs.mkdirSync(events, { mode: 0o700 });
  fs.mkdirSync(fixtureHome, { mode: 0o700 });
  fs.mkdirSync(invalidRoot, { mode: 0o700 });
  fs.chmodSync(invalidRoot, 0o755);
  fs.writeFileSync(unrelatedRootFile, 'keep\n');
  fs.writeFileSync(unrelatedSibling, 'keep\n');
  try {
    assert(lockFunctions.length > 0,
      'run-all exposes stable lock-root resolution before full-run acquisition');
    if (lockFunctions.length > 0) {
      fs.writeFileSync(resolverPath, [
        '#!/usr/bin/env bash',
        'set -uo pipefail',
        lockFunctions,
        'LOCK_ROOT=$(resolve_test_lock_root) || exit 1',
        'printf "%s\\n" "$LOCK_ROOT"',
      ].join('\n'));
      const defaultEnv = { ...process.env, HOME: fixtureHome };
      delete defaultEnv.C_THRU_TEST_LOCK_ROOT;
      const defaultOne = spawnSync('/bin/bash', [resolverPath], {
        encoding: 'utf8',
        env: { ...defaultEnv, TMPDIR: tmpOne },
        timeout: 5000,
      });
      const defaultTwo = spawnSync('/bin/bash', [resolverPath], {
        encoding: 'utf8',
        env: { ...defaultEnv, TMPDIR: tmpTwo },
        timeout: 5000,
      });
      const expectedDefault = path.join(
        fs.realpathSync(fixtureHome),
        '.claude',
        'c-thru-run-locks',
      );
      assert(defaultOne.status === 0 && defaultTwo.status === 0 &&
        defaultOne.stdout.trim() === expectedDefault &&
        defaultTwo.stdout.trim() === expectedDefault &&
        (fs.statSync(expectedDefault).mode & 0o777) === 0o700,
      'default lock root is stable and private across distinct TMPDIR values');
      const invalidOverride = spawnSync('/bin/bash', [resolverPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TMPDIR: tmpOne,
          C_THRU_TEST_LOCK_ROOT: invalidRoot,
        },
        timeout: 5000,
      });
      assert(invalidOverride.status !== 0 &&
        invalidOverride.stderr.includes('must have mode 0700'),
      'explicit lock-root override rejects a non-private directory');

      fs.writeFileSync(harnessPath, [
        '#!/usr/bin/env bash',
        'set -uo pipefail',
        lockFunctions,
        'prepare_full_run_lock',
        'printf "%s\\n" "$$" > "$EVENT_DIR/$CONTENDER.acquired"',
        'sleep "$HOLD_SECONDS"',
        'release_lock',
        'LOCK_HELD=""',
        'printf "%s\\n" "$$" > "$EVENT_DIR/$CONTENDER.released"',
      ].join('\n'));
      fs.writeFileSync(orchestratorPath, [
        '#!/usr/bin/env bash',
        'set -uo pipefail',
        'harness="$1"; lock_root="$2"; tmp_one="$3"; tmp_two="$4"; events="$5"',
        'env TMPDIR="$tmp_one" C_THRU_TEST_LOCK_ROOT="$lock_root" ' +
          'EVENT_DIR="$events" CONTENDER=one HOLD_SECONDS=1 ' +
          '/bin/bash "$harness" >"$events/one.out" 2>"$events/one.err" &',
        'one_pid=$!',
        'attempt=0',
        'while [[ ! -f "$events/one.acquired" && $attempt -lt 100 ]]; do',
        '  kill -0 "$one_pid" 2>/dev/null || break',
        '  sleep 0.05',
        '  attempt=$(( attempt + 1 ))',
        'done',
        '[[ -f "$events/one.acquired" ]] || exit 71',
        '(stat -f %Lp "$lock_root/c-thru-run-all.lock" 2>/dev/null || ' +
          'stat -c %a "$lock_root/c-thru-run-all.lock") > "$events/lock.mode"',
        'env TMPDIR="$tmp_two" C_THRU_TEST_LOCK_ROOT="$lock_root" ' +
          'EVENT_DIR="$events" CONTENDER=two HOLD_SECONDS=0 ' +
          '/bin/bash "$harness" >"$events/two.out" 2>"$events/two.err" &',
        'two_pid=$!',
        'wait "$one_pid"; one_status=$?',
        'wait "$two_pid"; two_status=$?',
        'printf "%s %s\\n" "$one_status" "$two_status"',
      ].join('\n'));
      const result = spawnSync('/bin/bash', [
        orchestratorPath,
        harnessPath,
        lockRoot,
        tmpOne,
        tmpTwo,
        events,
      ], {
        encoding: 'utf8',
        timeout: 20000,
        env: { ...process.env },
      });
      const oneReleased = path.join(events, 'one.released');
      const twoAcquired = path.join(events, 'two.acquired');
      const secondOutput = fs.existsSync(path.join(events, 'two.out'))
        ? fs.readFileSync(path.join(events, 'two.out'), 'utf8')
        : '';
      assert(result.status === 0 && result.stdout.trim() === '0 0',
        `distinct-TMPDIR contenders share one lock root (${result.stderr.trim()})`);
      assert(fs.existsSync(oneReleased) && fs.existsSync(twoAcquired) &&
        secondOutput.includes('waiting for concurrent run-all.sh') &&
        fs.statSync(twoAcquired).mtimeMs >= fs.statSync(oneReleased).mtimeMs,
      'contender two waits for contender one to release before acquiring');
      assert(fs.readFileSync(path.join(events, 'lock.mode'), 'utf8').trim() === '700' &&
        (fs.statSync(lockRoot).mode & 0o777) === 0o700 &&
        fs.statSync(lockRoot).uid === process.getuid(),
      'shared lock root and active lock leaf are private and user-owned');
      assert(!fs.existsSync(path.join(lockRoot, 'c-thru-run-all.lock')) &&
        fs.readFileSync(unrelatedRootFile, 'utf8') === 'keep\n' &&
        fs.readFileSync(unrelatedSibling, 'utf8') === 'keep\n',
      'lock cleanup removes only its owned leaf and preserves unrelated paths');
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const convertedAgentChildren = [
  ['agent-contract-behavioral', 'C_THRU_BEHAVIORAL_TESTS'],
  ['agent-contract-live', 'C_THRU_LIVE_AGENT_TESTS'],
  ['claude-agent-route-live', 'C_THRU_LIVE_CLAUDE_AGENT_ROUTE'],
  ['agent-offload-coverage', 'C_THRU_OFFLOAD'],
];
for (const [suite, gate] of convertedAgentChildren) {
  const child = path.join(__dirname, suite === 'agent-offload-coverage'
    ? `${suite}.js`
    : `${suite}.test.js`);
  const command = [
    'run_live_suite', 'agent', suite, shellQuote(`${suite} gate-off fixture`),
    '/usr/bin/env', `${gate}=0`, shellQuote(process.execPath), shellQuote(child),
  ].join(' ');
  const r = runFixture(`${suite}-strict-gate-off`, true, command);
  try {
    const markers = r.stdout.split(/\r?\n/)
      .filter(line => line.startsWith('C_THRU_LIVE_OUTCOME|'));
    assert(markers.length === 1 && markers[0].startsWith(
      `C_THRU_LIVE_OUTCOME|provider=agent|suite=${suite}|status=skipped|`,
    ), `${suite} emits exactly one matching gate-off marker through the runner`);
    assert(r.stdout.includes('COUNTS PASS=0 FAIL=1 SKIP=1 BLOCKED=0'),
      `${suite} gate-off cannot false-green a strict aggregate`);
  } finally { r.cleanup(); }
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
