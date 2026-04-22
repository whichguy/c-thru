---
name: Plan Discovery Optional
type: entity
description: "Design decision: cplan one-shots the plan first, shows a draft, then offers discovery as an optional enhancement — Outcome write deferred until user confirms framing"
tags: [cplan, planning, discovery, one-shot, draft-plan, current-md]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [84747a76]
related: [planner-signals-design, planner-default-integration]
---

# Plan Discovery Optional

`/cplan` defers the discovery phase rather than mandating it upfront. The flow is: generate a draft plan (no `## Outcome` written, no contract version marker set), show it to the user, then ask "run discovery to fill gaps?" If yes, re-run the planner with discovery context and write `## Outcome`. If no, promote the draft as-is. This avoids the cost of always-discovery while still catching the cases where skipping it causes silent assumption bakedin.

- **From Session 84747a76:** One-shot-first rationale: discovery imposes real cost before a line of code runs, and for greenfield, simple/well-scoped tasks, or when the user knows the codebase cold, the assumptions are harmless. The key constraint is that `## Outcome` in `current.md` is immutable once written — so the Outcome write must be deferred until after user confirms framing. Without deferral, one-shot assumptions get baked into `target_resources` and `depends_on` on items the user may never correct, propagating silently into digests fed to workers.
- **From Session 84747a76:** Heuristic for auto-prompting: rather than always asking "run discovery?", the better design is to check whether discovery-advisor returns `GAPS > 0`. Simple plans skip the question entirely; plans with detected gaps get the prompt. This means three paths: (1) discovery skipped silently (GAPS = 0), (2) user offered discovery (GAPS > 0), (3) user triggers discovery manually regardless.
- **From Session 84747a76:** When discovery is worth the cost: existing codebases with non-obvious patterns (brownfield work), tasks that touch cross-cutting dependencies, tasks where the user hasn't described the codebase. Skipping discovery on brownfield work leads to wrong `depends_on` chains and misidentified `target_resources` that only surface mid-wave.
- **From Session 84747a76:** `current.md` naming rationale: the slug is already in the directory path (`$PLAN_ROOT/$SLUG/current.md`), making the filename redundant if it included the slug. "current" signals the file is live mutable state as opposed to `plan/snapshots/p-001.md` (frozen historical copies). The name makes the single-source-of-truth role explicit without embedding the slug twice.

→ See also: [[planner-signals-design]], [[planner-default-integration]]
