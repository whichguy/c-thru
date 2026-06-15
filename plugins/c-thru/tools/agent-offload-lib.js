#!/usr/bin/env node
'use strict';
// Shared parser: extract subagent DELEGATIONS from Claude Code event streams.
//
// WHY THIS EXISTS — the c-thru proxy is agent-blind. The PreToolUse hook
// (c-thru-agent-router-hook.sh) resolves subagent_type -> capability and injects
// {model: capability} BEFORE the request reaches the proxy, so every proxy log and
// usage-stats.json bucket is keyed by capability, not agent. Two agents that share a
// capability (reviewer-plan -> code-reviewer, plan-scheduler -> fast-generalist) are
// indistinguishable in proxy data. The clean, agent-precise signal lives in Claude
// Code's OWN surfaces — this module reads them.
//
// PARSE, DON'T GREP. We only count real `type:"tool_use"` blocks whose name is
// Agent/Task. The literal string "subagent_type" appearing in prose, a SKILL.md
// pasted into a prompt, or assistant explanatory text is NEVER counted. A regex over
// raw lines would over-count exactly that noise (the documented gotcha).
//
// TWO SOURCES, ONE SHAPE — both the transcript jsonl
// (~/.claude/projects/<proj>/<session>.jsonl) and `claude -p --output-format
// stream-json` stdout encode a delegation CALL as an assistant message:
//     { uuid, timestamp, sessionId, promptId,
//       message: { role:"assistant", content:[
//         { type:"tool_use", id, name:"Agent"|"Task",
//           input:{ subagent_type, description, prompt } } ] } }
// The transcript additionally records a RESULT rollup as a separate envelope:
//     { sourceToolAssistantUUID:<the assistant line's uuid>, timestamp, promptId,
//       toolUseResult:{ agentType, status, totalTokens, totalDurationMs,
//                       totalToolUseCount } }
// joined to its call by  result.sourceToolAssistantUUID === callLine.uuid.
// stream-json may carry only the call (no rollup) — that is fine; tokens/duration
// come back null and the delegation is still counted.
//
// Used by: tools/c-thru-agent-usage.js (Part 2, transcript files) and
//          test/agent-offload-coverage.js (Part 1, stream-json stdout).

const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);
const ORPHAN_KEY = '__orphan__';

// Normalize input to an array of parsed objects. Accepts a jsonl string, an array
// of line strings, or an array of already-parsed objects. Non-JSON / blank lines
// are skipped silently (transcripts can contain summary or partial lines).
function toObjects(input) {
  let items;
  if (typeof input === 'string') items = input.split('\n');
  else if (Array.isArray(input)) items = input;
  else throw new TypeError('agent-offload-lib: input must be a jsonl string or an array');
  const objs = [];
  for (const it of items) {
    if (it == null) continue;
    if (typeof it === 'object') { objs.push(it); continue; }
    const line = String(it).trim();
    if (!line) continue;
    try { objs.push(JSON.parse(line)); } catch (_e) { /* skip non-JSON line */ }
  }
  return objs;
}

// Agent/Task tool_use blocks from an assistant message, or [].
function agentToolUseBlocks(obj) {
  const msg = obj && obj.message;
  if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return [];
  return msg.content.filter(
    (c) => c && c.type === 'tool_use' && AGENT_TOOL_NAMES.has(c.name)
  );
}

// Extract a flat list of delegations from an event stream. Each delegation:
//   { subagent_type, description, tokens, durationMs, toolUseCount, status, ok,
//     ts, promptId, sessionId, hasResult, orphanResult? }
// A call enriched with its result is ONE delegation. A result with no matching
// call (truncated/cross-file transcript) is emitted once as an orphan so totals
// are never undercounted. No delegation is counted twice.
function extractDelegations(input) {
  const objs = toObjects(input);

  const calls = [];                  // ordered list of call records
  const resultsByUuid = new Map();   // sourceToolAssistantUUID -> [result,...]
  const seenToolUseIds = new Set();  // dedup: a tool_use id is one delegation

  for (const obj of objs) {
    for (const b of agentToolUseBlocks(obj)) {
      // Count each tool_use id once. Complete transcripts and plain stream-json
      // emit each block once; --include-partial-messages would repeat the same id
      // as it streams — dedup so a partial delta is never counted as a 2nd call.
      if (b.id) {
        if (seenToolUseIds.has(b.id)) continue;
        seenToolUseIds.add(b.id);
      }
      calls.push({
        assistantUuid: obj.uuid || null,
        subagent_type: (b.input && b.input.subagent_type) || null,
        description: (b.input && b.input.description) || null,
        ts: obj.timestamp || null,
        promptId: obj.promptId || null,
        sessionId: obj.sessionId || null,
      });
    }
    const tur = obj && obj.toolUseResult;
    if (tur && (tur.agentType || tur.agentId)) {
      const key = obj.sourceToolAssistantUUID || ORPHAN_KEY;
      const result = {
        agentType: tur.agentType || null,
        status: tur.status || null,
        totalTokens: typeof tur.totalTokens === 'number' ? tur.totalTokens : null,
        totalDurationMs: typeof tur.totalDurationMs === 'number' ? tur.totalDurationMs : null,
        totalToolUseCount: typeof tur.totalToolUseCount === 'number' ? tur.totalToolUseCount : null,
        ts: obj.timestamp || null,
        promptId: obj.promptId || null,
        sessionId: obj.sessionId || null,
      };
      if (!resultsByUuid.has(key)) resultsByUuid.set(key, []);
      resultsByUuid.get(key).push(result);
    }
  }

  const delegations = [];
  const consumed = new Set();

  // Join each call to its best-matching result. When one assistant message fired
  // several parallel Agent calls, they share a uuid; prefer the result whose
  // agentType equals this call's subagent_type, else the first still-unused one.
  for (const call of calls) {
    const candidates = call.assistantUuid ? (resultsByUuid.get(call.assistantUuid) || []) : [];
    const matched =
      candidates.find((r) => !consumed.has(r) && r.agentType === call.subagent_type) ||
      candidates.find((r) => !consumed.has(r)) ||
      null;
    if (matched) consumed.add(matched);
    delegations.push({
      // The result's agentType is ground truth (the harness actually ran it);
      // fall back to the call's subagent_type when no result is present.
      subagent_type: (matched && matched.agentType) || call.subagent_type || null,
      description: call.description,
      tokens: matched ? matched.totalTokens : null,
      durationMs: matched ? matched.totalDurationMs : null,
      toolUseCount: matched ? matched.totalToolUseCount : null,
      status: matched ? matched.status : null,
      ok: matched ? matched.status === 'completed' : null,
      ts: (matched && matched.ts) || call.ts || null,
      promptId: call.promptId || (matched && matched.promptId) || null,
      sessionId: call.sessionId || (matched && matched.sessionId) || null,
      hasResult: !!matched,
    });
  }

  // Emit results that never matched a call (the call line rolled out of this
  // input). Real completed delegations — count them, flagged as orphans.
  for (const results of resultsByUuid.values()) {
    for (const r of results) {
      if (consumed.has(r)) continue;
      delegations.push({
        subagent_type: r.agentType || null,
        description: null,
        tokens: r.totalTokens,
        durationMs: r.totalDurationMs,
        toolUseCount: r.totalToolUseCount,
        status: r.status,
        ok: r.status === 'completed',
        ts: r.ts,
        promptId: r.promptId,
        sessionId: r.sessionId,
        hasResult: true,
        orphanResult: true,
      });
    }
  }

  return delegations;
}

// Roll delegations up per agent. Returns a plain object keyed by agent name:
//   { [agent]: { agent, calls, completed, tokens, durationMs, lastSeen } }
function aggregateByAgent(delegations) {
  const agg = Object.create(null);
  for (const d of delegations) {
    // null subagent_type = the Agent tool was invoked without one (default
    // catch-all agent), a real delegation — bucket it honestly, don't drop it.
    const name = d.subagent_type || '(unspecified)';
    if (!agg[name]) {
      agg[name] = { agent: name, calls: 0, completed: 0, tokens: 0, durationMs: 0, lastSeen: null };
    }
    const a = agg[name];
    a.calls += 1;
    if (d.ok) a.completed += 1;
    if (typeof d.tokens === 'number') a.tokens += d.tokens;
    if (typeof d.durationMs === 'number') a.durationMs += d.durationMs;
    if (d.ts && (!a.lastSeen || d.ts > a.lastSeen)) a.lastSeen = d.ts;
  }
  return agg;
}

module.exports = { extractDelegations, aggregateByAgent, agentToolUseBlocks, AGENT_TOOL_NAMES };
