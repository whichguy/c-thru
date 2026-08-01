#!/usr/bin/env node
'use strict';

// POSIX wall-clock supervisor used by c-thru's test entrypoints. The child gets
// a fresh process group, so TERM/KILL escalation is scoped to this invocation
// and cannot hit concurrent test runs.

const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  CAPABILITY_CHILD_FD,
  CAPABILITY_FD_ENV,
  CAPABILITY_NONCE_ENV,
  createTestSupervisorCapability,
} = require('./test-supervisor-capability');

const DEFAULT_TIMEOUT_SECONDS = 3600;
const MAX_TIMEOUT_SECONDS = 3600;
const TIMEOUT_EXIT_CODE = 124;
const BOOTSTRAP_CHILD_FD = 4;
const BOOTSTRAP_BYTES = 64;
const BOOTSTRAP_MARKER_ENV = 'C_THRU_TEST_TIMEOUT_BOOTSTRAP';
const BOOTSTRAP_PARENT_PID_ENV = 'C_THRU_TEST_TIMEOUT_BOOTSTRAP_PARENT_PID';
const BOOTSTRAP_FD_ENV = 'C_THRU_TEST_TIMEOUT_BOOTSTRAP_FD';
const BOOTSTRAP_NONCE_ENV = 'C_THRU_TEST_TIMEOUT_BOOTSTRAP_NONCE';
const BOOTSTRAP_DEADLINE_ENV = 'C_THRU_TEST_TIMEOUT_BOOTSTRAP_DEADLINE_EPOCH_MS';
const SIGNAL_EXIT_CODES = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
  SIGKILL: 137,
});

function failUsage(message) {
  console.error(`run-with-hard-timeout: ${message}`);
  process.exit(2);
}

function parseTimeoutSeconds(raw) {
  if (!/^[1-9]\d*$/.test(raw || '')) {
    failUsage(`timeout must be an integer from 1 to ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_TIMEOUT_SECONDS) {
    failUsage(`timeout must be an integer from 1 to ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return value;
}

function inheritedDeadlineUpperBound(env) {
  if (env.C_THRU_TEST_SUPERVISED !== '1') return null;
  const raw = env.C_THRU_TEST_DEADLINE_EPOCH_MS || '';
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function parseArgs(argv) {
  let timeoutRaw = process.env.C_THRU_TEST_TIMEOUT_SECONDS ||
    String(DEFAULT_TIMEOUT_SECONDS);
  let index = 0;
  if (argv[index] === '--timeout-seconds') {
    timeoutRaw = argv[index + 1];
    index += 2;
  }
  if (argv[index] !== '--') {
    failUsage('expected -- before the child command');
  }
  const command = argv[index + 1];
  const args = argv.slice(index + 2);
  if (!command) failUsage('child command is required');
  return {
    timeoutSeconds: parseTimeoutSeconds(timeoutRaw),
    command,
    args,
  };
}

function exitCodeForOutcome(code, signal) {
  if (Number.isInteger(code)) return code;
  return SIGNAL_EXIT_CODES[signal] || 1;
}

function consumeBootstrapCapability(env = process.env) {
  if (env[BOOTSTRAP_MARKER_ENV] !== '1') return null;
  const parentPid = Number(env[BOOTSTRAP_PARENT_PID_ENV]);
  const fd = Number(env[BOOTSTRAP_FD_ENV]);
  const nonce = env[BOOTSTRAP_NONCE_ENV] || '';
  const deadlineAt = Number(env[BOOTSTRAP_DEADLINE_ENV]);
  const now = Date.now();
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid !== process.ppid ||
    !Number.isSafeInteger(fd) ||
    fd !== BOOTSTRAP_CHILD_FD ||
    !/^[a-f0-9]{64}$/.test(nonce) ||
    !Number.isSafeInteger(deadlineAt) ||
    deadlineAt <= now ||
    deadlineAt - now > MAX_TIMEOUT_SECONDS * 1000
  ) {
    return null;
  }

  let stats;
  try {
    process.kill(parentPid, 0);
    stats = fs.fstatSync(fd);
  } catch {
    return null;
  }
  if (!stats.isFIFO() && !stats.isSocket()) return null;

  const actual = Buffer.alloc(BOOTSTRAP_BYTES + 1);
  let bytesRead;
  try {
    bytesRead = fs.readSync(fd, actual, 0, actual.length, null);
    fs.closeSync(fd);
  } catch {
    return null;
  }
  if (bytesRead !== BOOTSTRAP_BYTES) return null;
  if (!crypto.timingSafeEqual(
    actual.subarray(0, BOOTSTRAP_BYTES),
    Buffer.from(nonce, 'ascii'),
  )) {
    return null;
  }
  return deadlineAt;
}

function bootstrapWorkerEnv(env, deadlineAt) {
  const childEnv = { ...env };
  for (const key of [
    BOOTSTRAP_MARKER_ENV,
    BOOTSTRAP_PARENT_PID_ENV,
    BOOTSTRAP_FD_ENV,
    BOOTSTRAP_NONCE_ENV,
    BOOTSTRAP_DEADLINE_ENV,
  ]) {
    delete childEnv[key];
  }
  childEnv.C_THRU_TEST_SUPERVISED = '1';
  childEnv.C_THRU_TEST_DEADLINE_EPOCH_MS = String(deadlineAt);
  childEnv.C_THRU_TEST_SUPERVISOR_PID = String(process.pid);
  return childEnv;
}

function runBootstrapWorker() {
  const deadlineAt = consumeBootstrapCapability();
  if (deadlineAt === null) {
    console.error('run-with-hard-timeout: invalid internal bootstrap capability');
    process.exit(125);
  }
  const { command, args } = parseArgs(process.argv.slice(1));

  let capability;
  try {
    capability = createTestSupervisorCapability();
  } catch (error) {
    console.error(
      `run-with-hard-timeout: failed to create child capability: ${error.message}`,
    );
    process.exit(127);
  }

  let child;
  try {
    const childStdio = ['inherit', 'inherit', 'inherit'];
    childStdio[CAPABILITY_CHILD_FD] = capability.fd;
    child = spawn(command, args, {
      detached: false,
      stdio: childStdio,
      env: {
        ...bootstrapWorkerEnv(process.env, deadlineAt),
        [CAPABILITY_FD_ENV]: String(CAPABILITY_CHILD_FD),
        [CAPABILITY_NONCE_ENV]: capability.nonce,
      },
    });
  } catch (error) {
    try { fs.closeSync(capability.fd); } catch {}
    console.error(`run-with-hard-timeout: failed to launch child: ${error.message}`);
    process.exit(127);
  }
  try { fs.closeSync(capability.fd); } catch {}

  let launchFailed = false;
  child.once('error', error => {
    launchFailed = true;
    console.error(`run-with-hard-timeout: failed to launch child: ${error.message}`);
    process.exitCode = 127;
  });
  child.once('close', (code, signal) => {
    if (!launchFailed) process.exitCode = exitCodeForOutcome(code, signal);
  });
}

function runPublicSupervisor() {
  const startedAt = Date.now();
  const { timeoutSeconds } = parseArgs(process.argv.slice(2));
  const timeoutMs = timeoutSeconds * 1000;
  const requestedDeadlineAt = startedAt + timeoutMs;
  const inheritedDeadlineAt = inheritedDeadlineUpperBound(process.env);

  // The capability proves that a direct child is already supervised. The ambient
  // deadline has a different, monotonic role: it may only shorten this new
  // supervisor's requested budget. A forged earlier value therefore fails closed,
  // while a forged later value cannot extend the requested timeout.
  const deadlineAt = inheritedDeadlineAt === null
    ? requestedDeadlineAt
    : Math.min(requestedDeadlineAt, inheritedDeadlineAt);
  const effectiveTimeoutMs = deadlineAt - startedAt;
  if (effectiveTimeoutMs <= 0) {
    console.error('run-with-hard-timeout: inherited test deadline has already expired');
    process.exit(TIMEOUT_EXIT_CODE);
  }

  // Reserve time inside the advertised deadline for escalation and supervisor
  // exit. For a one-second regression this is 100ms; for a one-hour test it is
  // 500ms. TERM gets up to two seconds before KILL.
  const exitMarginMs = Math.min(
    500,
    Math.max(50, Math.floor(effectiveTimeoutMs / 10)),
  );
  const killAt = deadlineAt - exitMarginMs;
  const termGraceMs = Math.min(
    2000,
    Math.max(100, Math.floor(Math.min(effectiveTimeoutMs, 8000) / 4)),
  );
  const termAt = Math.max(startedAt, killAt - termGraceMs);
  const forceExitAt = deadlineAt - Math.max(10, Math.floor(exitMarginMs / 4));

  let child = null;
  let settled = false;
  let timedOut = false;
  let forwardedSignal = null;
  let childOutcome = null;
  const timers = new Set();

  function scheduleAt(epochMs, fn) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, Math.max(0, epochMs - Date.now()));
    timers.add(timer);
    return timer;
  }

  function scheduleAfter(delayMs, fn) {
    return scheduleAt(Date.now() + delayMs, fn);
  }

  function clearTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  function groupExists() {
    if (!child?.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
      throw error;
    }
  }

  function signalGroup(signal) {
    if (!child?.pid) return false;
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      // The group can disappear after groupExists() and its numeric PGID can
      // race with an unowned group. EPERM means we can no longer prove that the
      // target is our killable child group; never crash a successful test or
      // signal a potentially unrelated group in that window.
      if (error.code === 'EPERM') return false;
      throw error;
    }
  }

  function finish(exitCode) {
    if (settled) return;
    settled = true;
    clearTimers();
    process.exitCode = exitCode;
  }

  function finishAfterOwnedGroupCleanup(exitCode) {
    if (settled) return;
    if (!groupExists()) {
      finish(exitCode);
      return;
    }

    // The direct child may exit after launching a background descendant that
    // still owns stdout/stderr. Reap the whole owned group so command
    // substitution cannot hang after an apparently successful child exit.
    signalGroup('SIGTERM');
    const cleanupGraceMs = Math.min(250, Math.max(25, Math.floor(exitMarginMs / 2)));
    scheduleAfter(cleanupGraceMs, () => {
      signalGroup('SIGKILL');
      scheduleAfter(25, () => finish(exitCode));
    });
  }

  scheduleAt(termAt, () => {
    if (settled || childOutcome) return;
    timedOut = true;
    console.error(
      `run-with-hard-timeout: timeout budget ending at ${deadlineAt}; ` +
      `terminating child process group ${child?.pid || 'pending'}`,
    );
    signalGroup('SIGTERM');
  });

  scheduleAt(killAt, () => {
    if (settled) return;
    timedOut = true;
    signalGroup('SIGKILL');
  });

  // Do not wait beyond the advertised limit even if a pathological kernel/process
  // state delays the child's close event. The group has already received KILL.
  scheduleAt(forceExitAt, () => {
    if (!settled) {
      signalGroup('SIGKILL');
      process.exit(TIMEOUT_EXIT_CODE);
    }
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      if (settled || timedOut) return;
      forwardedSignal = signal;
      signalGroup(signal);
      scheduleAfter(Math.min(500, termGraceMs), () => {
        signalGroup('SIGKILL');
        finish(SIGNAL_EXIT_CODES[signal] || 1);
      });
    });
  }

  // Arm every public-lifecycle timer before the bootstrap worker can begin its
  // caller-controlled TMPDIR capability setup.
  try {
    const bootstrapNonce = crypto.randomBytes(32).toString('hex');
    child = spawn(process.execPath, [
      '-e',
      `require(${JSON.stringify(__filename)}).runBootstrapWorker()`,
      '--',
      ...process.argv.slice(2),
    ], {
      detached: true,
      stdio: ['inherit', 'inherit', 'inherit', 'ignore', 'pipe'],
      env: {
        ...process.env,
        [BOOTSTRAP_MARKER_ENV]: '1',
        [BOOTSTRAP_PARENT_PID_ENV]: String(process.pid),
        [BOOTSTRAP_FD_ENV]: String(BOOTSTRAP_CHILD_FD),
        [BOOTSTRAP_NONCE_ENV]: bootstrapNonce,
        [BOOTSTRAP_DEADLINE_ENV]: String(deadlineAt),
      },
    });
    child.stdio[BOOTSTRAP_CHILD_FD].on('error', () => {});
    child.stdio[BOOTSTRAP_CHILD_FD].end(bootstrapNonce);
  } catch (error) {
    console.error(`run-with-hard-timeout: failed to launch bootstrap: ${error.message}`);
    finish(127);
    return;
  }

  child.once('error', error => {
    console.error(`run-with-hard-timeout: failed to launch bootstrap: ${error.message}`);
    finish(127);
  });

  child.once('close', (code, signal) => {
    childOutcome = { code, signal };
    if (timedOut) {
      finishAfterOwnedGroupCleanup(TIMEOUT_EXIT_CODE);
      return;
    }
    if (forwardedSignal) {
      finishAfterOwnedGroupCleanup(SIGNAL_EXIT_CODES[forwardedSignal] || 1);
      return;
    }
    finishAfterOwnedGroupCleanup(exitCodeForOutcome(code, signal));
  });
}

if (require.main === module) runPublicSupervisor();

module.exports = {
  runBootstrapWorker,
};
