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

const {
  extractDelegations,
  aggregateByAgent,
  offloadTimeoutMs,
  claudeRunFailure,
  claudeResultDiagnostic,
  claudePermissionDenialTools,
  MAX_OFFLOAD_TIMEOUT_MS,
  MAX_CLAUDE_DIAGNOSTIC_CHARS,
} = require('../tools/agent-offload-lib.js');

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

// ── 10. offload timeout parsing has a hard one-hour ceiling ──────────────────
console.log('\n10. C_THRU_OFFLOAD_TIMEOUT parsing');
{
  assert(offloadTimeoutMs(undefined, 3_600_000) === 3_600_000,
    'missing override uses the one-hour fallback');
  assert(offloadTimeoutMs('3600', 1) === 3_600_000,
    'one-hour override is accepted');

  for (const bad of ['0', '-1', '1.5', '12seconds', '3601', '604800', '9007199254740992']) {
    let rejected = false;
    try { offloadTimeoutMs(bad, 1); } catch (e) {
      rejected = e instanceof RangeError && String(e.message).includes('C_THRU_OFFLOAD_TIMEOUT');
    }
    assert(rejected, `invalid timeout ${JSON.stringify(bad)} is rejected`);
  }

  let badFallbackRejected = false;
  try { offloadTimeoutMs('', MAX_OFFLOAD_TIMEOUT_MS + 1); } catch (e) {
    badFallbackRejected = e instanceof RangeError;
  }
  assert(badFallbackRejected, 'fallback above one hour is rejected');
}

// ── 11. process health is required before selection scoring ──────────────────
console.log('\n11. Claude run failure classification');
{
  const ok = { status: 0, signal: null, error: null, resultEvent: { is_error: false } };
  assert(claudeRunFailure(ok) === null, 'exit 0 plus successful result is scoreable');
  assert(claudeRunFailure({ ...ok, timedOut: true })?.includes('timed out'),
    'timeout is a run failure even if a delegation was parsed');
  assert(claudeRunFailure({ ...ok, error: { code: 'ENOENT' } })?.includes('ENOENT'),
    'spawn error is a run failure');
  assert(claudeRunFailure({ ...ok, signal: 'SIGTERM' })?.includes('SIGTERM'),
    'terminating signal is a run failure');
  assert(claudeRunFailure({ ...ok, status: 37 })?.includes('37'),
    'non-zero exit is a run failure');
  assert(claudeRunFailure({ ...ok, resultEvent: null })?.includes('without a result'),
    'missing result event is a run failure');
  assert(claudeRunFailure({ ...ok, resultEvent: { is_error: true } })?.includes('reported an error'),
    'Claude-declared result error is a run failure');
  assert(claudeRunFailure({ ...ok, resultEvent: {} })?.includes('explicitly report success'),
    'ambiguous result event is not accepted as success');
}

// ── 12. result diagnostics are useful, bounded, and safe to share ─────────────
console.log('\n12. Claude result diagnostic redaction');
{
  const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789';
  const prompt = 'PRINT_THIS_PRIVATE_PROMPT_VERBATIM';
  const command = '/bin/sh -lc "curl https://private.invalid"';
  const privateMessage = 'ordinary private customer retry note';
  const privateResult = 'ordinary private assistant result prose';
  const privateTypeAttempt = 'private type prose';
  const privateCodeAttempt = 'AUTH_401 private code prose';
  const privateStatusAttempt = 'failed with private status prose';
  const nestedPrivateMessage = 'ordinary private nested cause note';
  const resultEvent = {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: [
      {
        type: privateTypeAttempt,
        code: privateCodeAttempt,
        status: privateStatusAttempt,
        message: privateMessage,
      },
      {
        type: 'authentication_error',
        code: 'AUTH_401',
        status: 401,
        message:
          `${privateMessage}; api_key=${secret}; ` +
          `prompt: ${prompt}; command: ${command}`,
        cause: {
          type: 'transport_error',
          code: 'UPSTREAM_401',
          status: 'failed',
          message: nestedPrivateMessage,
        },
        prompt,
        argv: ['/bin/sh', '-lc', command],
      },
    ],
    result: privateResult,
    arbitrary_private_field: secret,
  };
  const diagnostic = claudeResultDiagnostic(resultEvent);
  const failure = claudeRunFailure({
    status: 1,
    signal: null,
    error: null,
    resultEvent,
  });

  assert(failure.includes('Claude process exited with status 1'),
    'status failure remains the primary classification');
  assert(failure.includes('subtype=error_during_execution'),
    'status failure includes the parsed result subtype');
  assert(failure.includes('authentication_error') && failure.includes('AUTH_401'),
    'allow-listed parsed error type and code identify the Claude cause');
  assert(failure.includes('errors.status=401'),
    'numeric parsed error status identifies the Claude cause');
  for (const [privateLabel, privateValue] of [
    ['credential', secret],
    ['prompt', prompt],
    ['command', command],
    ['command_target', 'private.invalid'],
    ['message_prose', privateMessage],
    ['result_prose', privateResult],
    ['type_prose', privateTypeAttempt],
    ['code_prose', privateCodeAttempt],
    ['status_prose', privateStatusAttempt],
    ['nested_message_prose', nestedPrivateMessage],
  ]) {
    assert(!failure.includes(privateValue),
      `status diagnostic does not expose ${privateLabel}`);
  }
  assert(diagnostic.length <= MAX_CLAUDE_DIAGNOSTIC_CHARS,
    'shared result diagnostic obeys its total character bound');

  const resultOnlyDiagnostic = claudeResultDiagnostic({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: privateResult,
  });
  assert(resultOnlyDiagnostic === 'subtype=error_during_execution',
    'error result prose is omitted even when it is short and unlabeled');

  const nestedDiagnostic = claudeResultDiagnostic({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    error: {
      type: privateTypeAttempt,
      code: 'AUTH_401\nPRIVATE_CONTROL_TEXT',
      status: privateStatusAttempt,
      message: privateMessage,
      cause: {
        type: 'network_error',
        code: 'ECONNRESET',
        status: 'timeout',
        message: nestedPrivateMessage,
      },
    },
  });
  assert(
    nestedDiagnostic.includes('error.cause.type=network_error') &&
      nestedDiagnostic.includes('error.cause.code=ECONNRESET') &&
      nestedDiagnostic.includes('error.cause.status=timeout'),
    'nested error cause exposes only validated category identifiers and status',
  );
  for (const [privateLabel, privateValue] of [
    ['type_prose', privateTypeAttempt],
    ['code_control', 'AUTH_401\nPRIVATE_CONTROL_TEXT'],
    ['status_prose', privateStatusAttempt],
    ['message_prose', privateMessage],
    ['nested_message_prose', nestedPrivateMessage],
  ]) {
    assert(!nestedDiagnostic.includes(privateValue),
      `identifier validation suppresses ${privateLabel}`);
  }

  assert(
    claudeResultDiagnostic({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: prompt,
    }) === 'subtype=success',
    'successful assistant result text is never copied into diagnostics',
  );

  const spawnPrivateMessage = 'ordinary private spawn detail';
  const spawnFailure = claudeRunFailure({
    status: null,
    error: { message: spawnPrivateMessage },
    resultEvent: null,
  });
  assert(
    spawnFailure === 'Claude process spawn error' &&
      !spawnFailure.includes(spawnPrivateMessage),
    'spawn diagnostics omit arbitrary error messages',
  );
  const spawnCodeFailure = claudeRunFailure({
    status: null,
    error: { code: 'ENOENT', message: spawnPrivateMessage },
    resultEvent: null,
  });
  assert(
    spawnCodeFailure === 'Claude process spawn error: ENOENT' &&
      !spawnCodeFailure.includes(spawnPrivateMessage),
    'spawn diagnostics retain only a validated bounded OS error code',
  );
  const invalidSpawnCode = claudeRunFailure({
    status: null,
    error: {
      code: 'ENOENT private spawn code prose',
      message: spawnPrivateMessage,
    },
    resultEvent: null,
  });
  assert(
    invalidSpawnCode === 'Claude process spawn error' &&
      !invalidSpawnCode.includes('private spawn'),
    'invalid spawn codes fall back to the generic spawn error',
  );


  assert(
    claudePermissionDenialTools({
      permission_denials: [
        { tool_name: 'Edit', tool_input: { command, prompt, secret } },
        { tool_name: 'Edit', tool_input: { command: 'duplicate' } },
        { tool_name: 'Agent', tool_input: { prompt } },
        { tool_name: `invalid-${'x'.repeat(100)}`, tool_input: { secret } },
      ],
    }).join(',') === 'Edit,Agent',
    'permission diagnostics expose only bounded unique tool names, never tool inputs',
  );
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
