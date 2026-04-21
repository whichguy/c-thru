---
name: Implementer Lint Loop
type: entity
description: "Self-directed lint verification loop in implementer agent — runs linters on modified files before STATUS return, 5-iteration cap, LINT_ITERATIONS field, CONFIDENCE downgrade rule"
tags: [architecture, agents, implementer, lint, status-contract, confidence]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [3dfdb834]
related: [agent-prompt-construction, uplift-cascade-pattern, cascade-scope-contraction]
---

# Implementer Lint Loop

Post-work verification directive baked into the implementer agent prompt (not the orchestrator). After completing code edits, the implementer runs applicable static analysis against each modified file, fixes issues, and repeats up to 5 iterations before returning STATUS. Mirrors the reviewer-fix self-iteration pattern (directive lives in the agent, not the orchestrator).

- **From Session 3dfdb834:** Linter inventory by file type: `.sh`/`.bash` → `bash -n` + `shellcheck` (if available), `.js`/`.mjs`/`.cjs` → `node --check`, `.ts`/`.tsx` → `node --check` (per-file tsc unreliable without tsconfig), `.py` → `python3 -m py_compile` (if available), `.json` → `python3 -m json.tool > /dev/null` (skip `.jsonc` — comments cause false positives). Missing linter = skip, not failure.
- **From Session 3dfdb834:** STATUS contract extension: `LINT_ITERATIONS: N` added after `FINDING_CATS`. Optional field — absent/unrecognized → orchestrator treats as 0 (graceful degradation, same pattern as absent CONFIDENCE → medium). `LINT_ITERATIONS: 0` means all files were clean on first pass or no applicable linters ran. Added to `agents/implementer.md`, `agents/implementer-cloud.md` (escalation parity), `docs/agent-architecture.md` (implementer-only additional field, not in required block), `test/planner-return-schema.test.js` Section 7 (5 fixtures).
- **From Session 3dfdb834:** CONFIDENCE interaction rule: if lint errors remain after the 5-iteration cap, CONFIDENCE cannot be `high` — must be downgraded to `medium` with `"lint errors remained after cap"` in UNCERTAINTY_REASONS, plus one `plan-material` finding per affected file. A clean 5th-iteration pass with `CONFIDENCE: high` remains valid.
- **From Session 3dfdb834:** Design decision: directive lives in the agent, not the orchestrator. The orchestrator's existing Step 6 `syntax_valid` check is belt-and-suspenders — the implementer catches and fixes lint errors upstream before Step 5 ends. Spike validation: dispatch implementer against fixture with deliberate `bash -n` error; pass criteria = `LINT_ITERATIONS ≥ 1` + (error fixed OR cap reached with CONFIDENCE ≤ medium and plan-material finding).

→ See also: [[agent-prompt-construction]], [[uplift-cascade-pattern]], [[cascade-scope-contraction]], [[review-fix-intent-alignment]]