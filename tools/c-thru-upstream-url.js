#!/usr/bin/env node
'use strict';
/**
 * Shared Anthropic-upstream URL helpers for launcher, ensure-on-port, and tests.
 *
 * CLI:
 *   node tools/c-thru-upstream-url.js eligible <url>     # exit 0/1
 *   node tools/c-thru-upstream-url.js fingerprint <url>  # print sha256[:16]
 *   node tools/c-thru-upstream-url.js is-loopback <host> # exit 0/1
 *
 * Env (eligible):
 *   C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM=1
 *   C_THRU_ALLOW_LOOPBACK_ANTHROPIC_UPSTREAM=1
 *   C_THRU_UPSTREAM_FORCE_ANTHROPIC_COM=1
 */

const crypto = require('crypto');

function isLoopback(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (h.endsWith('.localhost')) return true;
  // Dotted-quad and short forms (127, 127.1, 127.0.0.1) — refuse as override hosts.
  if (/^127(\.\d{1,3}){0,3}$/.test(h)) return true;
  if (h.startsWith('::ffff:127.')) return true;
  return false;
}

function isAnthropic(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'anthropic.com' || h.endsWith('.anthropic.com');
}

/**
 * @param {string} raw
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isEligible(raw, env) {
  const e = env || process.env;
  const allowInsecure = e.C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM === '1';
  const allowLoopback = e.C_THRU_ALLOW_LOOPBACK_ANTHROPIC_UPSTREAM === '1';
  const forceAnthropic = e.C_THRU_UPSTREAM_FORCE_ANTHROPIC_COM === '1';
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (isLoopback(u.hostname) && !allowLoopback) return false;
  if (
    !forceAnthropic &&
    isAnthropic(u.hostname) &&
    (u.pathname === '/' || u.pathname === '') &&
    !u.search &&
    !u.hash
  ) {
    return false; // no-op ambient default
  }
  if (u.protocol === 'http:' && !allowInsecure && !isLoopback(u.hostname)) return false;
  return true;
}

function fingerprint(raw) {
  let s = String(raw || '');
  try {
    s = new URL(s).toString();
  } catch {
    /* keep raw */
  }
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function agentTokenFingerprint(token) {
  if (!token || Buffer.byteLength(String(token), 'utf8') < 32) return '';
  return crypto
    .createHash('sha256')
    .update('c-thru-agent-token-identity-v1\0', 'utf8')
    .update(String(token), 'utf8')
    .digest('hex');
}

/**
 * Whether /ping JSON is safe to kill for ensure-on-port respawn.
 * @param {object} ping
 * @param {{ expectedFingerprint: string, expectedVersion?: string, listenPids?: number[] }} opts
 */
function killAllowedFromPing(ping, opts) {
  const expectedFp = opts && opts.expectedFingerprint;
  const expectedVer = (opts && opts.expectedVersion) || '1';
  if (!ping || typeof ping !== 'object') {
    return { ok: false, reason: 'no_ping' };
  }
  const id = ping.agent_token_identity;
  if (!id || typeof id !== 'object') {
    return { ok: false, reason: 'missing_agent_token_identity' };
  }
  if (String(id.version || '') !== String(expectedVer)) {
    return { ok: false, reason: 'version_mismatch' };
  }
  if (!expectedFp || String(id.fingerprint || '') !== String(expectedFp)) {
    return { ok: false, reason: 'fingerprint_mismatch' };
  }
  const pid = Number(ping.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { ok: false, reason: 'bad_pid' };
  }
  const listenPids = (opts && opts.listenPids) || null;
  if (Array.isArray(listenPids) && listenPids.length > 0) {
    if (!listenPids.map(Number).includes(pid)) {
      return { ok: false, reason: 'pid_not_listener', pid };
    }
  }
  return { ok: true, pid };
}

function main(argv) {
  const cmd = argv[2] || '';
  if (cmd === 'eligible') {
    process.exit(isEligible(argv[3] || '') ? 0 : 1);
  }
  if (cmd === 'fingerprint') {
    process.stdout.write(fingerprint(argv[3] || ''));
    return;
  }
  if (cmd === 'is-loopback') {
    process.exit(isLoopback(argv[3] || '') ? 0 : 1);
  }
  if (cmd === 'agent-token-fp') {
    let token = '';
    if (!process.stdin.isTTY) {
      token = require('fs').readFileSync(0, 'utf8');
    } else {
      token = argv[3] || '';
    }
    const fp = agentTokenFingerprint(token);
    if (!fp) process.exit(1);
    process.stdout.write(fp);
    return;
  }
  if (cmd === 'kill-allowed') {
    // stdin: ping JSON; argv[3]=expectedFp; argv[4]=comma listen pids optional
    const body = require('fs').readFileSync(0, 'utf8');
    let ping = {};
    try {
      ping = JSON.parse(body || '{}');
    } catch {
      process.exit(2);
    }
    const listenPids = (argv[4] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    const r = killAllowedFromPing(ping, {
      expectedFingerprint: argv[3] || '',
      listenPids: listenPids.length ? listenPids : null,
    });
    if (!r.ok) {
      process.stderr.write(r.reason + '\n');
      process.exit(1);
    }
    process.stdout.write(String(r.pid));
    return;
  }
  process.stderr.write(
    'usage: c-thru-upstream-url.js eligible|fingerprint|is-loopback|agent-token-fp|kill-allowed …\n',
  );
  process.exit(2);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  isLoopback,
  isAnthropic,
  isEligible,
  fingerprint,
  agentTokenFingerprint,
  killAllowedFromPing,
};
