#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert, assertEq, summary } = require('./helpers');
const { aggregatePlanState } = require('../tools/plan-state-lib.js');

console.log('plan-state-lib tests\n');

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }
function write(p, text) { mkdir(path.dirname(p)); fs.writeFileSync(p, text); }
function event(ts, repo, session, snapshot, transcript, title) {
  return { ts, event: 'plan_approved', repo, cwd: `/work/${repo}`, session_id: session, snapshot, transcript_path: transcript, title };
}
function current() {
  return '## Outcome\nShip plan visibility.\n\n## Items\n- [ ] item-a: aggregate plans\n  depends_on: []\n  target_resources: [tools/plan-state-lib.js]\n  agent: coder\n- [x] item-b: expose parsers\n  depends_on: []\n  target_resources: [tools/c-thru-plan-harness.js]\n  agent: coder\n';
}
function wave(id, marker = '~') {
  return `---\nwave_id: ${id}\ncommit_message: "plan visibility"\ncontract_version: 3\nbatches: [["item-a"]]\n---\n\n- [${marker}] item-a: aggregate plans\n  agent: coder\n  needs: []\n  batch: 1\n  target_resources: [tools/plan-state-lib.js]\n`;
}
function setTreeTimes(dir, when) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) setTreeTimes(child, when);
    fs.utimesSync(child, when, when);
  }
  fs.utimesSync(dir, when, when);
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-plan-state-'));
  try {
    const spool = path.join(tmp, 'spool');
    const tmpRoot = path.join(tmp, 'tmp');
    const transcript = path.join(tmp, 'newest.jsonl');
    const oldTranscript = path.join(tmp, 'old-but-active.jsonl');
    const now = Date.now();
    const oldest = String(now - 9000), newest = String(now - 1000), other = String(now - 4000);
    const oldSnapshot = 'old-sessiona.md', newSnapshot = 'new-sessiona.md', otherSnapshot = 'other-sessionb.md';
    write(path.join(spool, oldSnapshot), '# Old alpha\nOld plan.\n');
    write(path.join(spool, newSnapshot), '# New alpha\nNew plan.\n');
    write(path.join(spool, otherSnapshot), '# Other beta\nOther plan.\n');
    write(transcript, [
      JSON.stringify({ type: 'assistant', timestamp: new Date(now - 3000).toISOString(), message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'tools/c-thru-plan-harness.js' } }] } }),
      JSON.stringify({ type: 'assistant', timestamp: new Date(now - 2000).toISOString(), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node test/plan-state-lib.test.js' } }, { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'fallback', status: 'pending' }] } }] } }),
      JSON.stringify({ type: 'user', timestamp: new Date(now - 1000).toISOString(), toolUseResult: { newTodos: [{ content: 'wire dashboard', status: 'in_progress', activeForm: 'Wiring dashboard' }] }, message: {} }),
    ].join('\n') + '\n');
    write(oldTranscript, '{}\n');
    fs.utimesSync(oldTranscript, new Date(now + 30000), new Date(now + 30000));
    write(path.join(spool, 'events.1.ndjson'), [
      JSON.stringify(event(oldest, 'repo-alpha', 'sessionaaaa', oldSnapshot, oldTranscript, 'Old native')),
      '{not-json}',
    ].join('\n') + '\n');
    write(path.join(spool, 'events.ndjson'), [
      JSON.stringify(event(newest, 'repo-alpha', 'sessionaaaa', newSnapshot, transcript, 'New native')),
      JSON.stringify(event(other, 'repo-beta', 'sessionbbbb', otherSnapshot, path.join(tmp, 'missing.jsonl'), 'Other native')),
    ].join('\n') + '\n');
    write(path.join(spool, 'notes', 'new-sessiona', '1.md'), '---\nts: 2026-01-01T00:00:00.000Z\nauthor: test-model\nsession_id: sessionaaaa\n---\nKept the state reader fail-open.\n');

    const alpha = path.join(tmpRoot, 'c-thru', 'repo-alpha', 'wave-new');
    write(path.join(alpha, 'current.md'), current());
    write(path.join(alpha, 'meta.json'), JSON.stringify({ status: 'active', revision_rounds: 2, wave_count: 1 }));
    write(path.join(alpha, 'journal.md'), 'created\nstarted implementation\n');
    write(path.join(alpha, 'waves', '001', 'wave.md'), wave(1));
    const oldWave = path.join(tmpRoot, 'c-thru', 'repo-alpha', 'wave-old');
    write(path.join(oldWave, 'current.md'), current());
    write(path.join(oldWave, 'meta.json'), JSON.stringify({ status: 'paused', revision_rounds: 1, wave_count: 1 }));
    write(path.join(oldWave, 'waves', '001', 'wave.md'), wave(1, 'x'));
    setTreeTimes(oldWave, new Date(now - 60000));
    const broken = path.join(tmpRoot, 'c-thru', 'repo-broken', 'bad-state');
    write(path.join(broken, 'meta.json'), '{broken');
    write(path.join(broken, 'waves', '001', 'wave.md'), 'not a wave');

    const state = aggregatePlanState({ spoolDir: spool, tmpRoots: [tmpRoot, tmpRoot] });
    assertEq(state.ok, true, 'aggregate succeeds with corrupt state files');
    assert(Array.isArray(state.plans), 'plans is an array');
    const joined = state.plans.find(p => p.repo === 'repo-alpha' && p.joined);
    assert(joined, 'newest native approval joins newest alpha wave');
    assertEq(joined.native.title, 'New native', 'newest native approval wins even when an older transcript is newer');
    assertEq(joined.wave.slug, 'wave-new', 'most-recent alpha wave is selected');
    assertEq(joined.wave.items.length, 2, 'current.md items serialize from parser map');
    assertEq(joined.wave.current_wave.id, 1, 'current wave is parsed through harness export');
    assert(joined.wave.journal_tail.includes('started implementation'), 'journal tail is exposed');
    assertEq(joined.notes[0].author, 'test-model', 'snapshot-key narrative notes attach');
    assertEq(joined.activity.recent.length, 3, 'assistant tool uses become recent activity');
    assert(joined.activity.recent.some(r => r.detail.includes('plan-state-lib')), 'activity detail uses a supported input field');
    assertEq(joined.activity.todos[0].content, 'wire dashboard', 'latest toolUseResult todos win over TodoWrite fallback');
    assert(state.plans.some(p => p.repo === 'repo-alpha' && !p.joined && p.native && !p.wave), 'older native approval becomes history');
    assert(state.plans.some(p => p.repo === 'repo-alpha' && !p.joined && p.wave && !p.native), 'older wave becomes history');
    assert(state.plans.some(p => p.repo === 'repo-beta' && p.native), 'events.ndjson is read after rotated events');
    assertEq(state.plans.filter(p => p.wave).length, 3, 'duplicate tmp roots scan each wave directory once');
    const times = state.plans.map(p => Date.parse(p.last_activity_ts || 0));
    assert(times.every((time, index) => index === 0 || times[index - 1] >= time), 'plans are sorted by descending last activity');
    const degraded = state.plans.find(p => p.repo === 'repo-broken');
    assert(degraded && degraded.wave && degraded.wave.items === null, 'missing/corrupt wave files degrade to null fields');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main();
