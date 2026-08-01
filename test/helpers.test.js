#!/usr/bin/env node
'use strict';
// Self-test for test/helpers.js — the shared harness ~90 suites depend on.
//
// Why this exists: helpers.js is the single most-depended-on file in the test
// tree, yet its trickiest behaviors (waitForPing's ECONNRESET fast-retry,
// startStubServer's route precedence, spawnCapture's timeout kill) were
// verified only INDIRECTLY by the suites that happen to use them. The
// waitForPing ECONNRESET de-flake in particular is a load-dependent guard:
// deleting it keeps proxy-lifecycle green on an idle machine and only bites as
// a full-run flake. This test bites it deterministically.
//
// Deterministic + stdlib-only: raw http servers, node -e children, and one
// minimal fake READY child; no real proxy and no provider network.
//
// Run: node test/helpers.test.js

const {
  assert,
  assertEq,
  summary,
  getFreePort,
  startStubServer,
  spawnCapture,
  spawnProxy,
  withProxy,
  DEFAULT_HERMETIC_READY_TIMEOUT_MS,
  DEFAULT_HERMETIC_REQUEST_TIMEOUT_MS,
  waitForPing,
  httpJson,
  terminateAndReap,
  modelTestTimeoutMs,
  modelTestProxyEnv,
  boundedDiagnosticSnippet,
  parseAgentContractResult,
} = require('./helpers');
const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const FAKE_READY_PROXY = path.join(__dirname, 'fixtures', 'fake-ready-proxy.js');

function testHermeticTimeoutDefaults() {
  console.log('hermetic infrastructure timeout defaults');
  assertEq(DEFAULT_HERMETIC_READY_TIMEOUT_MS, 15_000,
    'proxy readiness default allows 15s for a loaded host');
  assertEq(DEFAULT_HERMETIC_REQUEST_TIMEOUT_MS, 10_000,
    'ordinary loopback HTTP default allows 10s for a loaded host');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 1000);
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    try { child.kill('SIGTERM'); } catch { resolve(); }
  });
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
}

async function testTerminateAndReapBound() {
  console.log('\nterminateAndReap final bound');
  const fakeChild = new EventEmitter();
  fakeChild.pid = 424242;
  fakeChild.exitCode = null;
  fakeChild.signalCode = null;
  const signals = [];
  fakeChild.kill = signal => { signals.push(signal); return true; };

  const t0 = Date.now();
  let rejected = false;
  let message = '';
  try {
    await terminateAndReap(fakeChild, 'SIGKILL', 50);
  } catch (e) {
    rejected = true;
    message = e.message;
  }
  const elapsed = Date.now() - t0;
  assert(rejected, 'missing child exit event fails cleanup instead of hanging');
  assert(message.includes('did not report exit within 50ms after SIGKILL'),
    `cleanup failure names its final reap bound (got: ${message})`);
  assertEq(signals.join(','), 'SIGKILL', 'cleanup sent the requested fatal signal once');
  assert(elapsed >= 40 && elapsed < 500,
    `cleanup failure remained bounded near 50ms (got ${elapsed}ms)`);
}

async function testSpawnProxyReadyBudget() {
  console.log('\nspawnProxy READY budget');
  const readyPort = await getFreePort();
  const t0 = Date.now();
  let spawned;
  try {
    spawned = await spawnProxy({
      proxyBin: FAKE_READY_PROXY,
      env: {
        FAKE_READY_PORT: String(readyPort),
        // Deliberately exceeds the obsolete 8-second inner watchdog. This
        // passes only when spawnProxy actually uses the shared 15-second cap.
        FAKE_READY_DELAY_MS: '8100',
      },
    });
    const elapsed = Date.now() - t0;
    assertEq(spawned.port, readyPort, 'delayed READY port is parsed');
    assert(elapsed >= 8000,
      `spawnProxy waited beyond the obsolete 8s cap (got ${elapsed}ms)`);
    assert(elapsed < DEFAULT_HERMETIC_READY_TIMEOUT_MS + 2000,
      `spawnProxy remained bounded by the shared readiness budget (got ${elapsed}ms)`);
  } finally {
    if (spawned) {
      await stopChild(spawned.child);
      try { fs.rmSync(spawned.tmpHome, { recursive: true, force: true }); } catch {}
    }
  }
}

async function testWithProxyFailedStartupCleanup() {
  console.log('\nwithProxy combined readiness deadline + post-READY cleanup');
  const readyPort = await getFreePort();
  const pidFile = path.join(
    os.tmpdir(),
    `c-thru-fake-ready-${process.pid}-${Date.now()}.pid`,
  );
  const pingMarker = `${pidFile}.ping`;
  let callbackRan = false;
  let rejected = false;
  let message = '';
  const t0 = Date.now();
  try {
    await withProxy({
      proxyBin: FAKE_READY_PROXY,
      readyTimeoutMs: 400,
      env: {
        FAKE_READY_PORT: String(readyPort),
        FAKE_READY_PID_FILE: pidFile,
        FAKE_READY_DELAY_MS: '300',
        FAKE_READY_PING_MARKER: pingMarker,
        FAKE_READY_STALL_PING: '1',
      },
    }, async () => { callbackRan = true; });
  } catch (e) {
    rejected = true;
    message = e.message;
  }
  const elapsed = Date.now() - t0;

  try {
    assert(rejected, 'unhealthy READY child rejects during /ping startup check');
    assert(message.includes('after 400ms'),
      `withProxy reports the single end-to-end readiness cap (got: ${message})`);
    assert(elapsed >= 300,
      `combined probe actually consumed the delayed READY phase (got ${elapsed}ms)`);
    assert(elapsed < 500,
      `READY and /ping share one 400ms deadline instead of resetting it (got ${elapsed}ms)`);
    assert(fs.existsSync(pingMarker),
      'fake /ping server accepted the request and deliberately stalled it');
    assert(!callbackRan, 'test callback never runs after failed startup');
    assert(fs.existsSync(pidFile), 'fake child recorded its PID before READY');
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert(!pidIsAlive(pid), `failed-startup child ${pid} was terminated and reaped`);
    }
  } finally {
    try { fs.rmSync(pidFile, { force: true }); } catch {}
    try { fs.rmSync(pingMarker, { force: true }); } catch {}
  }
}

async function testWithProxyPreReadyCleanup() {
  console.log('\nwithProxy pre-READY timeout cleanup');
  const readyPort = await getFreePort();
  const pidFile = path.join(
    os.tmpdir(),
    `c-thru-fake-pre-ready-${process.pid}-${Date.now()}.pid`,
  );
  let callbackRan = false;
  let rejected = false;
  let message = '';
  try {
    await withProxy({
      proxyBin: FAKE_READY_PROXY,
      readyTimeoutMs: 500,
      env: {
        FAKE_READY_PORT: String(readyPort),
        FAKE_READY_PID_FILE: pidFile,
        FAKE_READY_DELAY_MS: '1000',
      },
    }, async () => { callbackRan = true; });
  } catch (e) {
    rejected = true;
    message = e.message;
  }

  try {
    assert(rejected, 'pre-READY timeout rejects');
    assert(/timed out after \d+ms waiting for READY line/.test(message),
      `pre-READY failure identifies its consumed budget (got: ${message})`);
    assert(!callbackRan, 'test callback never runs before READY');
    assert(fs.existsSync(pidFile), 'pre-READY child recorded its PID');
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert(!pidIsAlive(pid), `pre-READY child ${pid} was dead when rejection surfaced`);
    }
  } finally {
    try { fs.rmSync(pidFile, { force: true }); } catch {}
  }
}

// ── Tiny raw-server helper (NOT startStubServer — that's under test below) ──
function rawServer(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, server, close: () => new Promise(r => server.close(r)) });
    });
  });
}

async function testWaitForPing() {
  console.log('waitForPing');

  // (a) Closed port → ECONNREFUSED loop → rejects at ~timeoutMs (not instant,
  //     not hung).
  {
    const port = await getFreePort(); // bound then released → nothing listening
    const t0 = Date.now();
    let rejected = false, msg = '';
    try { await waitForPing(port, 250); } catch (e) { rejected = true; msg = e.message; }
    const elapsed = Date.now() - t0;
    assert(rejected, '(a) closed port rejects');
    assert(/timed out/.test(msg), `(a) rejection names the timeout (got: ${msg})`);
    assert(msg.includes('after 250ms'), `(a) explicit 250ms override is honored (got: ${msg})`);
    assert(elapsed >= 200, `(a) ran the full ~250ms budget, not instant (got ${elapsed}ms)`);
    assert(elapsed < 2000, `(a) did not hang past the budget (got ${elapsed}ms)`);
  }

  // (b) accept-then-reset → resolves WELL within the deadline. This is the
  //     biting guard: ECONNRESET must retry on the next tick (~immediate), not
  //     fall through to slow backoff. With the ECONNRESET clause reverted,
  //     4 resets cost ~460ms of backoff and blow the <250ms assertion.
  {
    let reqs = 0;
    const RESETS = 4;
    const srv = await rawServer((req, res) => {
      reqs++;
      if (reqs <= RESETS) { req.socket.destroy(); return; } // RST → client ECONNRESET
      res.writeHead(200); res.end('ok');
    });
    try {
      const t0 = Date.now();
      let resolved = false;
      try { await waitForPing(srv.port, 1000); resolved = true; } catch {}
      const elapsed = Date.now() - t0;
      assert(resolved, '(b) accept-then-reset eventually resolves');
      assert(elapsed < 250, `(b) ECONNRESET retried fast (next-tick), not slow-backoff (got ${elapsed}ms; reverting the clause yields ~460ms)`);
      assert(reqs >= RESETS + 1, `(b) survived ${RESETS} resets then got a clean 200 (saw ${reqs} reqs)`);
    } finally { await srv.close(); }
  }

  // (c) slow-then-200 → resolves once the (latent) endpoint answers.
  {
    const srv = await rawServer((req, res) => {
      setTimeout(() => { res.writeHead(200); res.end('ok'); }, 120);
    });
    try {
      const t0 = Date.now();
      let resolved = false;
      try { await waitForPing(srv.port, 1000); resolved = true; } catch {}
      const elapsed = Date.now() - t0;
      assert(resolved, '(c) slow 200 resolves');
      assert(elapsed >= 100, `(c) actually waited for the slow response (got ${elapsed}ms)`);
    } finally { await srv.close(); }
  }
}

async function testHttpJsonTimeoutOverride() {
  console.log('\nhttpJson timeout override');
  const srv = await rawServer(() => {
    // Intentionally leave the response open so the client's explicit timeout
    // is the only completion path.
  });
  try {
    const t0 = Date.now();
    let rejected = false, msg = '';
    try {
      await httpJson(srv.port, 'GET', '/never-responds', null, {}, 100);
    } catch (e) {
      rejected = true;
      msg = e.message;
    }
    const elapsed = Date.now() - t0;
    assert(rejected, 'hung request rejects');
    assert(msg.includes('timed out after 100ms'),
      `explicit 100ms override is honored (got: ${msg})`);
    assert(elapsed >= 75, `timeout is not immediate (got ${elapsed}ms)`);
    assert(elapsed < 2000, `timeout remains bounded (got ${elapsed}ms)`);
  } finally {
    await srv.close();
  }
}

async function testStartStubServer() {
  console.log('\nstartStubServer');

  // Precedence + route forms in one server (with a '*' fallback).
  const stub = await startStubServer({
    'GET /a':   { who: 'method-path' },          // method+path key beats bare path
    '/a':       { who: 'bare' },                 // bare path beats '*'
    'GET /str': '{"raw":"string-form"}',         // string → sent verbatim
    'GET /obj': { obj: true },                   // object → JSON.stringify'd
    'GET /fn':  (req, res) => {                   // function → owns the response
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fn: true }));
    },
    '*':        { who: 'star' },                 // catch-all
  });
  try {
    const ra = await httpJson(stub.port, 'GET', '/a');
    assertEq(ra.json.who, 'method-path', 'precedence: "GET /a" beats bare "/a" and "*"');

    const rb = await httpJson(stub.port, 'POST', '/a');
    assertEq(rb.json.who, 'bare', 'precedence: bare "/a" beats "*" when no method key matches');

    const rz = await httpJson(stub.port, 'GET', '/unmapped');
    assertEq(rz.json.who, 'star', 'precedence: "*" catches an unmapped path');

    const rstr = await httpJson(stub.port, 'GET', '/str');
    assertEq(rstr.bodyText, '{"raw":"string-form"}', 'string route sent verbatim');
    assertEq(rstr.json.raw, 'string-form', 'string route parses as the intended JSON');

    const robj = await httpJson(stub.port, 'GET', '/obj');
    assertEq(robj.json.obj, true, 'object route JSON.stringify\'d');

    const rfn = await httpJson(stub.port, 'GET', '/fn');
    assertEq(rfn.status, 201, 'function route owns the status code');
    assertEq(rfn.json.fn, true, 'function route owns the body');

    // Request log records method + path + parsed body.
    await httpJson(stub.port, 'POST', '/log?q=1', { hello: 'world' });
    const last = stub.requests[stub.requests.length - 1];
    assertEq(last.method, 'POST', 'request log records method');
    assertEq(last.path, '/log', 'request log records path with query stripped');
    assertEq(last.url, '/log?q=1', 'request log keeps the raw url (query intact)');
    assert(last.body && last.body.hello === 'world', 'request log records the parsed JSON body');
  } finally { await stub.close(); }

  // 404 fallback when there is no '*' route.
  const strict = await startStubServer({ 'GET /known': { ok: true } });
  try {
    const r404 = await httpJson(strict.port, 'GET', '/unknown');
    assertEq(r404.status, 404, 'no "*" route → unmatched path 404s');
    assertEq(r404.bodyText, '{}', '404 body is "{}"');
  } finally { await strict.close(); }
}

async function testSpawnCapture() {
  console.log('\nspawnCapture');
  const node = process.execPath;

  // stdout + non-zero exit: captures both, resolves (never rejects).
  {
    const r = await spawnCapture(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(7)']);
    assertEq(r.status, 7, 'captures non-zero exit status');
    assert(r.stdout.includes('out'), 'captures stdout');
    assert(r.stderr.includes('err'), 'captures stderr');
  }

  // timeout SIGKILLs a hung child → status null, signal SIGKILL.
  {
    const t0 = Date.now();
    const r = await spawnCapture(node, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 200 });
    const elapsed = Date.now() - t0;
    assertEq(r.signal, 'SIGKILL', 'timeout SIGKILLs the child');
    assertEq(r.status, null, 'signal-killed child has null status');
    assert(elapsed < 2000, `timeout fired near the deadline, not late (got ${elapsed}ms)`);
  }
}

function testModelTestTimeout() {
  console.log('\nmodelTestTimeoutMs');
  const previous = process.env.C_THRU_MODEL_TEST_TIMEOUT_MS;
  try {
    delete process.env.C_THRU_MODEL_TEST_TIMEOUT_MS;
    assertEq(modelTestTimeoutMs(), 3_600_000, 'defaults model generation waits to one hour');
    assertEq(modelTestTimeoutMs(1234), 1234, 'caller can preserve a narrower non-live fallback');

    process.env.C_THRU_MODEL_TEST_TIMEOUT_MS = '987654';
    assertEq(modelTestTimeoutMs(), 987654, 'C_THRU_MODEL_TEST_TIMEOUT_MS overrides model wait');
    const proxyEnv = modelTestProxyEnv();
    assertEq(proxyEnv.C_THRU_MODEL_TEST_TIMEOUT_MS, '987654',
      'same override reaches c-thru launcher warm-up waits');
    assertEq(proxyEnv.CLAUDE_PROXY_ANTHROPIC_TIMEOUT_MS, '987654',
      'same override reaches Anthropic-shape proxy watchdog');
    assertEq(proxyEnv.CLAUDE_PROXY_GEMINI_TIMEOUT_MS, '987654',
      'same override reaches Gemini proxy watchdog');
    assertEq(proxyEnv.CLAUDE_PROXY_RESPONSES_TIMEOUT_MS, '987654',
      'same override reaches Responses proxy watchdog');
    assertEq(proxyEnv.CLAUDE_PROXY_OLLAMA_TTFT_MS, '987654',
      'same override reaches local-model TTFT watchdog');
    assertEq(proxyEnv.CLAUDE_PROXY_STREAM_WALL_MS, '987654',
      'same override reaches absolute stream wall clock');

    process.env.C_THRU_MODEL_TEST_TIMEOUT_MS = 'not-a-number';
    let invalidRejected = false;
    try { modelTestTimeoutMs(); } catch (e) {
      invalidRejected = /positive integer/.test(e.message);
    }
    assert(invalidRejected, 'rejects an invalid timeout instead of silently using a short timer');

    process.env.C_THRU_MODEL_TEST_TIMEOUT_MS = '3600001';
    let overCapRejected = false;
    try { modelTestTimeoutMs(); } catch (e) {
      overCapRejected = /3600000/.test(e.message);
    }
    assert(overCapRejected, 'rejects overrides above the one-hour hard cap');

    delete process.env.C_THRU_MODEL_TEST_TIMEOUT_MS;
    let fallbackOverCapRejected = false;
    try { modelTestTimeoutMs(3_600_001); } catch (e) {
      fallbackOverCapRejected = /3600000/.test(e.message);
    }
    assert(fallbackOverCapRejected, 'rejects fallback values above the one-hour hard cap');
  } finally {
    if (previous === undefined) delete process.env.C_THRU_MODEL_TEST_TIMEOUT_MS;
    else process.env.C_THRU_MODEL_TEST_TIMEOUT_MS = previous;
  }
}

function testAgentContractParserHardening() {
  console.log('\nagent contract parser hardening');

  const recusalWithInstall = parseAgentContractResult([
    'STATUS: RECUSE',
    'REASON: plan_dir is missing',
    'INSTALL: provide a plan_dir and retry',
  ].join('\n'));
  assert(
    recusalWithInstall.valid &&
      recusalWithInstall.kind === 'recusal' &&
      recusalWithInstall.fields.INSTALL === 'provide a plan_dir and retry',
    'recusal contract accepts its documented INSTALL field',
  );

  const taskWithInstall = parseAgentContractResult([
    'TASK_STATUS: PARTIAL',
    'INSTALL: run setup before retrying',
  ].join('\n'));
  assert(
    !taskWithInstall.valid &&
      taskWithInstall.reason.includes('unexpected field "INSTALL"'),
    'normal task contract remains strict and rejects INSTALL',
  );

  const contradictoryReasons = parseAgentContractResult([
    'STATUS: RECUSE',
    'REASON: plan_dir is missing',
    'REASON: plan_dir is present',
  ].join('\n'));
  assert(
    !contradictoryReasons.valid &&
      contradictoryReasons.reason.includes('duplicate field "REASON"'),
    'recusal contract rejects contradictory duplicate REASON fields',
  );
  const contradictoryReasonAliases = parseAgentContractResult([
    'STATUS: RECUSE',
    'REASON: plan_dir is missing',
    'RECUSAL_REASON: plan_dir is present',
  ].join('\n'));
  assert(
    !contradictoryReasonAliases.valid &&
      contradictoryReasonAliases.reason.includes('duplicate field "RECUSAL_REASON"'),
    'recusal contract rejects contradictory REASON aliases',
  );

  const duplicateCompleted = parseAgentContractResult([
    'TASK_STATUS: COMPLETE',
    'COMPLETED: first claim',
    'COMPLETED: contradictory second claim',
  ].join('\n'));
  assert(
    !duplicateCompleted.valid &&
      duplicateCompleted.reason.includes('duplicate field "COMPLETED"'),
    'normal task contract rejects duplicate COMPLETED fields',
  );

  const secretCases = [
    ['Bearer', 'bearer-secret-material', 'Authorization: Bearer bearer-secret-material'],
    ['credential assignment', 'assigned-secret-material', 'OPENAI_API_KEY=assigned-secret-material'],
    ['sk token', 'sk-standalone-secret-material', 'sk-standalone-secret-material'],
    ['AIza token', 'AIzaStandaloneSecretMaterial1234567890', 'AIzaStandaloneSecretMaterial1234567890'],
    ['GitHub token', 'ghp_standalonesecretmaterial123456', 'ghp_standalonesecretmaterial123456'],
    ['GitHub fine-grained token', 'github_pat_standalonesecretmaterial123456', 'github_pat_standalonesecretmaterial123456'],
  ];
  for (const [label, secret, trailingLine] of secretCases) {
    const result = parseAgentContractResult([
      'TASK_STATUS: COMPLETE',
      trailingLine,
    ].join('\n'));
    assert(
      !result.valid &&
        result.reason.includes('[REDACTED]') &&
        !result.reason.includes(secret),
      `trailing standalone ${label} is redacted from parser diagnostics`,
    );
  }

  const invalidStatusSecret = 'sk-invalid-status-secret-material';
  const invalidStatus = parseAgentContractResult(`TASK_STATUS: ${invalidStatusSecret}`);
  assert(
    !invalidStatus.valid &&
      invalidStatus.reason.includes('[REDACTED]') &&
      !invalidStatus.reason.includes(invalidStatusSecret),
    'invalid TASK_STATUS values are sanitized before entering result.reason',
  );

  const bounded = boundedDiagnosticSnippet(
    `Authorization: Bearer bounded-secret-material ${'x'.repeat(300)}`,
    80,
  );
  assert(
    bounded.length <= 80 &&
      bounded.includes('[REDACTED]') &&
      !bounded.includes('bounded-secret-material'),
    'exported diagnostic sanitizer redacts before applying its hard length bound',
  );
}

async function main() {
  console.log('helpers.js self-test\n');
  testHermeticTimeoutDefaults();
  await testTerminateAndReapBound();
  await testSpawnProxyReadyBudget();
  await testWithProxyFailedStartupCleanup();
  await testWithProxyPreReadyCleanup();
  await testWaitForPing();
  await testHttpJsonTimeoutOverride();
  await testStartStubServer();
  await testSpawnCapture();
  testModelTestTimeout();
  testAgentContractParserHardening();
  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
