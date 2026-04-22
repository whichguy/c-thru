---
name: UX Progress Visibility — c-thru Operations
type: entity
description: "TODO: research and plan expressive user-facing progress notifications for c-thru agentic operations (waves, agent/subagent dispatch, routing decisions), using all available Claude Code channels"
tags: [ux, progress, notifications, statusline, hooks, agents, subagents, waves, visibility, todo]
confidence: low
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: []
related: [claude-code-hook-channels, c-thru-statusline, fallback-event-system, planner-signals-design, planner-design-backlog]
---

# UX Progress Visibility — c-thru Operations

**Status: TODO / research + design phase**

Goal: give users a rich, expressive view of what c-thru is doing as a plan executes — wave progress, agent/subagent dispatch, routing decisions, completion events — using the full Claude Code channel surface with as little latency and friction as possible.

---

## What we want to express

The agentic planner produces a stream of observable events that are currently invisible to the user:

| Event | Current state | Desired UX |
|---|---|---|
| Wave N starting | silent | Banner / status update |
| Agent dispatched (e.g. `implementer` → `deep-coder`) | silent | Show agent name + tier + model |
| Agent returned STATUS=COMPLETE/PARTIAL/RECUSE | silent | Tick or warn |
| Uplift cascade fired | silent | "escalating → cloud" indicator |
| Wave N complete | silent | Summary with pass/fail counts |
| Full plan complete | silent | Final summary + next-step prompt |
| Routing decision (`x-c-thru-resolved-via`) | header only (proxy) | Surfaced to user |
| Fallback fired | Stop hook systemMessage (existing) | Unchanged — already works |

---

## Known channel inventory (from [[claude-code-hook-channels]])

### Channels that reach the user

| Channel | Mechanism | Best for |
|---|---|---|
| **Stop hook `systemMessage`** | JSON `{ systemMessage: "..." }` from Stop hook | Per-turn event notifications (fires once per assistant response) |
| **Statusline** | `statusLine` script output (refreshed per turn + interval) | Persistent live state (current wave, active agent, last routing) |
| **macOS `osascript` toast** | Shell from any hook | Background / AFK milestone alerts |
| **PreToolUse exit-0 stderr** | Advisory stdout before tool executes | One-time hints (used for EnterPlanMode advisory) |

### Channels that do NOT work
- Custom HTTP response headers — Claude Code ignores them
- SessionStart stdout — regressed in 2.1.37
- PostToolUse `additionalContext` — only fires on tool use turns
- ANSI escape sequences — TUI strips them
- Hook stderr + exit 2 — shown as error, not information

---

## Research questions (open)

1. **Subagent progress**: when a subagent (implementer, wave-reviewer, etc.) is running, can the parent agent write intermediate state that the statusline picks up before the subagent returns? The statusline refreshes on `refreshInterval` — can a long-running agent write to `~/.claude/proxy.log` mid-execution and have the statusline reflect it?

2. **Wave state file**: should the orchestrator write a structured wave-state JSON file (e.g. `~/.claude/c-thru-wave-state.json`) that the statusline reads? This avoids log-parsing and gives a typed API for progress display. Tradeoff: one more file to manage + atomic-write discipline (the reason `proxy.log` was chosen over a snapshot file for fallback state — see [[c-thru-statusline]]).

3. **`systemMessage` cadence**: Stop hook fires once per assistant response. If a wave has 6 agents and the orchestrator makes 6 calls, does Stop fire 6 times? Or once for the whole turn? Need to clarify how multi-agent orchestration maps to Claude Code turn boundaries.

4. **Rich text formatting in `systemMessage`**: can `systemMessage` render markdown tables/bold/headers? Or is it plain text? If markdown renders, per-wave summaries can be much richer.

5. **Streaming progress**: Claude Code's subagent model has no streaming progress hook between SubagentStart and SubagentComplete. Is there a viable polling approach (e.g. the orchestrator writes a status file every N seconds that the statusline reads)?

6. **`additionalContext` for in-progress state**: `UserPromptSubmit` `additionalContext` is injected as a system-reminder and Claude sees it on the next turn. Can it be used to carry forward "wave N is in progress, last agent returned STATUS=PARTIAL" so Claude has context for follow-up questions mid-plan?

7. **OS notification granularity**: toasts are good for coarse milestones (wave complete, plan complete, uplift fired). What's the right threshold — every agent? every wave? only on escalation/failure?

---

## Candidate design (sketch, not committed)

```
Statusline:  ⚡ Wave 2/4  implementer(deep-coder) → qwen3.5:27b  [3/6 agents]
Stop hook:   ✓ Wave 1 complete — 5 passed, 1 PARTIAL (escalated)
OS toast:    c-thru: plan complete — 4 waves, 23 items
```

State transport: a `~/.claude/c-thru-plan-state.json` written by the orchestrator:
```json
{
  "plan": "add-auth",
  "wave": 2,
  "total_waves": 4,
  "active_agent": "implementer",
  "active_capability": "deep-coder",
  "active_model": "qwen3.5:27b",
  "agents_done": 3,
  "agents_total": 6,
  "wave_results": { "passed": 5, "partial": 1, "failed": 0 }
}
```

Statusline reads this file; Stop hook emits a `systemMessage` on wave-boundary events (wave_start, wave_complete, plan_complete, uplift).

---

## Implementation order (proposed, pending research)

1. Answer the open research questions above (especially #1, #3, #4).
2. Define the state file schema and write contract (orchestrator → statusline/hooks).
3. Add state-file writes to plan-orchestrator (`agents/plan-orchestrator.md` orchestration steps).
4. Update statusline to read state file and render wave/agent progress.
5. Update Stop hook to emit `systemMessage` for wave-boundary events.
6. Add OS toast for plan-complete and uplift-fired milestones.
7. Clean up state file on plan completion/abort.

---

## Constraints

- The proxy log (`~/.claude/proxy.log`) remains the source of truth for routing/fallback events — don't duplicate that stream into the plan state file.
- All hooks must exit 0 on every path (never block Claude's response).
- State file writes must be atomic or best-effort (never corrupt on SIGINT mid-write).
- No new external dependencies — stdlib + jq (already required).

- **From Session 75859eff:** Entity created this session in response to a user request to "research and plan out how best to provide fancy expressive user-facing progress feedback" during c-thru agentic operations. The design identifies 4 working channels (Stop hook `systemMessage`, statusline, macOS `osascript`, PreToolUse stderr) and 5 non-working channels (custom headers, SessionStart stdout, PostToolUse additionalContext, ANSI escapes, hook stderr+exit 2). Candidate architecture: orchestrator writes `~/.claude/c-thru-plan-state.json`; statusline reads it for wave/agent/model display; Stop hook emits `systemMessage` on wave-boundary events. 7 open research questions remain (subagent mid-execution polling, Stop hook cadence, systemMessage markdown rendering, streaming progress, additionalContext carry-forward, OS toast granularity). No implementation yet — research phase only.

- **From Session 75859eff:** Entity created to capture the UX progress-visibility design space. User request: leverage all Claude Code "fanciness" to surface c-thru agentic operation progress (waves, agent dispatch, routing decisions, uplift escalations) to the user. Grounded against the known channel inventory ([[claude-code-hook-channels]]): statusline for persistent live state, Stop-hook `systemMessage` for wave-boundary events, OS `osascript` toast for coarse milestones. Seven open research questions identified (subagent mid-execution state, wave-state file vs log-parsing, Stop-hook cadence per turn, markdown rendering in systemMessage, streaming progress, `additionalContext` carry-forward, toast granularity). A candidate design and `~/.claude/c-thru-plan-state.json` state-transport schema were sketched but not committed — implementation deferred until research questions answered.

→ See also: [[claude-code-hook-channels]], [[c-thru-statusline]], [[fallback-event-system]], [[planner-signals-design]], [[planner-design-backlog]]
