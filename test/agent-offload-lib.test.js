#!/usr/bin/env node
'use strict';
// Unit tests for tools/agent-offload-lib.js — the shared delegation parser.
//
// The headline guarantee is PARSE, DON'T GREP: only real `type:"tool_use"` blocks
// named Agent/Task count; the literal string "subagent_type" in prose, in a pasted
// SKILL.md, or in a non-Agent tool's input must NEVER be counted. The other cases
// lock the call↔result join, dedup-by-id, orphan handling, and aggregation.
//
// Run: node test/agent-offload-lib.test.js

const { extractDelegations, aggregateByAgent } = require('../tools/agent-offload-lib.js');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}

// ── Builders for synthetic Claude Code events ─────────────────────────────────
function callLine(uuid, toolUseId, input, extra) {
  return Object.assign({
    uuid,
    timestamp: '2026-06-15T00:00:00.000Z',
    sessionId: 'sess-1',
    promptId: 'prompt-1',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input }] },
  }, extra || {});
}
function resultLine(sourceUuid, agentType, totalTokens, totalDurationMs, status, ts) {
  return {
    uuid: 'res-' + sourceUuid,
    sourceToolAssistantUUID: sourceUuid,
    timestamp: ts || '2026-06-15T00:00:05.000Z',
    promptId: 'prompt-1',
    sessionId: 'sess-1',
    type: 'user',
    toolUseResult: {
      agentType, status: status || 'completed',
      totalTokens, totalDurationMs, totalToolUseCount: 3,
    },
  };
}

// ── 1. PARSE-NOT-GREP — the core guarantee ────────────────────────────────────
console.log('\n1. parse-not-grep: only real Agent/Task tool_use blocks count');
{
  const events = [
    // (a) a REAL delegation
    callLine('u1', 'toolu_a', { subagent_type: 'planner', description: 'plan it', prompt: 'do x' }),
    // (b) assistant PROSE containing the literal string — must NOT count
    { uuid: 'u2', message: { role: 'assistant', content: [
      { type: 'text', text: 'I could use subagent_type="reviewer-security" here, per the docs.' },
    ] } },
    // (c) a NON-Agent tool whose input happens to carry subagent_type — must NOT count
    { uuid: 'u3', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'grep subagent_type=tester' } },
    ] } },
    // (d) a user message pasting a SKILL.md mentioning subagent_type — must NOT count
    { uuid: 'u4', message: { role: 'user', content: [
      { type: 'text', text: 'subagent_type="coder" appears all over this SKILL.md I pasted' },
    ] } },
  ];
  const dels = extractDelegations(events);
  assert(dels.length === 1, `exactly 1 delegation extracted (got ${dels.length})`);
  assert(dels[0] && dels[0].subagent_type === 'planner', `the one delegation is "planner" (got ${dels[0] && dels[0].subagent_type})`);
}

// ── 2. call ↔ result join carries tokens / duration / ok ──────────────────────
console.log('\n2. call+result join attaches the rollup');
{
  const dels = extractDelegations([
    callLine('u10', 'toolu_c', { subagent_type: 'coder', description: 'write code' }),
    resultLine('u10', 'coder', 1234, 5678, 'completed'),
  ]);
  assert(dels.length === 1, `1 delegation (got ${dels.length})`);
  const d = dels[0];
  assert(d.tokens === 1234, `tokens joined (got ${d.tokens})`);
  assert(d.durationMs === 5678, `durationMs joined (got ${d.durationMs})`);
  assert(d.ok === true && d.hasResult === true, `ok+hasResult true (got ok=${d.ok}, hasResult=${d.hasResult})`);
}

// ── 3. result.agentType is authoritative when the call omits subagent_type ─────
console.log('\n3. result agentType wins over a missing call subagent_type');
{
  const dels = extractDelegations([
    callLine('u20', 'toolu_d', { description: 'no type given', prompt: 'go' }), // no subagent_type
    resultLine('u20', 'reviewer-security', 999, 100, 'completed'),
  ]);
  assert(dels.length === 1 && dels[0].subagent_type === 'reviewer-security',
    `agentType backfills subagent_type (got ${dels[0] && dels[0].subagent_type})`);
}

// ── 4. dedup by tool_use id (streaming partials) ──────────────────────────────
console.log('\n4. same tool_use id appearing twice counts once');
{
  const partial = callLine('u30', 'toolu_e', { subagent_type: 'tester', description: '' });        // partial delta
  const complete = callLine('u30', 'toolu_e', { subagent_type: 'tester', description: 'full' });    // completed
  const dels = extractDelegations([partial, complete]);
  assert(dels.length === 1, `deduped to 1 (got ${dels.length})`);
}

// ── 5. parallel calls in one message disambiguated by agentType ───────────────
console.log('\n5. two parallel Agent calls under one message, each joined to its own result');
{
  const parallelMsg = {
    uuid: 'u40',
    timestamp: '2026-06-15T00:00:00.000Z',
    message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_f', name: 'Agent', input: { subagent_type: 'planner', description: 'a' } },
      { type: 'tool_use', id: 'toolu_g', name: 'Agent', input: { subagent_type: 'tester', description: 'b' } },
    ] },
  };
  const dels = extractDelegations([
    parallelMsg,
    resultLine('u40', 'tester', 200, 20, 'completed'),
    resultLine('u40', 'planner', 100, 10, 'completed'),
  ]);
  assert(dels.length === 2, `2 delegations (got ${dels.length})`);
  const planner = dels.find(d => d.subagent_type === 'planner');
  const tester = dels.find(d => d.subagent_type === 'tester');
  assert(planner && planner.tokens === 100, `planner joined to its 100-tok result (got ${planner && planner.tokens})`);
  assert(tester && tester.tokens === 200, `tester joined to its 200-tok result (got ${tester && tester.tokens})`);
}

// ── 6. orphan result (call rolled out of input) still counted once ────────────
console.log('\n6. a result with no matching call is emitted once as an orphan');
{
  const dels = extractDelegations([resultLine('missing-uuid', 'docs', 50, 5, 'completed')]);
  assert(dels.length === 1, `1 delegation (got ${dels.length})`);
  assert(dels[0].orphanResult === true && dels[0].subagent_type === 'docs',
    `flagged orphan, agent=docs (got orphan=${dels[0].orphanResult}, agent=${dels[0].subagent_type})`);
}

// ── 7. null subagent_type buckets as (unspecified), never dropped ─────────────
console.log('\n7. a call with no subagent_type aggregates under (unspecified)');
{
  const dels = extractDelegations([callLine('u50', 'toolu_h', { description: 'default agent', prompt: 'x' })]);
  const agg = aggregateByAgent(dels);
  assert(dels.length === 1, `1 delegation (got ${dels.length})`);
  assert(agg['(unspecified)'] && agg['(unspecified)'].calls === 1,
    `(unspecified) bucket has 1 call (got ${agg['(unspecified)'] && agg['(unspecified)'].calls})`);
}

// ── 8. blank / non-JSON lines are skipped (string input path) ─────────────────
console.log('\n8. jsonl string with blank + garbage lines parses cleanly');
{
  const jsonl = [
    '',
    'not json at all',
    JSON.stringify(callLine('u60', 'toolu_i', { subagent_type: 'debugger-hard', description: 'd' })),
    '   ',
    JSON.stringify(resultLine('u60', 'debugger-hard', 7, 8, 'completed')),
  ].join('\n');
  const dels = extractDelegations(jsonl);
  assert(dels.length === 1 && dels[0].subagent_type === 'debugger-hard',
    `1 delegation from a noisy string (got ${dels.length}, agent=${dels[0] && dels[0].subagent_type})`);
}

// ── 9. aggregateByAgent rolls up calls / completed / tokens / lastSeen ─────────
console.log('\n9. aggregateByAgent rollup');
{
  const dels = extractDelegations([
    callLine('a1', 't1', { subagent_type: 'coder', description: '1' }),
    resultLine('a1', 'coder', 100, 10, 'completed', '2026-06-15T01:00:00.000Z'),
    callLine('a2', 't2', { subagent_type: 'coder', description: '2' }),
    resultLine('a2', 'coder', 200, 20, 'completed', '2026-06-15T02:00:00.000Z'),
    callLine('a3', 't3', { subagent_type: 'coder', description: '3' }), // no result → call-only
  ]);
  const agg = aggregateByAgent(dels);
  const c = agg['coder'];
  assert(c && c.calls === 3, `coder calls=3 (got ${c && c.calls})`);
  assert(c && c.completed === 2, `coder completed=2 (got ${c && c.completed})`);
  assert(c && c.tokens === 300, `coder tokens=300 (got ${c && c.tokens})`);
  assert(c && c.lastSeen === '2026-06-15T02:00:00.000Z', `coder lastSeen=latest (got ${c && c.lastSeen})`);
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
