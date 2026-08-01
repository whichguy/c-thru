#!/usr/bin/env node
'use strict';
// Hermetic unit tests for tools/c-thru-upstream-url.js (eligibility + kill-allowed).

const path = require('path');
const { assert, assertEq, summary } = require('./helpers');

const mod = require(path.join(__dirname, '..', 'tools', 'c-thru-upstream-url.js'));
const { isEligible, isLoopback, fingerprint, killAllowedFromPing, agentTokenFingerprint } = mod;

console.log('c-thru-upstream-url unit tests\n');

console.log('1. isLoopback covers mapped and short forms');
{
  assert(isLoopback('127.0.0.1'), '127.0.0.1');
  assert(isLoopback('127.1'), '127.1');
  assert(isLoopback('localhost'), 'localhost');
  assert(isLoopback('foo.localhost'), 'foo.localhost');
  assert(isLoopback('::ffff:127.0.0.1'), '::ffff:127.0.0.1');
  assert(isLoopback('[::1]'), '[::1]');
  assert(!isLoopback('gw.example'), 'gw.example');
  assert(!isLoopback('api.anthropic.com'), 'api.anthropic.com');
}

console.log('2. isEligible security matrix');
{
  const base = {};
  assert(!isEligible('https://localhost:8443', base), 'reject https localhost');
  assert(!isEligible('http://127.0.0.1/gw', base), 'reject loopback http');
  assert(!isEligible('http://[::ffff:127.0.0.1]/', base), 'reject mapped loopback');
  assert(!isEligible('https://SUB.LOCALHOST', base), 'reject .localhost');
  assert(!isEligible('https://127.1', base), 'reject short 127.1');
  assert(!isEligible('http://gw.example', base), 'reject plain http');
  assert(isEligible('https://gw.example', base), 'accept https gw');
  assert(
    isEligible('http://gw.example', { C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM: '1' }),
    'http + insecure opt-in',
  );
  assert(!isEligible('https://api.anthropic.com', base), 'ignore bare anthropic.com');
  assert(isEligible('https://api.anthropic.com/gw', base), 'anthropic + path ok');
  assert(
    isEligible('http://[::ffff:127.0.0.1]/', {
      C_THRU_ALLOW_LOOPBACK_ANTHROPIC_UPSTREAM: '1',
      C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM: '1',
    }),
    'mapped loopback with opts',
  );
}

console.log('3. fingerprint stable');
{
  const a = fingerprint('https://gw.example/v1');
  const b = fingerprint('https://gw.example/v1');
  assertEq(a.length, 16, 'fp length 16');
  assertEq(a, b, 'stable');
}

console.log('4. killAllowedFromPing identity + port ownership');
{
  const token = 'x'.repeat(40);
  const fp = agentTokenFingerprint(token);
  assert(fp.length === 64, 'agent fp hex');

  const good = {
    pid: 4242,
    agent_token_identity: { version: '1', fingerprint: fp },
  };
  let r = killAllowedFromPing(good, { expectedFingerprint: fp, listenPids: [4242] });
  assert(r.ok && r.pid === 4242, 'allow matching identity + listener pid');

  r = killAllowedFromPing(good, { expectedFingerprint: fp, listenPids: [9999] });
  assert(!r.ok && r.reason === 'pid_not_listener', 'refuse pid not on port');

  r = killAllowedFromPing(
    { pid: 1, agent_token_identity: { version: '1', fingerprint: 'deadbeef' } },
    { expectedFingerprint: fp, listenPids: [1] },
  );
  assert(!r.ok && r.reason === 'fingerprint_mismatch', 'refuse wrong token fp');

  r = killAllowedFromPing({ pid: 1 }, { expectedFingerprint: fp, listenPids: [1] });
  assert(!r.ok && r.reason === 'missing_agent_token_identity', 'refuse pre-upgrade / no identity');

  r = killAllowedFromPing(
    { pid: 777, agent_token_identity: { version: '1', fingerprint: fp } },
    { expectedFingerprint: fp, listenPids: [] },
  );
  // empty listenPids → skip port ownership check
  assert(r.ok && r.pid === 777, 'allow when lsof unavailable (empty listen list)');
}

const failed = summary();
process.exit(failed > 0 ? 1 : 0);
