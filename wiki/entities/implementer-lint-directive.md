---
name: Implementer Lint Directive
type: entity
description: "Self-directed lint verification loop baked into implementer agent prompt — stdlib-only linters, brief directive not procedural, LINT_ITERATIONS in STATUS block"
tags: [architecture, agents, lint, directive, implementer, stdlib]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [a82cecbf, eb903ef6]
related: [agent-prompt-construction, uplift-cascade-pattern, cascade-scope-contraction]
---

# Implementer Lint Directive

A brief directive in the implementer agent prompt instructing it to run available stdlib-only linters after completing code work, fix any errors found, and report `LINT_ITERATIONS: N` in the STATUS block. The design principle: a directive should tell the agent what to do without scripting every guard — "a missing linter is not failure, skip it." Contrast with a procedural `## Post-work verification` section that over-specifies guard logic.

- **From Session a82cecbf:** Design clarified by user: the linter loop should be a self-directed step by the implementer agent itself (a directive in the agent system prompt), not a separate orchestrator-enforced step. This mirrors the reviewer-fix self-iteration pattern — the agent prompt IS the system prompt for each dispatch, so a brief directive there is exactly "a directive by the implementer agent itself."
- **From Session a82cecbf:** Stdlib-only linter list discovered by probing the local system: `bash -n` (shell syntax), `node --check` (JS syntax), `python3 -m py_compile` (Python syntax), `tsc` (TypeScript). No `ruff`, `flake8`, `shellcheck`, `yamllint` — these are not universally installed. The plan explicitly excludes opinionated linters (ruff/flake8 style rules, yamllint, JSONC false-positives) because they contradict the "what this does NOT do" clause and add fragile deps.
- **From Session a82cecbf:** `LINT_ITERATIONS: N` field added to implementer STATUS block, capped at 5. Invariants: `LINT_ITERATIONS: 0` means clean or no-applicable-linter; `LINT_ITERATIONS: 5 + CONFIDENCE: high` is invalid (hit cap + still errors means confidence should be lower). The cap+confidence invariant is enforced in test fixtures.
- **From Session a82cecbf:** Review-plan ran 4 passes (2 evaluator rounds + 2 senior critic rounds) before converging on READY. Key critiques applied: (1) POST_IMPLEMENT placeholder corrected to reference actual plan content, (2) fixture #5 logic fixed (cap+errors is invalid, clean 5th pass is valid), (3) behavioral spike added to validate agents follow the prose lint directive, (4) repo build gate (`node --check model-map-*.js`) added to verification. Plan also applies to `implementer-cloud.md` (same directive, same STATUS field).
- **From Session eb903ef6:** Shipped (PR #36, commit aa45648). The directive is now live in `agents/implementer.md` and `agents/implementer-cloud.md`. Validated by `test/agent-contract-static.test.js` (94 assertions, PR #39).

→ See also: [[agent-prompt-construction]], [[uplift-cascade-pattern]], [[cascade-scope-contraction]], [[implementer-lint-loop]]