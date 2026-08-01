#!/usr/bin/env node
'use strict';

// Authentication for the hard test supervisor. The supervisor passes its
// direct child a read-only descriptor for an already-unlinked regular file
// containing a random nonce. Consuming the descriptor proves inheritance from
// that supervisor without trusting a copyable environment tuple alone.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_SUPERVISOR_REMAINING_MS = 60 * 60 * 1000;
const CAPABILITY_BYTES = 64;
const CAPABILITY_CHILD_FD = 3;
const CAPABILITY_FD_ENV = 'C_THRU_TEST_SUPERVISOR_CAPABILITY_FD';
const CAPABILITY_NONCE_ENV = 'C_THRU_TEST_SUPERVISOR_CAPABILITY_NONCE';

function createTestSupervisorCapability() {
  const nonce = crypto.randomBytes(32).toString('hex');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-test-supervisor-'));
  const capabilityPath = path.join(scratch, 'capability');
  let fd = null;

  try {
    fs.writeFileSync(capabilityPath, nonce, {
      encoding: 'ascii',
      flag: 'wx',
      mode: 0o600,
    });
    fd = fs.openSync(capabilityPath, 'r');
    fs.unlinkSync(capabilityPath);
    fs.rmdirSync(scratch);

    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.nlink !== 0 || stats.size !== CAPABILITY_BYTES) {
      throw new Error('created capability descriptor failed metadata validation');
    }
    return { fd, nonce };
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(capabilityPath); } catch {}
    try { fs.rmdirSync(scratch); } catch {}
    throw error;
  }
}

function parsePositiveInteger(raw) {
  if (!/^[1-9]\d*$/.test(raw || '')) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function consumeTestSupervisorCapability({
  env = process.env,
  nowMs = Date.now(),
  claimantParentPid = process.ppid,
  maxRemainingMs = MAX_SUPERVISOR_REMAINING_MS,
} = {}) {
  if (env.C_THRU_TEST_SUPERVISED !== '1') return false;

  const deadlineMs = parsePositiveInteger(
    env.C_THRU_TEST_DEADLINE_EPOCH_MS || '',
  );
  const remainingMs = deadlineMs === null ? null : deadlineMs - nowMs;
  if (remainingMs === null ||
      remainingMs <= 0 ||
      remainingMs > maxRemainingMs) {
    return false;
  }

  const supervisorPid = parsePositiveInteger(
    env.C_THRU_TEST_SUPERVISOR_PID || '',
  );
  if (supervisorPid === null ||
      supervisorPid !== claimantParentPid ||
      !processIsAlive(supervisorPid)) {
    return false;
  }

  const capabilityFd = parsePositiveInteger(env[CAPABILITY_FD_ENV] || '');
  const expectedNonce = env[CAPABILITY_NONCE_ENV] || '';
  if (capabilityFd === null ||
      capabilityFd < CAPABILITY_CHILD_FD ||
      !/^[a-f0-9]{64}$/.test(expectedNonce)) {
    return false;
  }

  let stats;
  try {
    stats = fs.fstatSync(capabilityFd);
  } catch {
    return false;
  }
  if (!stats.isFile() ||
      stats.nlink !== 0 ||
      stats.size !== CAPABILITY_BYTES) {
    return false;
  }

  // A regular file with a verified 64-byte size cannot block waiting for a
  // writer. Reading 65 bytes both consumes the shared open-file offset and
  // proves that the descriptor contains exactly one nonce.
  const actual = Buffer.alloc(CAPABILITY_BYTES + 1);
  let bytesRead;
  try {
    bytesRead = fs.readSync(
      capabilityFd,
      actual,
      0,
      actual.length,
      null,
    );
    fs.closeSync(capabilityFd);
  } catch {
    return false;
  }
  if (bytesRead !== CAPABILITY_BYTES) return false;

  return crypto.timingSafeEqual(
    actual.subarray(0, CAPABILITY_BYTES),
    Buffer.from(expectedNonce, 'ascii'),
  );
}

function parentPidOf(pid) {
  const result = spawnSync(
    '/bin/ps',
    ['-o', 'ppid=', '-p', String(pid)],
    {
      encoding: 'utf8',
      timeout: 1000,
    },
  );
  if (result.error || result.status !== 0) return null;
  return parsePositiveInteger((result.stdout || '').trim());
}

function verifyShellChild() {
  // This verifier is launched by the shell being authenticated. Confirm the
  // verifier's actual parent, then inspect that shell's parent so the shell
  // itself must be the supervisor's direct child.
  const shellPid = process.ppid;
  const shellParentPid = parentPidOf(shellPid);
  if (shellParentPid === null) return false;
  return consumeTestSupervisorCapability({
    claimantParentPid: shellParentPid,
  });
}

if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--verify-shell-child') {
    console.error(
      'test-supervisor-capability: expected --verify-shell-child',
    );
    process.exit(2);
  }
  process.exit(verifyShellChild() ? 0 : 1);
}

module.exports = {
  CAPABILITY_CHILD_FD,
  CAPABILITY_FD_ENV,
  CAPABILITY_NONCE_ENV,
  MAX_SUPERVISOR_REMAINING_MS,
  consumeTestSupervisorCapability,
  createTestSupervisorCapability,
  verifyShellChild,
};
