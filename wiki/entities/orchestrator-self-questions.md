---
name: Orchestrator Self-Questions Pattern
type: entity
description: "Design pattern: plan-orchestrator explicitly reasons through migration and CI/CD questions as LLM steps before each wave — self-reasoning > user prompts > file-pattern heuristics"
tags: [plan-orchestrator, wave-planning, self-questions, migration, CI/CD, reasoning-steps, complexity-evaluation]
confidence: high
last_verified: 2026-04-22
created: 2026-04-22
last_updated: 2026-04-22
sources: []
related: [planner-design-backlog, plan-discovery-optional, wave-md-manifest, planner-signals-design]
---

# Orchestrator Self-Questions Pattern

Before emitting each `wave.md`, the plan-orchestrator explicitly asks itself two questions and reasons through the answers using item descriptions and recon context already in scope — no user interaction, no file-pattern scanning. Added to `agents/plan-orchestrator.md` Step 2.5 in commit 1e7f37a (PR #42).

- **From Session a553415d:** Two blockquote reasoning questions added to Step 2.5: (1) **Migration** — does this wave touch any state, data, or files that need migration? (schema changes, renamed runtime fields, data format changes, config file renames) → if yes, insert a dedicated migration wave before this one. (2) **CI/CD** — could merging this wave break a CI pipeline? (renamed entry points, changed exports, removed files, altered CLI interfaces) → if yes, annotate `ci_risk: yes` in the wave.md frontmatter (non-complex plans) or ensure the CI-safety final wave (Step 5.5) covers it (complex plans). The orchestrator prompt explicitly labels these "reasoning steps, not user prompts — answer them from the items and recon context before writing wave.md."
- **From Session a553415d:** Design evolution: the first implementation added a Stage 0 that asked the *user* these two questions before recon and wrote answers to `$PLAN_DIR/discovery/user-constraints.md`, feeding `user_migration: yes|no` and `user_cicd: yes|no` fields that gated migration wave insertion and CI-safety wave triggering. This was reversed when the user clarified: "not user prompts, LLM self-questions during wave planning." The revert also restored recon-based signals: `user_migration` → `persisted_state` (derived from `PERSISTED_STATE_STORES` recon field), and the CI-safety gate reverted from `user_cicd: yes` back to `COMPLEXITY: complex`.
- **From Session a553415d:** Signal priority rule: *self-reasoning > user prompts > file-pattern heuristics* for ambiguous contextual signals. File-pattern auto-detection is appropriate only when the signal is unambiguously readable from code (e.g., test framework via `package.json`). For deployment-context or operational signals (migration scope, CI pipeline presence), the orchestrator reasons explicitly from items it already holds. User prompts are the last resort — only for operational knowledge the agent genuinely cannot infer from context.

- **From Session a553415d (post-ship simplifications):** Once the two self-questions existed as explicit LLM reasoning steps, three redundant upstream heuristics were removed: (1) `persisted_state = absent` condition dropped from the COMPLEXITY rubric — the migration self-question handles per-wave migration detection, making upfront recon-based `PERSISTED_STATE_STORES` detection redundant; (2) `AND persisted_state = present` compound gate dropped from the migration eval condition — the self-question IS the detection, the gate was double-checking the same thing; (3) CI-safety final wave trigger generalized from `COMPLEXITY: complex` to `ci_risk: yes` — any wave where the orchestrator answers yes to the CI/CD self-question now triggers the CI-safety wave, not just complex plans. Design principle: explicit LLM reasoning steps eliminate the need for downstream heuristic gates that were trying to approximate the same judgment.

→ See also: [[planner-design-backlog]], [[plan-discovery-optional]], [[wave-md-manifest]], [[planner-signals-design]]
