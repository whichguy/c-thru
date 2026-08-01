#!/usr/bin/env node
'use strict';

// Zero-token plan/session state aggregation for the proxy dashboard.  This is
// deliberately a best-effort reader: hooks and planners must continue working
// when an interrupted write leaves any individual state file malformed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCurrentMd, parseWaveMd } = require('./c-thru-plan-harness.js');

const TAIL_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_LINES = 400;
const MAX_RECENT = 30;

function safeStat(file) { try { return fs.statSync(file); } catch (_) { return null; } }
function safeRead(file) { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } }
function safeDir(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; } }
function safeJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return parsed < 1e12 ? parsed * 1000 : parsed;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mtimeMs(file) { const stat = safeStat(file); return stat ? stat.mtimeMs : 0; }
function asArray(map) { return map instanceof Map ? [...map.values()] : []; }

function readTail(file, bytes) {
  let fd;
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - bytes);
    const buffer = Buffer.alloc(stat.size - start);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // First line began before our bounded read.
    return lines;
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

function newestMtime(dir) {
  let newest = mtimeMs(dir);
  for (const entry of safeDir(dir)) {
    const child = path.join(dir, entry.name);
    const stat = safeStat(child);
    if (!stat) continue;
    newest = Math.max(newest, stat.mtimeMs);
    if (entry.isDirectory() && !entry.isSymbolicLink()) newest = Math.max(newest, newestMtime(child));
  }
  return newest;
}

function titleFromMarkdown(markdown) {
  const heading = String(markdown || '').match(/^\s*#+\s+(.+)$/m);
  return heading ? heading[1].trim() : '';
}

function outputFromCurrent(markdown) {
  const lines = String(markdown || '').split('\n');
  const start = lines.findIndex(line => /^#{1,6}\s+Outcome\s*$/i.test(line));
  if (start < 0) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    body.push(line);
  }
  return body.join('\n').trim() || null;
}

function snapshotId(snapshot) {
  return typeof snapshot === 'string' ? path.basename(snapshot).replace(/\.md$/i, '') : null;
}

function readEvents(spoolDir) {
  const events = [];
  for (const file of ['events.1.ndjson', 'events.ndjson']) {
    const text = safeRead(path.join(spoolDir, file));
    if (text == null) continue;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event && event.event === 'plan_approved' && typeof event === 'object') events.push(event);
      } catch (_) {}
    }
  }
  return events.sort((a, b) => timestampMs(b.ts) - timestampMs(a.ts));
}

function readNotes(spoolDir) {
  const result = new Map();
  const root = path.join(spoolDir, 'notes');
  for (const key of safeDir(root)) {
    if (!key.isDirectory()) continue;
    const notes = [];
    for (const file of safeDir(path.join(root, key.name))) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue;
      const content = safeRead(path.join(root, key.name, file.name));
      if (content == null) continue;
      const match = content.match(/^---\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
      const frontmatter = match ? match[1] : '';
      const field = name => {
        const m = frontmatter.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'));
        return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
      };
      notes.push({
        ts: field('ts') || new Date(mtimeMs(path.join(root, key.name, file.name))).toISOString(),
        author: field('author') || null,
        md: match ? match[2].trim() : content.trim(),
      });
    }
    result.set(key.name, notes.sort((a, b) => timestampMs(b.ts) - timestampMs(a.ts)));
  }
  return result;
}

function readActivity(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  const lines = readTail(transcriptPath, TAIL_BYTES);
  if (lines == null) return null;
  const recent = [];
  let todos = null;
  let todoFallback = null;
  for (const line of lines.slice(-MAX_TRANSCRIPT_LINES)) {
    if (!line.trim()) continue;
    let envelope;
    try { envelope = JSON.parse(line); } catch (_) { continue; }
    if (Array.isArray(envelope.toolUseResult && envelope.toolUseResult.newTodos)) {
      todos = envelope.toolUseResult.newTodos;
    }
    if (envelope.type !== 'assistant') continue;
    const content = envelope.message && Array.isArray(envelope.message.content) ? envelope.message.content : [];
    for (const part of content) {
      if (!part || part.type !== 'tool_use') continue;
      const input = part.input && typeof part.input === 'object' ? part.input : {};
      const raw = input.description || input.command || input.file_path || '';
      const detail = String(raw).replace(/\s+/g, ' ').slice(0, 120);
      recent.push({ ts: envelope.timestamp || null, name: part.name || '', detail });
      if (part.name === 'TodoWrite' && Array.isArray(input.todos)) todoFallback = input.todos;
    }
  }
  return {
    transcript_path: transcriptPath,
    recent: recent.slice(-MAX_RECENT),
    todos: todos || todoFallback || [],
  };
}

function newestWaveFile(wavesDir) {
  let newest = null;
  for (const dir of safeDir(wavesDir)) {
    if (!dir.isDirectory()) continue;
    const file = path.join(wavesDir, dir.name, 'wave.md');
    const stat = safeStat(file);
    if (stat && (!newest || stat.mtimeMs > newest.mtime)) newest = { file, mtime: stat.mtimeMs };
  }
  return newest;
}

function scanWaves(tmpRoots) {
  const roots = [];
  const seen = new Set();
  for (const root of tmpRoots) {
    try {
      const real = fs.realpathSync(root);
      if (!seen.has(real)) { seen.add(real); roots.push(real); }
    } catch (_) {}
  }

  const waves = [];
  for (const root of roots) {
    const cthru = path.join(root, 'c-thru');
    for (const repoDir of safeDir(cthru)) {
      if (!repoDir.isDirectory()) continue;
      const repoPath = path.join(cthru, repoDir.name);
      for (const slugDir of safeDir(repoPath)) {
        if (!slugDir.isDirectory()) continue;
        const stateDir = path.join(repoPath, slugDir.name);
        const currentText = safeRead(path.join(stateDir, 'current.md'));
        let items = null;
        try { items = currentText == null ? null : asArray(parseCurrentMd(currentText)); } catch (_) {}
        const meta = safeJson(path.join(stateDir, 'meta.json'));
        const waveFile = newestWaveFile(path.join(stateDir, 'waves'));
        let currentWave = null;
        if (waveFile) {
          try {
            const parsed = parseWaveMd(fs.readFileSync(waveFile.file, 'utf8'));
            currentWave = { id: parsed.wave_id, steps: asArray(parsed.items) };
          } catch (_) {}
        }
        const journalLines = readTail(path.join(stateDir, 'journal.md'), 32 * 1024);
        waves.push({
          repo: repoDir.name,
          slug: slugDir.name,
          last_activity_ms: newestMtime(stateDir),
          wave: {
            slug: slugDir.name,
            status: meta && meta.status != null ? meta.status : null,
            revision_rounds: meta && Number.isFinite(meta.revision_rounds) ? meta.revision_rounds : null,
            wave_count: meta && Number.isFinite(meta.wave_count) ? meta.wave_count : null,
            outcome: outputFromCurrent(currentText),
            items,
            current_wave: currentWave,
            journal_tail: journalLines ? journalLines.filter(Boolean).slice(-20) : [],
          },
        });
      }
    }
  }
  return waves;
}

function nativeRecord(event, spoolDir) {
  const snapshot = typeof event.snapshot === 'string' && path.basename(event.snapshot) === event.snapshot
    ? event.snapshot : null;
  const snapshotPath = snapshot ? path.join(spoolDir, snapshot) : null;
  const planMd = snapshotPath ? safeRead(snapshotPath) : null;
  const cwd = typeof event.cwd === 'string' ? event.cwd : null;
  const repo = typeof event.repo === 'string' && event.repo ? event.repo : (cwd ? path.basename(cwd) : 'unknown');
  return {
    repo, cwd, session_id: event.session_id || null, transcript_path: event.transcript_path || null,
    approved_ms: timestampMs(event.ts),
    activity_ms: Math.max(timestampMs(event.ts), mtimeMs(event.transcript_path)),
    event,
    native: {
      title: event.title || titleFromMarkdown(planMd),
      approved_at: event.ts || null,
      plan_md: planMd,
      snapshot_path: snapshotPath,
    },
  };
}

function makePlan({ repo, nativeRecord: native, waveRecord: wave, joined, notesByKey }) {
  const keys = [];
  if (wave) keys.push(wave.slug);
  if (native) {
    const key = snapshotId(native.event.snapshot);
    if (key) keys.push(key);
  }
  const notes = [];
  const noteSeen = new Set();
  for (const key of keys) for (const note of notesByKey.get(key) || []) {
    const id = `${key}\u0000${note.ts}\u0000${note.md}`;
    if (!noteSeen.has(id)) { noteSeen.add(id); notes.push(note); }
  }
  notes.sort((a, b) => timestampMs(b.ts) - timestampMs(a.ts));
  const lastMs = Math.max(native ? native.activity_ms : 0, wave ? wave.last_activity_ms : 0);
  return {
    repo,
    cwd: native ? native.cwd : null,
    session_id: native ? native.session_id : null,
    last_activity_ts: lastMs ? new Date(lastMs).toISOString() : null,
    joined,
    native: native ? native.native : null,
    wave: wave ? wave.wave : null,
    activity: native ? readActivity(native.transcript_path) : null,
    notes,
  };
}

function aggregatePlanState({ home, tmpRoots, spoolDir } = {}) {
  try {
    const resolvedHome = home || os.homedir();
    const resolvedSpool = spoolDir || process.env.C_THRU_PLAN_SPOOL || path.join(resolvedHome, '.claude', 'c-thru', 'plan-events');
    const resolvedTmpRoots = tmpRoots || [process.env.TMPDIR || '/tmp', '/tmp'];
    const notesByKey = readNotes(resolvedSpool);
    const natives = readEvents(resolvedSpool).map(event => nativeRecord(event, resolvedSpool));
    const waves = scanWaves(resolvedTmpRoots);
    const repos = new Set([...natives.map(n => n.repo), ...waves.map(w => w.repo)]);
    const plans = [];
    for (const repo of repos) {
      // Pair by approval time, not transcript activity. An older plan's
      // transcript may continue receiving tool output after a newer approval.
      const repoNatives = natives.filter(n => n.repo === repo).sort((a, b) => b.approved_ms - a.approved_ms);
      const repoWaves = waves.filter(w => w.repo === repo).sort((a, b) => b.last_activity_ms - a.last_activity_ms);
      if (repoNatives.length && repoWaves.length) {
        plans.push(makePlan({ repo, nativeRecord: repoNatives.shift(), waveRecord: repoWaves.shift(), joined: true, notesByKey }));
      }
      for (const native of repoNatives) plans.push(makePlan({ repo, nativeRecord: native, waveRecord: null, joined: false, notesByKey }));
      for (const wave of repoWaves) plans.push(makePlan({ repo, nativeRecord: null, waveRecord: wave, joined: false, notesByKey }));
    }
    plans.sort((a, b) => timestampMs(b.last_activity_ts) - timestampMs(a.last_activity_ts));
    return { ok: true, generated_at: new Date().toISOString(), plans };
  } catch (_) {
    // A control-plane read must never turn planner/proxy state corruption into
    // a request failure. Individual degraded fields are represented as nulls.
    return { ok: true, generated_at: new Date().toISOString(), plans: [] };
  }
}

module.exports = { aggregatePlanState };

if (require.main === module) {
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(aggregatePlanState()) + '\n');
  else process.stdout.write('Usage: node tools/plan-state-lib.js --json\n');
}
