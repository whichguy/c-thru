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

## TODO 3 — Iteration self-learnings: prompt/agent/flow improvement capture

**At the end of each plan/replan iteration and each plan-orchestrator wave execution**, the system should ask:

> *Based on what we learned this iteration, what are the specific, citable, and detailed improvements we would make to the c-thru prompts, agents, flow, or organization?*

These observations should be appended to a `self-learnings.md` file (or similarly named, e.g. `$PLAN_DIR/self-learnings.md`) after each wave completes. After all waves are done, a TODO task is added to this backlog to queue up a follow-up task: evaluate all accumulated self-learnings and determine which are applicable, then promote the actionable ones into concrete plan items.

**Scope:**
- Each wave's orchestrator step (Step 11 or a new Step 10.5) appends self-learnings to `$plan_dir/self-learnings.md`
- The planner (on each replan cycle) also appends learnings about the planning process itself
- Format: timestamped, citable bullets (file/line/agent name where applicable)
- After final wave: orchestrator or final-reviewer writes a TODO to this backlog entity (or to `$PLAN_DIR/pending-evaluations.md`) summarizing the learnings for deferred evaluation
- Deferred evaluation task: a future `/cplan` invocation or manual review evaluates which learnings are applicable and promotes them to prompt/agent edits

**Not yet implemented.** Status: OPEN.

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
- **From Session 75859eff:** Implementation plan created and reviewed to **READY** (2 convergence passes, 12 edits, senior-critic STABLE). Key design decisions codified: **(a) COMPLEXITY rubric** — `trivial`: files_affected ≤ 2 AND shared_interfaces = 0 AND persisted_state = absent AND external_consumers = 0; `complex`: files_affected ≥ 5 OR persisted_state = present OR external_consumers > 0; `moderate`: all others. **(b) Deployability guard default = collapse** (not split): merging the dependent pair into the same wave is the default action when a forward-reference violation is detected; split-with-stub only when the new module exports > 1 symbol and only one is needed by the earlier wave. **(c) TEST_FRAMEWORKS field format**: `{framework}@{test-dir}[+ci:{system}]` tokens, comma-separated, or `none`. **(d) Observability**: COMPLEXITY derivation inputs + output → `$wave_dir/plan.json`; COMPLEXITY tuple → `$wave_dir/cascade/complexity.jsonl` (mirrors CONFIDENCE calibration); deployability guard activations → `$wave_dir/cascade/deployability.jsonl`. **(e) Dogfood phasing**: the plan itself is delivered in 6 independently deployable phases — Phase 0 spike (complexity classifier calibration, ≥8/10 fixture agreement required before phases 2–5), Phase 1 TEST_FRAMEWORKS recon signal (additive), Phase 2 COMPLEXITY step (additive, complexity-gated), Phase 3 deployability guard (behavioral change, gated on Phase 2), Phase 4 state migration evaluation per wave, Phase 5 CI-safety final wave for complex plans, Phase 6 docs + backlog close-out. Each phase can be merged and deployed independently — dogfoods the deployable-wave contract being added.

- **From Session a553415d (current):** All 6 phases shipped on `feat/planner-design-backlog`. **TODO 1 (test/CI awareness) RESOLVED** — `discovery-advisor.md` emits `TEST_FRAMEWORKS: {framework}@{test-dir}[+ci:{system}] | none`; `explorer.md` documents the same format; `plan-orchestrator.md` forwards `TEST_FRAMEWORKS` into worker digests (Phase 1). CI-safety final wave appended automatically for `COMPLEXITY=complex` plans (Phase 5). **TODO 2 (deployable-wave semantics) RESOLVED** — deployability guard added to wave-emission step for moderate/complex plans (Phase 3); `MIGRATION_REQUIRED: yes|no` per wave with dedicated migration wave insertion when needed (Phase 4). **Complexity evaluation (Phase 2)** — Step 2.5 added to plan-orchestrator with rubric (trivial/moderate/complex) and logging to `plan.json` + `cascade/complexity.jsonl`. **Static test coverage** — `test/agent-contract-static.test.js` asserts `TEST_FRAMEWORKS` for discovery-advisor + explorer, and `TEST_FRAMEWORKS` + `COMPLEXITY` + `MIGRATION_REQUIRED` for plan-orchestrator; extraFields check hoisted above warnOnly short-circuit. **Docs updated** — `docs/agent-architecture.md` §Complexity & deployability signals; `skills/c-thru-plan/SKILL.md` §Complexity & deployability contract. Phase 0 classifier spike is pending calibration data from first real /cplan invocations — rubric was defined from first principles, not empirically validated against fixtures yet.

→ See also: [[planner-signals-design]], [[planner-default-integration]], [[plan-discovery-optional]], [[agent-contract-testing]], [[wave-md-manifest]]
