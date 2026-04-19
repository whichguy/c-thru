# Agentic Plan/Wave Architecture

The `/c-thru-plan` skill drives complex tasks through a wave-based execution loop using
13 specialized agents. Each agent declares its own name as its `model:` — the c-thru
proxy resolves it to a hardware-appropriate concrete model at request time.

## Agent roster

| Agent | Capability alias | Role |
|---|---|---|
| planner | judge | Constructs and amends `current.md` (3 modes) |
| auditor | judge | Determines wave direction: continue / extend / revise |
| final-reviewer | judge | End-of-plan gap analysis |
| review-plan | judge | Plan quality review (max 20 rounds) |
| journal-digester | judge | Out-of-band: synthesizes improvement suggestions → CLAUDE.md proposals |
| security-reviewer | judge-strict | Security-focused code review; hard_fail on cascade |
| plan-orchestrator | orchestrator | Topological sort + resource-conflict batching → wave.json |
| integrator | orchestrator | Wires completed units (routes, exports, DI) |
| doc-writer | orchestrator | User-facing documentation from implemented code |
| scaffolder | pattern-coder | Mechanical file/directory scaffolding (stubs, boilerplate) |
| test-writer | code-analyst | Tests that catch subtle bugs; reads implementation first |
| reviewer-fix | code-analyst | Iterative review+fix loop (max 5 rounds per item) |
| implementer | deep-coder | Core business logic; multi-file aware |

## 4-layer resolution

```
Claude Code sends  model: implementer
                          │
                          ▼  agent_to_capability (config/model-map.json)
                   deep-coder
                          │
                          ▼  llm_profiles[<detected-hw>][deep-coder]
                   connected_model / disconnect_model
                          │
                          ▼
                   devstral-small:2  (or tier-appropriate equivalent)
```

See `docs/hardware-profile-matrix.md` for the full 6-profile × 5-alias table.

## Wave lifecycle (7 phases)

0. **Pre-check** — resume/restart/abort if prior plan state exists
1. **Discovery** — reconnaissance + gap-fill via `explorer` agents (read-only)
2. **Plan construction** — `planner` writes `current.md`
3. **Plan review loop** — `review-plan` up to 20 rounds
4. **Wave loop** — repeats until no ready items:
   - `plan-orchestrator` → `wave.json` (topological sort, collision detection)
   - Prepare → digest files (no LLM)
   - Execute → parallel agent dispatch per batch
   - Finding scan → pause on crisis/plan-material; continue on contextual/trivial
   - `reviewer-fix` loop (code items, max 5 iterations)
   - Consolidate + Verify (no LLM)
   - `auditor` → continue / extend / revise
   - Commit → update `current.md`, snapshot, journal
5. **Final review** — `final-reviewer` gap analysis; `planner` Mode 3 if gaps found

## Revision cap

20 revision rounds total (plan review + final-review cycles). Tracked in
`.c-thru/plans/<slug>/meta.json`. Counter reaches 20 → user escalation.

## Wave state layout

```
.c-thru/plans/<slug>/
  current.md          — live plan (items, assumptions, completed-work summaries)
  meta.json           — slug, revision_rounds, created, status
  journal.md          — wave-by-wave log
  plan/snapshots/     — p-NNN.md per wave
  discovery/          — explorer summaries from Phase 1
  waves/
    NNN/
      wave.json       — batch plan from plan-orchestrator
      digests/        — <agent>-<item>.md per execution item
      outputs/        — <agent>-<item>.md per completed item
      findings/       — <agent>-<item>.jsonl per item; findings.jsonl aggregate
      artifact.md     — consolidated wave output
      verify.json     — deterministic post-wave checks
      decision.json   — auditor verdict
```

## Cross-wave communication

`current.md` only. Agents never read each other's outputs or the journal.
Improvement suggestions reach the planner only on Mode 2/3 invocation.

## Skill source

Skills live in `skills/` and are installed to `~/.claude/skills/c-thru/` by `install.sh`.
Agents live in `agents/` and are installed to `~/.claude/agents/c-thru/`.
