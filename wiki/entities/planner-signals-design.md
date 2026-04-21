---
name: Planner-Signals Design
type: entity
description: "Trigger-based planning decomposition (c-thru) vs expertise-based (BMAD) vs artifact-based (SDD) — one planner agent with three signals, not personas or document chains"
tags: [architecture, planning, bmad, sdd, decomposition, constitution]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [1558f542]
related: [uplift-cascade-pattern, capability-profile-model-layers, declared-rewrites, runtime-control, cascade-scope-contraction]
---

# Planner-Signals Design

c-thru's planning groups by **trigger** (intent / wave_summary / final_review), not by **expertise** (BMAD: Analyst/PM/Architect/Dev) or **artifact** (SDD: constitution→spec→plan→tasks). One planner agent with three typed signals replaces 4-6 personas or 6 slash commands. This is what enables zero-token local offload — the agent name carries a tier binding, which persona-relay and artifact-pipeline cannot do.

- **From Session 1558f542:** BMAD's structural weight comes from five things, not surface count: (1) sequential long-lived persona sessions (2.5-5 hours cloud time pre-code), (2) artifact multiplication (same requirement restated 4x in brief→PRD→epic→story), (3) no structural mid-execution re-planning (`bmad-correct-course` is an escape hatch, not happy path), (4) expertise split is an illusion — one cloud LLM plays all personas via system prompts, paying re-context cost for no real specialization, (5) sprint ceremony (5 commands × N stories = ~75 invocations for 15 stories). c-thru inverts all five: one agent + typed signals, one artifact with pointers, re-entry is happy path (wave_summary fires automatically), context bounded to ~400 tokens, determinism absorbs ceremony.
- **From Session 1558f542:** c-thru is ~15× lighter in LLM invocations on a comparable project vs BMAD. A 10-wave plan with 8 clean waves makes ~5 planner calls total; BMAD with 3 epics × 5 stories requires ~75 ceremony invocations. Per-call cost is further compounded by local offload (only c-thru can do this — BMAD/SDD agent primitive can't carry a tier binding).
- **From Session 1558f542:** Constitution file decision: **do not add**. Research reversed initial recommendation. Evidence: (1) Scott Logic Nov 2025 review — 189-line constitution "played a peripheral role" in actual implementation. (2) spec-kit issue #1149 — unresolved scope ambiguity between constitution and spec. (3) spec-kit issue #896 — `/speckit.constitution` can both amend constitution AND generate code, missing scope guard. (4) Agent adherence unreliable — spec-kit docs admit "no 100% guarantee." (5) Community consensus that CLAUDE.md already serves as project constitution. (6) Works better for greenfield; c-thru is brownfield. Instead: update `agents/planner.md` step 1 to explicitly re-read named CLAUDE.md sections alongside `## Outcome`, and add same axis to `review-plan.md`. No new file, no duplication, no scope ambiguity.
- **From Session 1558f542:** Honest c-thru weaknesses: lower discoverability (19 agents + signals + 2-hop routing harder to read than persona diagram), `current.md` is engineer-only (not stakeholder-facing), single judge tier for all planning judgment (compensated by review loop but still a concentration point), governance in general-purpose CLAUDE.md not planner-specific (fixable with one-line edit), brownfield-optimized (weaker for true greenfield).
- **From Session 1558f542:** When to reject c-thru for a task: (1) fuzzy greenfield requirements → BMAD's upfront ceremony earns its cost, (2) stakeholder sign-off needed → write SDD-style spec separately, feed as intent, (3) architecture-dominated work → run `/architect` first, feed as discovery, (4) single-use throwaway → skill overhead > value, use plain Claude Code.

→ See also: [[uplift-cascade-pattern]], [[agent-prompt-construction]], [[capability-profile-model-layers]], [[declared-rewrites]], [[runtime-control]], [[sighup-config-reload]], [[cascade-scope-contraction]]