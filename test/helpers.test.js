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
// Deterministic + stdlib-only: raw http servers + node -e children, no proxy,
// no network, no fixtures.
//
// Run: node test/helpers.test.js

const { assert, assertEq, summary, getFreePort, startStubServer, spawnCapture, waitForPing, httpJson } = require('./helpers');
const http = require('http');

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
      try { await waitForPing(srv.port, 5000); resolved = true; } catch {}
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
      try { await waitForPing(srv.port, 5000); resolved = true; } catch {}
      const elapsed = Date.now() - t0;
      assert(resolved, '(c) slow 200 resolves');
      assert(elapsed >= 100, `(c) actually waited for the slow response (got ${elapsed}ms)`);
    } finally { await srv.close(); }
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

async function main() {
  console.log('helpers.js self-test\n');
  await testWaitForPing();
  await testStartStubServer();
  await testSpawnCapture();
  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
