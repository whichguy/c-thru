---
name: Planner Design Backlog
type: entity
description: "Open design TODOs for plan-orchestrator: test/CI awareness, deployable-wave semantics, state migration evaluation, and complexity-gated decisions"
tags: [planner, plan-orchestrator, design, backlog, todo, waves, testing, CI/CD, migration]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: []
related: [planner-signals-design, planner-default-integration, plan-discovery-optional, agent-contract-testing]
---

# Planner Design Backlog

Open design TODOs for the plan-orchestrator and wave-based agentic planning system. These are pre-execution considerations to evaluate before committing to a wave plan.

---

## TODO 1 — Test/CI awareness before wave execution

**Before executing**, the plan-orchestrator must ask: *are there existing tests or test frameworks that should be leveraged by this plan?*

Scope:
- Detect existing test infrastructure (test runner, framework, test directories) during the discovery/reconnaissance phase.
- For trivial programs: note the framework and ensure the implementer agent writes tests compatible with it.
- For complex programs: test coverage becomes a first-class wave concern, not an afterthought. The test-writer and wave-reviewer agents must know the testing contract.
- **CI/CD consideration** applies at the *final phase* of the project: the last wave (or a dedicated cleanup wave) should evaluate whether the changes are CI-safe — linting gates, test commands, build pipelines, and deploy scripts that might break.
- Complexity is the gating signal: trivial changes may skip CI validation; complex multi-file changes must include it.

Implementation note: this is primarily a planner (pre-wave) and final-reviewer responsibility. The discoverer/explorer agents should surface test framework presence as a reconnaissance finding.

---

## TODO 2 — Each wave step must be independently deployable

**Wave semantics:** every wave, when merged, must leave the codebase in a state that can be deployed to production without causing errors — even if the feature is not yet complete.

Rules:
- A wave represents a *logical, shippable unit of work* — not necessarily feature-complete, but never breaking.
- Any intermediate state that would cause runtime errors, failed imports, or type mismatches must be grouped into the *same wave* as the change that causes it.
- Example: if wave N adds a new module and wave N+1 wires it up, wave N must leave the module importable but unused (not partially wired). A broken import in wave N is not acceptable.
- Each wave should be committed and (ideally) deployed. Waves accumulate to deliver the full plan.
- The plan-orchestrator must flag any item that would leave the system in an undeployable intermediate state and force it into the same wave as its dependency.

**State migration consideration:** for each wave, evaluate whether data/schema migration is required.
- Gated by complexity: simple function changes never need migration; schema changes, renamed identifiers used at runtime, or persisted data format changes always do.
- Migration strategy (if needed) must be defined before the wave executes — not discovered mid-wave.
- Migration itself may be its own wave (e.g., a backward-compatible migration wave before a breaking-change wave).

---

## Cross-cutting: complexity evaluation applies to all of the above

Both TODOs above are gated by a **complexity signal** that the planner evaluates at plan time:

| Signal | Trivial | Moderate | Complex |
|---|---|---|---|
| Test/CI awareness | note framework | run existing tests | dedicated CI wave |
| Deployable-wave check | single wave OK | multi-wave with guard | strict gate before each merge |
| State migration | skip | evaluate | required wave |

The planner should derive this signal from: number of files affected, presence of shared interfaces/schemas, presence of external callers or consumers, and presence of database/state stores.

- **From Session 75859eff:** Entity created to capture two design TODOs surfaced during test-suite hardening work: (1) test/CI framework awareness before wave execution — planners should discover existing test infrastructure during reconnaissance and treat CI-safety as a complexity-gated first-class concern for multi-file plans; (2) deployable-wave semantics — each wave must leave the codebase in a shippable state (not just functionally correct but deploy-safe); intermediate states that would cause runtime errors must be colocated in the same wave as the breaking change, not deferred; state migrations must be planned before the wave runs, and may themselves require a dedicated wave.

→ See also: [[planner-signals-design]], [[planner-default-integration]], [[plan-discovery-optional]], [[agent-contract-testing]]
