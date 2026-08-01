#!/usr/bin/env node
'use strict';

// Hermetic process-group regressions for tools/run-with-hard-timeout.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUPERVISOR = path.resolve(__dirname, '..', 'tools', 'run-with-hard-timeout.js');
const CAPABILITY_VERIFIER = path.resolve(
  __dirname,
  '..',
  'tools',
  'test-supervisor-capability.js',
);
const HELPERS = path.join(__dirname, 'helpers.js');
let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function run(timeoutSeconds, command, args = [], env = {}) {
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      SUPERVISOR,
      '--timeout-seconds',
      String(timeoutSeconds),
      '--',
      command,
      ...args,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 5000,
    },
  );
  return { ...result, elapsedMs: Date.now() - startedAt };
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

function runSignalCase(signal) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-signal-cleanup-'));
  const leafScript = path.join(scratch, 'leaf.js');
  const driverScript = path.join(scratch, 'driver.js');
  const pidFile = path.join(scratch, 'leaf.pid');
  fs.writeFileSync(leafScript, [
    "'use strict';",
    "const fs = require('fs');",
    "fs.writeFileSync(process.argv[2], String(process.pid));",
    "for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {",
    "  process.on(signal, () => {});",
    "}",
    "setInterval(() => {}, 1000);",
  ].join('\n'));
  fs.writeFileSync(driverScript, [
    "'use strict';",
    "const fs = require('fs');",
    "const { spawn } = require('child_process');",
    "const [supervisor, leaf, pidFile, signal] = process.argv.slice(2);",
    "const child = spawn(process.execPath, [",
    "  supervisor, '--timeout-seconds', '5', '--', process.execPath, leaf, pidFile,",
    "], { stdio: ['ignore', 'pipe', 'pipe'] });",
    "let stdout = ''; let stderr = '';",
    "child.stdout.on('data', chunk => { stdout += chunk; });",
    "child.stderr.on('data', chunk => { stderr += chunk; });",
    "const deadline = Date.now() + 2000;",
    "const poll = setInterval(() => {",
    "  if (fs.existsSync(pidFile)) {",
    "    clearInterval(poll);",
    "    child.kill(signal);",
    "  } else if (Date.now() >= deadline || child.exitCode !== null) {",
    "    clearInterval(poll);",
    "    child.kill('SIGKILL');",
    "  }",
    "}, 10);",
    "child.once('close', (code, closeSignal) => {",
    "  clearInterval(poll);",
    "  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null;",
    "  setTimeout(() => {",
    "    let leafAlive = false;",
    "    if (pid) {",
    "      try { process.kill(pid, 0); leafAlive = true; } catch {}",
    "    }",
    "    process.stdout.write(JSON.stringify({",
    "      code, closeSignal, pidRecorded: Number.isInteger(pid), leafAlive, stdout, stderr,",
    "    }));",
    "  }, 100);",
    "});",
  ].join('\n'));

  try {
    const result = spawnSync(
      process.execPath,
      [driverScript, SUPERVISOR, leafScript, pidFile, signal],
      { encoding: 'utf8', timeout: 5000 },
    );
    return {
      driverStatus: result.status,
      evidence: result.stdout ? JSON.parse(result.stdout) : {},
      driverStderr: result.stderr,
    };
  } finally {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (pidIsAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

console.log('hard timeout supervisor tests\n');

{
  const result = run(3, process.execPath, [
    '-e',
    `const { hasActiveModelTestSupervisor } = require(${JSON.stringify(HELPERS)}); ` +
      'const first = hasActiveModelTestSupervisor(); ' +
      'const second = hasActiveModelTestSupervisor(); ' +
      'process.stdout.write(first + "|" + second + "|" + ' +
      'process.env.C_THRU_TEST_SUPERVISED + "|" + ' +
      'Number.isFinite(Number(process.env.C_THRU_TEST_DEADLINE_EPOCH_MS)) + "|" + ' +
      'Number.isSafeInteger(Number(process.env.C_THRU_TEST_SUPERVISOR_PID))); ' +
      'process.exit(37)',
  ]);
  check(result.status === 37, `normal child exit is preserved (got ${result.status})`);
  check(result.stdout === 'true|false|1|true|true',
    'direct child authenticates the inherited capability exactly once');
}

{
  const result = run(3, process.execPath, [
    '-e',
    `const { spawnSync } = require('child_process'); ` +
      `const helpers = ${JSON.stringify(HELPERS)}; ` +
      'const code = "const { hasActiveModelTestSupervisor } = require(" + ' +
      'JSON.stringify(helpers) + "); process.stdout.write(String(hasActiveModelTestSupervisor()))"; ' +
      'const child = spawnSync(process.execPath, ["-e", code], { ' +
      'encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe", 3] }); ' +
      'process.stdout.write(child.stdout || ""); process.exit(child.status || 0)',
  ]);
  check(result.status === 0,
    `direct-parent regression child exits cleanly (got ${result.status})`);
  check(result.stdout === 'false',
    'a grandchild cannot claim an unconsumed direct-child capability');
}

{
  const result = run(3, '/bin/bash', [
    '-c',
    '"$1" "$2" --verify-shell-child; first=$?; ' +
      '"$1" "$2" --verify-shell-child; second=$?; ' +
      'printf "%s|%s" "$first" "$second"',
    'c-thru-shell-capability',
    process.execPath,
    CAPABILITY_VERIFIER,
  ]);
  check(result.status === 0,
    `shell capability verifier exits cleanly (got ${result.status})`);
  check(result.stdout === '0|1',
    'direct shell child authenticates the inherited capability exactly once');
}

{
  const env = {
    ...process.env,
    C_THRU_TEST_SUPERVISED: '1',
    C_THRU_TEST_DEADLINE_EPOCH_MS: String(Date.now() + 60_000),
    C_THRU_TEST_SUPERVISOR_PID: String(process.pid),
  };
  delete env.C_THRU_TEST_SUPERVISOR_CAPABILITY_FD;
  delete env.C_THRU_TEST_SUPERVISOR_CAPABILITY_NONCE;
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const { hasActiveModelTestSupervisor } = require(${JSON.stringify(HELPERS)}); ` +
        'process.stdout.write(String(hasActiveModelTestSupervisor()))',
    ],
    { encoding: 'utf8', env },
  );
  check(result.status === 0,
    `forged environment tuple probe exits cleanly (got ${result.status})`);
  check(result.stdout === 'false',
    'ambient marker, live direct-parent PID, and valid deadline cannot bypass the capability');
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-forged-capability-'));
  const capabilityPath = path.join(scratch, 'linked-capability');
  const nonce = 'a'.repeat(64);
  let fd = null;
  try {
    fs.writeFileSync(capabilityPath, nonce);
    fd = fs.openSync(capabilityPath, 'r');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const { hasActiveModelTestSupervisor } = require(${JSON.stringify(HELPERS)}); ` +
          'process.stdout.write(String(hasActiveModelTestSupervisor()))',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          C_THRU_TEST_SUPERVISED: '1',
          C_THRU_TEST_DEADLINE_EPOCH_MS: String(Date.now() + 60_000),
          C_THRU_TEST_SUPERVISOR_PID: String(process.pid),
          C_THRU_TEST_SUPERVISOR_CAPABILITY_FD: '3',
          C_THRU_TEST_SUPERVISOR_CAPABILITY_NONCE: nonce,
        },
        stdio: ['ignore', 'pipe', 'pipe', fd],
      },
    );
    check(result.status === 0,
      `forged descriptor probe exits cleanly (got ${result.status})`);
    check(result.stdout === 'false',
      'a linked same-content descriptor cannot forge an inherited capability');
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

{
  const nonce = 'b'.repeat(64);
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const { hasActiveModelTestSupervisor } = require(${JSON.stringify(HELPERS)}); ` +
        'process.stdout.write(String(hasActiveModelTestSupervisor()))',
    ],
    {
      encoding: 'utf8',
      timeout: 1000,
      env: {
        ...process.env,
        C_THRU_TEST_SUPERVISED: '1',
        C_THRU_TEST_DEADLINE_EPOCH_MS: String(Date.now() + 60_000),
        C_THRU_TEST_SUPERVISOR_PID: String(process.pid),
        C_THRU_TEST_SUPERVISOR_CAPABILITY_FD: '3',
        C_THRU_TEST_SUPERVISOR_CAPABILITY_NONCE: nonce,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    },
  );
  const elapsedMs = Date.now() - startedAt;
  check(result.status === 0 && result.stdout === 'false',
    'an empty pipe descriptor is rejected before any capability read');
  check(elapsedMs < 1000,
    `empty-pipe rejection cannot hang waiting for a writer (${elapsedMs}ms)`);
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-over-cap-'));
  const marker = path.join(scratch, 'launched');
  try {
    const result = run(3601, process.execPath, [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`,
    ]);
    check(result.status === 2, `timeout above one hour is rejected (got ${result.status})`);
    check(!fs.existsSync(marker), 'over-cap rejection occurs before the child launches');
    check(/integer from 1 to 3600/.test(result.stderr || ''),
      'over-cap rejection reports the accepted range');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-blocked-bootstrap-'));
  const preload = path.join(scratch, 'block-capability-setup.js');
  const marker = path.join(scratch, 'child-launched');
  fs.writeFileSync(preload, [
    "'use strict';",
    "const fs = require('fs');",
    'fs.mkdtempSync = () => {',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);',
    "  throw new Error('blocked capability setup escaped its hard deadline');",
    '};',
  ].join('\n'));
  try {
    const startedAt = Date.now();
    const result = spawnSync(
      process.execPath,
      [
        SUPERVISOR,
        '--timeout-seconds',
        '1',
        '--',
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS || '',
            `--require=${preload}`,
          ].filter(Boolean).join(' '),
        },
        timeout: 2500,
      },
    );
    const elapsedMs = Date.now() - startedAt;
    check(result.status === 124,
      `blocked capability setup exits through the public hard timeout (got ${result.status})`);
    check(elapsedMs < 1500,
      `blocked capability setup stays inside the one-second wall budget (${elapsedMs}ms)`);
    check(!fs.existsSync(marker),
      'blocked capability setup never launches the requested child');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

{
  const inheritedDeadline = Date.now() + 2000;
  const result = run(5, process.execPath, [
    '-e',
    'process.stdout.write(process.env.C_THRU_TEST_DEADLINE_EPOCH_MS)',
  ], {
    C_THRU_TEST_SUPERVISED: '1',
    C_THRU_TEST_DEADLINE_EPOCH_MS: String(inheritedDeadline),
  });
  const advertisedDeadline = Number(result.stdout);
  check(result.status === 0,
    `nested deadline probe exits cleanly (got ${result.status})`);
  check(Number.isSafeInteger(advertisedDeadline) &&
      advertisedDeadline <= inheritedDeadline,
  `nested supervisor preserves the earliest inherited deadline ` +
      `(got ${advertisedDeadline}, inherited ${inheritedDeadline})`);
}

{
  const inheritedDeadline = Date.now() + 1000;
  const result = run(3, process.execPath, [
    '-e',
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
  ], {
    C_THRU_TEST_SUPERVISED: '1',
    C_THRU_TEST_DEADLINE_EPOCH_MS: String(inheritedDeadline),
  });
  check(result.status === 124,
    `earlier inherited deadline returns exit 124 (got ${result.status})`);
  check(result.elapsedMs < 1500,
    `earlier inherited deadline bounds the nested wall clock (${result.elapsedMs}ms)`);
}

{
  const result = run(1, process.execPath, [
    '-e',
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
  ], {
    C_THRU_TEST_SUPERVISED: '1',
    C_THRU_TEST_DEADLINE_EPOCH_MS: String(Date.now() + 60_000),
  });
  check(result.status === 124,
    `later ambient deadline cannot suppress the requested timeout (got ${result.status})`);
  check(result.elapsedMs < 1500,
    `later ambient deadline cannot extend the requested wall clock (${result.elapsedMs}ms)`);
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-expired-deadline-'));
  const marker = path.join(scratch, 'launched');
  try {
    const result = run(5, process.execPath, [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`,
    ], {
      C_THRU_TEST_SUPERVISED: '1',
      C_THRU_TEST_DEADLINE_EPOCH_MS: String(Date.now() - 1),
    });
    check(result.status === 124,
      `expired inherited deadline returns exit 124 (got ${result.status})`);
    check(!fs.existsSync(marker),
      'expired inherited deadline is rejected before the child launches');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

{
  const result = run(1, process.execPath, [
    '-e',
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
  ]);
  check(result.status === 124, `TERM-resistant child times out with exit 124 (got ${result.status})`);
  check(result.elapsedMs < 1500,
    `hard timeout returns within the advertised one-second wall budget (${result.elapsedMs}ms)`);
}

for (const [signal, expectedExit] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
]) {
  const result = runSignalCase(signal);
  check(result.driverStatus === 0,
    `${signal} cancellation driver completes (got ${result.driverStatus})`);
  check(result.evidence.code === expectedExit,
    `${signal} maps to exit ${expectedExit} (got ${result.evidence.code})`);
  check(result.evidence.pidRecorded === true && result.evidence.leafAlive === false,
    `${signal} reaps the TERM-resistant owned child`);
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-orphan-group-'));
  const grandchildScript = path.join(scratch, 'grandchild.js');
  const parentScript = path.join(scratch, 'parent.js');
  const pidFile = path.join(scratch, 'grandchild.pid');
  fs.writeFileSync(grandchildScript, [
    "'use strict';",
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  fs.writeFileSync(parentScript, [
    "'use strict';",
    "const fs = require('fs');",
    "const { spawn } = require('child_process');",
    `const child = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: 'inherit' });`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    'process.exit(0);',
  ].join('\n'));

  let grandchildPid = null;
  try {
    const result = run(3, process.execPath, [parentScript]);
    grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
    check(result.status === 0,
      `normally exiting parent preserves status after descendant cleanup (got ${result.status})`);
    check(result.elapsedMs < 1500,
      `leftover descendant cannot hold the supervisor pipe open (${result.elapsedMs}ms)`);
    check(waitForPidGone(grandchildPid),
      `supervisor kills the TERM-resistant owned grandchild ${grandchildPid}`);
  } finally {
    if (pidIsAlive(grandchildPid)) {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-direct-bootstrap-'));
  const script = path.join(scratch, 'direct-model-test.js');
  fs.writeFileSync(script, [
    "'use strict';",
    `const { ensureModelTestSupervisor } = require(${JSON.stringify(path.join(__dirname, 'helpers.js'))});`,
    'ensureModelTestSupervisor();',
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  try {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        C_THRU_TEST_TIMEOUT_SECONDS: '1',
        C_THRU_TEST_SUPERVISED: '0',
      },
      timeout: 5000,
    });
    const elapsedMs = Date.now() - startedAt;
    check(result.status === 124,
      `direct model-test bootstrap enforces exit 124 (got ${result.status})`);
    check(elapsedMs < 1500,
      `direct model-test bootstrap shares the hard wall budget (${elapsedMs}ms)`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-stale-bootstrap-'));
  const script = path.join(scratch, 'stale-marker-model-test.js');
  fs.writeFileSync(script, [
    "'use strict';",
    `const { ensureModelTestSupervisor } = require(${JSON.stringify(path.join(__dirname, 'helpers.js'))});`,
    'ensureModelTestSupervisor();',
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  try {
    const env = {
      ...process.env,
      C_THRU_TEST_TIMEOUT_SECONDS: '1',
      C_THRU_TEST_SUPERVISED: '1',
    };
    delete env.C_THRU_TEST_DEADLINE_EPOCH_MS;
    delete env.C_THRU_TEST_SUPERVISOR_PID;
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env,
      timeout: 5000,
    });
    const elapsedMs = Date.now() - startedAt;
    check(result.status === 124,
      `ambient supervised marker without a deadline is re-supervised (got ${result.status})`);
    check(elapsedMs < 1500,
      `stale-marker bootstrap remains inside the one-second wall budget (${elapsedMs}ms)`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
