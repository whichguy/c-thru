#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCHEMA_VERSION = 1;
const SCHEMA_ID = 'c-thru-test-run-evidence';
const MAX_GIT_OUTPUT = 128 * 1024 * 1024;
const SUITE_STATUSES = new Set(['passed', 'failed', 'skipped', 'blocked']);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function nowIso() {
  return new Date().toISOString();
}

function safeToken(value, field, { optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:/+-]{1,160}$/.test(value)) {
    throw new Error(`${field} must contain only delimiter-safe characters`);
  }
  return value;
}

function safeLabel(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300 ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('suite label must be a non-empty printable string up to 300 characters');
  }
  return value;
}

function safeReason(value) {
  const reason = safeToken(value, 'suite reason');
  if (/AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[0-9A-Za-z]{20,}|sk-[0-9A-Za-z_-]{16,}|Bearer_|SECRET_CANARY/.test(reason)) {
    return 'redacted_sensitive_reason';
  }
  return reason;
}

function safePath(value, field = 'path') {
  if (typeof value !== 'string' || value.length === 0 ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must be a non-empty path without control characters`);
  }
  return path.resolve(value);
}

function parseNonNegativeInteger(value, field) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} is too large`);
  return parsed;
}

function git(repoRoot, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: MAX_GIT_OUTPUT,
    env: {
      PATH: process.env.PATH || '',
      LC_ALL: 'C',
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  if (result.error || (!allowFailure && result.status !== 0)) {
    throw new Error(`git ${args[0]} failed while capturing repository identity`);
  }
  return result;
}

function resolveRepoRoot(repoPath) {
  const requested = safePath(repoPath, 'repo');
  const result = git(requested, ['rev-parse', '--show-toplevel']);
  const reported = (result.stdout || Buffer.alloc(0)).toString('utf8').trim();
  if (!reported) throw new Error('git did not report a repository root');
  return fs.realpathSync(reported);
}

function isEvidenceArtifact(absolutePath, evidencePath) {
  if (!evidencePath) return false;
  const comparable = value => {
    const resolved = path.resolve(value);
    try {
      return fs.realpathSync(resolved);
    } catch {
      try {
        return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
      } catch {
        return resolved;
      }
    }
  };
  const candidate = comparable(absolutePath);
  const evidence = comparable(evidencePath);
  if (candidate === evidence) return true;
  return path.dirname(candidate) === path.dirname(evidence) &&
    path.basename(candidate).startsWith(`${path.basename(evidence)}.tmp-`);
}

function updateHashesWithFile(hashes, filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      for (const hash of hashes) hash.update(chunk);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function captureRepository(repoPath, evidencePath = null) {
  const repoRoot = resolveRepoRoot(repoPath);
  const head = (git(repoRoot, ['rev-parse', 'HEAD']).stdout || Buffer.alloc(0))
    .toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) {
    throw new Error('git returned an invalid HEAD identity');
  }

  const branchResult = git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowFailure: true,
  });
  const branchRaw = branchResult.status === 0
    ? (branchResult.stdout || Buffer.alloc(0)).toString('utf8').trim()
    : '';
  const branch = branchRaw
    ? branchRaw.replace(/[^A-Za-z0-9._/@+-]/g, '_').slice(0, 200)
    : null;

  const diff = git(repoRoot, ['diff', '--no-ext-diff', 'HEAD', '--']).stdout ||
    Buffer.alloc(0);
  const untrackedResult = git(repoRoot, [
    'ls-files', '--others', '--exclude-standard', '-z', '--',
  ]);
  const untracked = (untrackedResult.stdout || Buffer.alloc(0))
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter(relative => !isEvidenceArtifact(path.resolve(repoRoot, relative), evidencePath))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

  const untrackedHash = crypto.createHash('sha256');
  const worktreeHash = crypto.createHash('sha256');
  untrackedHash.update('c-thru-untracked-v1\0');
  worktreeHash.update('c-thru-worktree-v1\0git-diff-head\0');
  worktreeHash.update(diff);

  for (const relative of untracked) {
    const absolute = path.resolve(repoRoot, relative);
    const stat = fs.lstatSync(absolute);
    const type = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other';
    const header = Buffer.from(`\0untracked\0${Buffer.byteLength(relative)}\0${relative}\0${type}\0`);
    untrackedHash.update(header);
    worktreeHash.update(header);
    if (stat.isSymbolicLink()) {
      const target = Buffer.from(fs.readlinkSync(absolute));
      untrackedHash.update(target);
      worktreeHash.update(target);
    } else if (stat.isFile()) {
      updateHashesWithFile([untrackedHash, worktreeHash], absolute);
    }
  }

  const trackedDiffSha256 = sha256(diff);
  const untrackedContentSha256 = untrackedHash.digest('hex');
  const worktreeContentSha256 = worktreeHash.digest('hex');
  const snapshotMaterial = {
    branch,
    head,
    tracked_diff_sha256: trackedDiffSha256,
    untracked_content_sha256: untrackedContentSha256,
    worktree_content_sha256: worktreeContentSha256,
  };

  return {
    root: repoRoot,
    head,
    branch,
    dirty: diff.length > 0 || untracked.length > 0,
    tracked_diff_sha256: trackedDiffSha256,
    untracked_content_sha256: untrackedContentSha256,
    untracked_file_count: untracked.length,
    worktree_content_sha256: worktreeContentSha256,
    snapshot_sha256: sha256(stableStringify(snapshotMaterial)),
  };
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  updateHashesWithFile([hash], filePath);
  return hash.digest('hex');
}

function captureModelMap(repoRoot) {
  let selected = null;
  const configHelper = path.join(repoRoot, 'tools', 'model-map-config.js');
  if (fs.existsSync(configHelper)) {
    try {
      const { resolveSelectedConfigPath } = require(configHelper);
      selected = resolveSelectedConfigPath({
        baseDir: path.dirname(configHelper),
        cwd: process.env.CLAUDE_MODEL_MAP_LAUNCH_CWD || process.cwd(),
        syncProfile: false,
      });
    } catch {
      selected = null;
    }
  }

  let candidate = selected && selected.path;
  let source = selected && selected.source;
  if (!candidate && process.env.CLAUDE_MODEL_MAP_PATH) {
    candidate = process.env.CLAUDE_MODEL_MAP_PATH;
    source = 'override';
  }
  if (!candidate) {
    candidate = path.join(repoRoot, 'config', 'model-map.json');
    source = 'repository-default';
  }

  try {
    const realpath = fs.realpathSync(candidate);
    if (!fs.statSync(realpath).isFile()) throw new Error('not a file');
    return {
      available: true,
      source: safeToken(source || 'unknown', 'model-map source'),
      realpath,
      sha256: hashFile(realpath),
    };
  } catch {
    return {
      available: false,
      source: source ? safeToken(source, 'model-map source') : null,
      realpath: null,
      sha256: null,
    };
  }
}

function executableCandidates(command) {
  if (!command) return [];
  if (command.includes(path.sep)) return [path.resolve(command)];
  return (process.env.PATH || '').split(path.delimiter)
    .filter(Boolean)
    .map(directory => path.join(directory, command));
}

function captureClaude(repoRoot) {
  const configured = process.env.CLAUDE_BIN || '';
  const candidates = configured ? executableCandidates(configured) : executableCandidates('claude');
  const cThruPath = path.join(repoRoot, 'tools', 'c-thru');
  let cThruReal = null;
  try { cThruReal = fs.realpathSync(cThruPath); } catch {}

  let executable = null;
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const real = fs.realpathSync(candidate);
      if (!configured && cThruReal && real === cThruReal) continue;
      executable = real;
      break;
    } catch {}
  }
  if (!executable) return { available: false, path: null, version: null };

  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 64 * 1024,
    env: {
      PATH: process.env.PATH || '',
      LC_ALL: 'C',
      LANG: 'C',
      NO_COLOR: '1',
    },
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = output.match(/(?:^|[^0-9])([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)(?:$|[^0-9])/);
  return {
    available: result.status === 0,
    path: executable,
    version: result.status === 0 && match ? match[1] : null,
  };
}

function capturePluginParity(repoRoot) {
  const checker = path.join(repoRoot, 'tools', 'sync-plugin-bundle.sh');
  if (!fs.existsSync(checker)) return { available: false, in_sync: null };
  const result = spawnSync('/bin/bash', [checker, '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: process.env.PATH || '',
      LC_ALL: 'C',
      LANG: 'C',
    },
  });
  return {
    available: !result.error,
    in_sync: !result.error && result.status === 0,
  };
}

function captureIdentity(repoPath, evidencePath = null) {
  const repoRoot = resolveRepoRoot(repoPath);
  const identity = {
    repository: captureRepository(repoRoot, evidencePath),
    entrypoint_model_map: captureModelMap(repoRoot),
    claude: captureClaude(repoRoot),
    runtime: {
      node: process.version,
      os: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
      },
    },
    plugin_parity: capturePluginParity(repoRoot),
  };
  return {
    ...identity,
    combined_snapshot_sha256: sha256(stableStringify(identity)),
  };
}

function ensureEvidenceShape(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
      evidence.schema_version !== SCHEMA_VERSION || evidence.schema_id !== SCHEMA_ID ||
      !evidence.run || !Array.isArray(evidence.suites) || !evidence.initial_identity) {
    throw new Error('evidence file has an unsupported or malformed schema');
  }
}

function readEvidence(evidencePath) {
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  } catch {
    throw new Error('evidence file is missing or malformed');
  }
  ensureEvidenceShape(evidence);
  return evidence;
}

function atomicWrite(evidencePath, evidence) {
  const target = safePath(evidencePath, 'evidence path');
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    parent,
    `${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function allocateEvidencePath(explicitPath = null) {
  if (explicitPath) return safePath(explicitPath, 'evidence path');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `c-thru-test-evidence-${uid}-`));
  fs.chmodSync(directory, 0o700);
  return path.join(directory, 'run-evidence.json');
}

function initializeEvidence({ evidencePath, repoPath, mode, shard = null }) {
  const target = safePath(evidencePath, 'evidence path');
  const repoRoot = resolveRepoRoot(repoPath);
  const initialIdentity = captureIdentity(repoRoot, target);
  const evidence = {
    schema_version: SCHEMA_VERSION,
    schema_id: SCHEMA_ID,
    run_id: crypto.randomUUID(),
    run: {
      status: 'running',
      mode: safeToken(mode, 'run mode'),
      live_shard: shard ? safeToken(shard, 'live shard') : null,
      started_at: nowIso(),
      finished_at: null,
      counts: {
        passed: 0,
        failed: 0,
        skipped: 0,
        blocked: 0,
      },
    },
    initial_identity: initialIdentity,
    suites: [],
    consistency: {
      checked: false,
      consistent: null,
      initial_combined_snapshot_sha256: initialIdentity.combined_snapshot_sha256,
      final_combined_snapshot_sha256: null,
      changed_sections: [],
    },
  };
  atomicWrite(target, evidence);
  return evidence;
}

function startSuite({ evidencePath, kind, label, provider = null, suite = null }) {
  const target = safePath(evidencePath, 'evidence path');
  const evidence = readEvidence(target);
  if (evidence.run.status !== 'running') {
    throw new Error('cannot start a suite after evidence finalization');
  }
  const id = evidence.suites.length + 1;
  evidence.suites.push({
    id,
    kind: safeToken(kind, 'suite kind'),
    label: safeLabel(label),
    provider: provider ? safeToken(provider, 'provider') : null,
    suite: suite ? safeToken(suite, 'suite') : null,
    status: 'running',
    started_at: nowIso(),
    finished_at: null,
    duration_ms: null,
    exit_code: null,
    reason: null,
  });
  atomicWrite(target, evidence);
  return id;
}

function finishSuite({ evidencePath, id, status, exitCode = null, reason = null }) {
  const target = safePath(evidencePath, 'evidence path');
  const evidence = readEvidence(target);
  if (evidence.run.status !== 'running') {
    throw new Error('cannot finish a suite after evidence finalization');
  }
  if (!SUITE_STATUSES.has(status)) throw new Error('invalid suite status');
  const numericId = parseNonNegativeInteger(String(id), 'suite id');
  const record = evidence.suites.find(item => item.id === numericId);
  if (!record || record.status !== 'running') {
    throw new Error('suite record is missing or is not running');
  }
  let parsedExitCode = null;
  if (exitCode !== null && exitCode !== undefined && exitCode !== '') {
    parsedExitCode = parseNonNegativeInteger(String(exitCode), 'exit code');
    if (parsedExitCode > 255) throw new Error('exit code must be between 0 and 255');
  }
  const startedAtMs = Date.parse(record.started_at);
  if (!Number.isFinite(startedAtMs)) throw new Error('suite record has an invalid start timestamp');
  record.status = status;
  record.finished_at = nowIso();
  record.duration_ms = Math.max(
    0,
    Date.parse(record.finished_at) - startedAtMs,
  );
  record.exit_code = parsedExitCode;
  record.reason = reason ? safeReason(reason) : null;
  atomicWrite(target, evidence);
  return record;
}

function changedIdentitySections(initial, final) {
  const sections = [
    'repository',
    'entrypoint_model_map',
    'claude',
    'runtime',
    'plugin_parity',
  ];
  return sections.filter(section =>
    stableStringify(initial[section]) !== stableStringify(final[section]));
}

function summarizeSuites(suites) {
  const counts = {
    passed: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
  };
  let unfinished = 0;
  for (const record of suites) {
    if (record && SUITE_STATUSES.has(record.status)) {
      counts[record.status] += 1;
    } else {
      unfinished += 1;
    }
  }
  return { counts, unfinished };
}

function finalizeEvidence({
  evidencePath,
  repoPath,
  passed,
  failed,
  skipped,
  blocked,
  status,
}) {
  const target = safePath(evidencePath, 'evidence path');
  const evidence = readEvidence(target);
  if (evidence.run.status !== 'running') {
    throw new Error('evidence has already been finalized');
  }
  const counts = {
    passed: parseNonNegativeInteger(String(passed), 'passed count'),
    failed: parseNonNegativeInteger(String(failed), 'failed count'),
    skipped: parseNonNegativeInteger(String(skipped), 'skipped count'),
    blocked: parseNonNegativeInteger(String(blocked), 'blocked count'),
  };
  if (status !== 'passed' && status !== 'failed') throw new Error('invalid final status');

  const finalIdentity = captureIdentity(repoPath, target);
  const changedSections = changedIdentitySections(evidence.initial_identity, finalIdentity);
  const suiteSummary = summarizeSuites(evidence.suites);
  const strictFailedCount = suiteSummary.counts.failed +
    suiteSummary.counts.skipped + suiteSummary.counts.blocked;
  const countContradiction =
    counts.passed !== suiteSummary.counts.passed ||
    counts.skipped !== suiteSummary.counts.skipped ||
    counts.blocked !== suiteSummary.counts.blocked ||
    (counts.failed !== suiteSummary.counts.failed &&
      counts.failed !== strictFailedCount);
  const expectedStatus =
    suiteSummary.counts.failed > 0 || counts.failed > 0 ? 'failed' : 'passed';
  const statusContradiction = status !== expectedStatus;
  if (suiteSummary.unfinished > 0) changedSections.push('suite_records');
  if (countContradiction) changedSections.push('summary_counts');
  if (statusContradiction) changedSections.push('summary_status');

  const consistent = changedSections.length === 0;
  evidence.run.counts = counts;
  evidence.run.finished_at = nowIso();
  evidence.run.status = consistent ? status : 'inconsistent';
  evidence.consistency = {
    checked: true,
    consistent,
    initial_combined_snapshot_sha256:
      evidence.initial_identity.combined_snapshot_sha256,
    final_combined_snapshot_sha256: finalIdentity.combined_snapshot_sha256,
    changed_sections: changedSections,
  };
  atomicWrite(target, evidence);
  return { evidence, ok: consistent };
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--') || index + 1 >= rest.length) {
      throw new Error('options must use --name value pairs');
    }
    const key = arg.slice(2);
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      throw new Error(`duplicate --${key} option`);
    }
    options[key] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function required(options, key) {
  if (!Object.prototype.hasOwnProperty.call(options, key) || options[key] === '') {
    throw new Error(`missing --${key}`);
  }
  return options[key];
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  if (command === 'allocate') {
    process.stdout.write(`${allocateEvidencePath(options.path || null)}\n`);
    return 0;
  }
  if (command === 'init') {
    initializeEvidence({
      evidencePath: required(options, 'path'),
      repoPath: required(options, 'repo'),
      mode: required(options, 'mode'),
      shard: options.shard || null,
    });
    return 0;
  }
  if (command === 'suite-start') {
    const id = startSuite({
      evidencePath: required(options, 'path'),
      kind: required(options, 'kind'),
      label: required(options, 'label'),
      provider: options.provider || null,
      suite: options.suite || null,
    });
    process.stdout.write(`${id}\n`);
    return 0;
  }
  if (command === 'suite-finish') {
    finishSuite({
      evidencePath: required(options, 'path'),
      id: required(options, 'id'),
      status: required(options, 'status'),
      exitCode: options['exit-code'] ?? null,
      reason: options.reason || null,
    });
    return 0;
  }
  if (command === 'finalize') {
    const result = finalizeEvidence({
      evidencePath: required(options, 'path'),
      repoPath: required(options, 'repo'),
      passed: required(options, 'passed'),
      failed: required(options, 'failed'),
      skipped: required(options, 'skipped'),
      blocked: required(options, 'blocked'),
      status: required(options, 'status'),
    });
    return result.ok ? 0 : 1;
  }
  throw new Error('expected allocate, init, suite-start, suite-finish, or finalize');
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`test-run-evidence: ${error && error.message
      ? error.message.replace(/[\r\n]+/g, ' ')
      : 'unknown failure'}`);
    process.exitCode = 1;
  }
}

module.exports = {
  SCHEMA_ID,
  SCHEMA_VERSION,
  allocateEvidencePath,
  atomicWrite,
  captureIdentity,
  captureRepository,
  finalizeEvidence,
  finishSuite,
  initializeEvidence,
  sha256,
  stableStringify,
  startSuite,
};
