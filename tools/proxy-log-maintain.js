'use strict';
// Pure helpers + fs maintenance for ~/.claude/proxy.log retention.
// - Drop log lines older than maxAgeMs (default 14d), keyed off the leading ISO ts.
// - Size-rotate into path.old (replacing previous .old).
// - Delete .old when its mtime is older than maxAgeMs.
// Stdlib-only; safe to call frequently (age prune is caller-throttled).

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const ISO_LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/;

/**
 * Parse the leading ISO-8601 timestamp from a proxy.log line.
 * @param {string} line
 * @returns {number|null} epoch ms, or null if unparseable
 */
function proxyLogLineTimeMs(line) {
  if (typeof line !== 'string' || !line) return null;
  const m = ISO_LINE_RE.exec(line);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

/**
 * Keep lines with ts >= cutoffMs. Lines without a parseable ts are kept
 * (startup noise / partial writes) so we never invent data loss for them.
 * @param {string} text
 * @param {number} cutoffMs
 * @returns {{ text: string, kept: number, dropped: number, changed: boolean }}
 */
function filterProxyLogTextByAge(text, cutoffMs) {
  if (text == null || text === '') {
    return { text: '', kept: 0, dropped: 0, changed: false };
  }
  const endsWithNl = text.endsWith('\n');
  // split keeps a trailing empty slot when endsWithNl — drop that synthetic slot
  const raw = text.split('\n');
  if (endsWithNl && raw.length && raw[raw.length - 1] === '') raw.pop();

  const keptLines = [];
  let dropped = 0;
  for (const line of raw) {
    const ts = proxyLogLineTimeMs(line);
    if (ts == null || ts >= cutoffMs) keptLines.push(line);
    else dropped++;
  }
  const out = keptLines.join('\n') + (keptLines.length || endsWithNl ? '\n' : '');
  // empty file: prefer "" over lone "\n"
  const textOut = keptLines.length === 0 ? '' : out;
  return {
    text: textOut,
    kept: keptLines.length,
    dropped,
    changed: dropped > 0,
  };
}

/**
 * Age-prune a log file in place (atomic write via tmp + rename).
 * @param {string} filePath
 * @param {number} cutoffMs
 * @param {{ fs?: typeof fs }} [deps]
 * @returns {{ pruned: boolean, dropped: number, kept: number }}
 */
function agePruneProxyLogFile(filePath, cutoffMs, deps) {
  const fsys = (deps && deps.fs) || fs;
  let raw;
  try {
    raw = fsys.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { pruned: false, dropped: 0, kept: 0 };
    throw e;
  }
  const result = filterProxyLogTextByAge(raw, cutoffMs);
  if (!result.changed) return { pruned: false, dropped: 0, kept: result.kept };

  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.prune.${process.pid}.${Date.now()}.tmp`);
  fsys.writeFileSync(tmp, result.text, 'utf8');
  fsys.renameSync(tmp, filePath);
  return { pruned: true, dropped: result.dropped, kept: result.kept };
}

/**
 * Delete path if it exists and mtime is older than maxAgeMs.
 * @param {string} filePath
 * @param {number} maxAgeMs
 * @param {number} [nowMs]
 * @param {{ fs?: typeof fs }} [deps]
 * @returns {boolean} true if deleted
 */
function unlinkIfOlderThan(filePath, maxAgeMs, nowMs, deps) {
  const fsys = (deps && deps.fs) || fs;
  const now = nowMs != null ? nowMs : Date.now();
  try {
    const st = fsys.statSync(filePath);
    if (now - st.mtimeMs > maxAgeMs) {
      fsys.unlinkSync(filePath);
      return true;
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') return false;
    throw e;
  }
  return false;
}

/**
 * Size-rotate: if filePath exceeds maxBytes, rename to filePath+".old"
 * (replacing any existing .old).
 * @param {string} filePath
 * @param {number} maxBytes
 * @param {{ fs?: typeof fs }} [deps]
 * @returns {boolean} true if rotated
 */
function sizeRotateProxyLogFile(filePath, maxBytes, deps) {
  const fsys = (deps && deps.fs) || fs;
  let st;
  try {
    st = fsys.statSync(filePath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return false;
    throw e;
  }
  if (st.size <= maxBytes) return false;
  const oldPath = filePath + '.old';
  try { fsys.unlinkSync(oldPath); } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  fsys.renameSync(filePath, oldPath);
  return true;
}

/**
 * Full maintenance pass for the ops log path.
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {number} [opts.maxAgeMs]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.nowMs]
 * @param {boolean} [opts.doAgePrune] — when false, only size-rotate + drop ancient .old by mtime
 * @param {{ fs?: typeof fs }} [opts.deps]
 */
function maintainProxyLogFile(opts) {
  const filePath = opts && opts.filePath;
  if (!filePath) return { agePruned: false, sizeRotated: false, oldDeleted: false };
  const maxAgeMs = opts.maxAgeMs != null ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const maxBytes = opts.maxBytes != null ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const doAgePrune = opts.doAgePrune !== false;
  const deps = opts.deps;

  const oldPath = filePath + '.old';
  let oldDeleted = false;
  try {
    oldDeleted = unlinkIfOlderThan(oldPath, maxAgeMs, nowMs, deps);
  } catch { /* best-effort */ }

  let agePruned = false;
  if (doAgePrune) {
    const cutoff = nowMs - maxAgeMs;
    try {
      const r = agePruneProxyLogFile(filePath, cutoff, deps);
      agePruned = r.pruned;
    } catch { /* best-effort */ }
    // .old may still hold ancient lines if mtime was refreshed by rename — filter too
    if (!oldDeleted) {
      try {
        agePruneProxyLogFile(oldPath, cutoff, deps);
      } catch { /* ENOENT or IO — ignore */ }
    }
  }

  let sizeRotated = false;
  try {
    sizeRotated = sizeRotateProxyLogFile(filePath, maxBytes, deps);
  } catch { /* best-effort */ }

  return { agePruned, sizeRotated, oldDeleted };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_BYTES,
  proxyLogLineTimeMs,
  filterProxyLogTextByAge,
  agePruneProxyLogFile,
  unlinkIfOlderThan,
  sizeRotateProxyLogFile,
  maintainProxyLogFile,
};
