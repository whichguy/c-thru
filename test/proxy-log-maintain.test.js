#!/usr/bin/env node
'use strict';
// Unit tests for tools/proxy-log-maintain.js (age prune + size rotate).
// Run: node test/proxy-log-maintain.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  proxyLogLineTimeMs,
  filterProxyLogTextByAge,
  agePruneProxyLogFile,
  unlinkIfOlderThan,
  sizeRotateProxyLogFile,
  withExclusiveFileLock,
  maintainProxyLogFile,
  prepareBufferedResponseHeaders,
  DEFAULT_MAX_AGE_MS,
} = require('../tools/proxy-log-maintain.js');

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed++; }
}

console.log('1. proxyLogLineTimeMs');
{
  const t = proxyLogLineTimeMs('2026-07-14T14:03:24.505Z c-thru [request] {}');
  ok(t === Date.parse('2026-07-14T14:03:24.505Z'), 'parses full ISO with ms');
  ok(proxyLogLineTimeMs('not a log line') === null, 'null on garbage');
  ok(proxyLogLineTimeMs('') === null, 'null on empty');
}

console.log('\n2. filterProxyLogTextByAge');
{
  const old = '2026-06-01T00:00:00.000Z c-thru [old] {}\n';
  const mid = '2026-07-10T12:00:00.000Z c-thru [mid] {}\n';
  const neu = '2026-07-14T12:00:00.000Z c-thru [new] {}\n';
  const cutoff = Date.parse('2026-07-07T00:00:00.000Z'); // keep mid+new
  const r = filterProxyLogTextByAge(old + mid + neu, cutoff);
  ok(r.dropped === 1, 'drops one old line (got ' + r.dropped + ')');
  ok(r.kept === 2, 'keeps two lines (got ' + r.kept + ')');
  ok(r.changed === true, 'changed');
  ok(!r.text.includes('[old]'), 'old line gone');
  ok(r.text.includes('[mid]') && r.text.includes('[new]'), 'mid+new kept');
  ok(r.text.endsWith('\n'), 'preserves trailing newline');

  const r2 = filterProxyLogTextByAge(mid + neu, cutoff);
  ok(r2.changed === false && r2.dropped === 0, 'no-op when all in window');

  const bare = 'no-timestamp-line\n' + neu;
  const r3 = filterProxyLogTextByAge(bare, cutoff);
  ok(r3.text.includes('no-timestamp-line'), 'unparseable lines kept');
}

console.log('\n3. agePruneProxyLogFile + sizeRotate + unlinkIfOlderThan (fs)');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-logmaint-'));
  try {
    const logPath = path.join(dir, 'proxy.log');
    const now = Date.parse('2026-07-14T12:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    const lines = [];
    for (let i = 20; i >= 0; i--) {
      const ts = new Date(now - i * day).toISOString();
      lines.push(`${ts} c-thru [day] {"i":${i}}`);
    }
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    const cutoff = now - 14 * day;
    const pr = agePruneProxyLogFile(logPath, cutoff);
    ok(pr.pruned === true, 'pruned aged file');
    ok(pr.dropped === 6, 'dropped days 20..15 (6 lines), got ' + pr.dropped);
    // kept: days 14..0 = 15 lines
    ok(pr.kept === 15, 'kept 15 lines (got ' + pr.kept + ')');
    const body = fs.readFileSync(logPath, 'utf8');
    ok(!body.includes('"i":20') && !body.includes('"i":15'), 'oldest gone');
    ok(body.includes('"i":14') && body.includes('"i":0'), 'window edges kept');

    // size rotate
    fs.writeFileSync(logPath, 'x'.repeat(1000));
    const rotated = sizeRotateProxyLogFile(logPath, 500);
    ok(rotated === true, 'size rotate when over cap');
    ok(!fs.existsSync(logPath), 'main gone after rename');
    ok(fs.existsSync(logPath + '.old'), '.old exists');

    // ancient .old deleted by mtime — set mtime into the past
    const oldPath = logPath + '.old';
    const ancient = now - 20 * day;
    fs.utimesSync(oldPath, new Date(ancient / 1000), new Date(ancient / 1000));
    const del = unlinkIfOlderThan(oldPath, 14 * day, now);
    ok(del === true, 'unlinks .old older than max age');
    ok(!fs.existsSync(oldPath), '.old removed');

    // maintainProxyLogFile end-to-end
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
    const m = maintainProxyLogFile({
      filePath: logPath,
      maxAgeMs: 14 * day,
      maxBytes: 10 * 1024 * 1024,
      nowMs: now,
      doAgePrune: true,
    });
    ok(m.agePruned === true, 'maintain age-pruned');
    ok(fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length === 15,
      'maintain left 15 lines');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n4. defaults');
{
  ok(DEFAULT_MAX_AGE_MS === 14 * 24 * 60 * 60 * 1000, 'default max age is 14 days');
}

console.log('\n5. prepareBufferedResponseHeaders');
{
  const h = prepareBufferedResponseHeaders({
    'Content-Type': 'application/json',
    'Transfer-Encoding': 'chunked',
    Connection: 'keep-alive',
    'Content-Length': '999',
    'x-request-id': 'abc',
  }, 42);
  ok(h['content-length'] === '42', 'sets content-length to body bytes');
  ok(h['Transfer-Encoding'] == null && h['transfer-encoding'] == null, 'strips transfer-encoding');
  ok(h.Connection == null && h.connection == null, 'strips connection');
  ok(h['Content-Type'] === 'application/json', 'keeps content-type');
  ok(h['x-request-id'] === 'abc', 'keeps custom headers');
}

console.log('\n6. withExclusiveFileLock + maintain skip when locked');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-loglock-'));
  try {
    const lockPath = path.join(dir, 'proxy.log.lock');
    fs.writeFileSync(lockPath, '1', { flag: 'wx' });
    const r = withExclusiveFileLock(lockPath, () => 'ran');
    ok(r.skipped === true, 'skips when lock held');
    fs.unlinkSync(lockPath);
    const r2 = withExclusiveFileLock(lockPath, () => 7);
    ok(r2.skipped === false && r2.result === 7, 'runs when lock free');
    ok(!fs.existsSync(lockPath), 'lock released after run');

    // maintain under held lock
    const logPath = path.join(dir, 'proxy.log');
    fs.writeFileSync(logPath, '2026-07-14T00:00:00.000Z c-thru [x] {}\n');
    fs.writeFileSync(logPath + '.lock', 'holder', { flag: 'wx' });
    const m = maintainProxyLogFile({
      filePath: logPath,
      doAgePrune: true,
      maxAgeMs: 14 * 864e5,
      maxBytes: 1e9,
    });
    ok(m.skipped === true, 'maintain skips when lock held');
    fs.unlinkSync(logPath + '.lock');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failed ? `\nFAILED (${failed})` : '\nAll proxy-log-maintain tests passed');
process.exit(failed ? 1 : 0);
