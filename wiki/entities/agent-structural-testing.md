---
name: Agent Structural Testing
type: entity
description: "Testing agent markdown files for structural correctness beyond contract-check — STATUS contracts, RECUSE blocks, fail-closed rosters, escalation chain integrity"
tags: [testing, agents, structural-validation, contract-check, status-contract]
confidence: medium
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [69bfbcd1, 3dfdb834, b1731578]
related: [agent-prompt-construction, agent-contract-testing, cascade-scope-contraction, implementer-lint-loop, review-fix-intent-alignment, model-map-test-pattern]
last_updated: 2026-04-21

# Agent Structural Testing

Two layers of agent testing exist: `c-thru-contract-check.sh` (dangling subagent_type references, missing prompt keys vs declared Input: lines) and agent-status-schema.test.js (STATUS block parsing/validation). Neither validates agent prompt content — RECUSE blocks, escalation chain references, or internal consistency between declared STATUS fields and actual prompt content.

- **From Session 69bfbcd1:** Fail-closed roster gap discovered: 5 agents in `config/model-map.json#agent_to_capability` (planner, journal-digester, plan-orchestrator, wave-synthesizer, learnings-consolidator) had no entry in the fail-closed test roster. A fail-closed test must list every known agent; omissions cause false-positive FAILs. Fixed by adding the 5 missing agents to the test before implementation.
- **From Session 69bfbcd1:** 4 agents (integrator, doc-writer, discovery-advisor, planner-local) are missing RECUSE blocks in their prompt files. The existing contract-check doesn't validate prompt content sections. This gap was later addressed by `test/agent-contract-static.test.js` (see [[agent-contract-testing]]).
- **From Session 69bfbcd1:** Two-layer test architecture for agents: (1) static structural tests — parse agent .md files for required sections and validate cross-references against `config/model-map.json#agent_to_capability`; (2) live schema tests — POST to running proxy, validate response STATUS schema. Static tests are CI-friendly; live tests opt-in via `C_THRU_LIVE_AGENT_TESTS=1`. Initially planned as shell scripts, shipped as two JS files — see [[agent-contract-testing]] for the final architecture.
- **From Session 3dfdb834:** Planned `test/agent-contract-static.test.js` (Node.js, always-on CI gate): parses every `agents/*.md` file, asserts structural conformance to `docs/agent-architecture.md §"Worker STATUS contract"`. 9 checks per agent: frontmatter model field, agent_to_capability membership, STATUS enum, RECUSE block, RECOMMEND target validity, escalation chain match, extra field declarations (LINT_ITERATIONS for implementer, ITERATIONS for reviewer-fix), uplift-decider VERDICT/CLOUD_CONFIDENCE/RATIONALE form, security-reviewer RECUSE exception. Fail-closed: any agent in `agent_to_capability` not in the roster → FAIL with "new agent not covered by contract tests."
- **From Session 3dfdb834:** Planned `test/agent-contract-live.test.js` (opt-in via `C_THRU_LIVE_AGENT_TESTS=1`): reads each worker agent's system prompt from `agents/<name>.md`, POSTs to running proxy at `model=<agent-name>` with minimal task, validates STATUS block in response. Uses proxy + model routing (no claude harness indirection). Per-agent timeout 60s, `max_tokens: 800`. Skips entirely if env unset, skips individual agents if proxy unreachable after 8s. Validates STATUS enum, CONFIDENCE, SUMMARY, agent-specific extras. Does NOT validate output quality, exact model selection, or SSE streaming.

- **From Session b1731578:** First-run validation of the static linter immediately caught the wave-reviewer rename drift: `wave-reviewer` was present in `config/model-map.json#agent_to_capability` but absent from the test ROSTER, causing 2 hard FAILs and confirming the fail-closed mechanism works as designed. After updating the ROSTER entry from `reviewer-fix` to `wave-reviewer`, the test reached 94 tests: 94 passed, 0 failed, 4 warnings (the 4 warnings are spec-gap agents: integrator, doc-writer, discovery-advisor, planner-local missing RECUSE blocks). The test self-validated its own usefulness in its first run.
- **From Session b1731578:** Live test verbosity limitation discovered: 6 of 9 skips in the live test are local models filling 1200 tokens with work output before reaching the STATUS block — treated as PARTIAL_SKIP (warns, counts as 0 in pass/fail). This is a real limitation of the live test with verbose local models (not a test bug). Cloud backend agents (implementer-cloud, test-writer-cloud, security-reviewer) produce 401/403 responses → treated as skips. Net result: 13/13 pass, 0 fail, 9 skip.
- **From Session b1731578:** install.sh sync required for live test to function: `~/.claude/agents/c-thru/` was entirely missing; `~/.claude/model-map.json` lacked `agent_to_capability`. Both are written by `install.sh` — the live test's fail-closed check reads config from the user profile directory, so the test environment must be current with the shipped config.

- **From Session a183dfe6:** Tier-budget CI check (D7) added as Check 9/9 in `tools/c-thru-contract-check.sh`. Every `agents/*.md` must declare `tier_budget: N` in frontmatter (N = token budget ceiling for that agent's capability alias tier); the check fails the contract gate if any agent is missing the field. All 22 agents received the field in PR #40. See [[agent-tier-budget-frontmatter]] for the full budget table and rationale.

→ See also: [[agent-prompt-construction]], [[agent-contract-testing]], [[cascade-scope-contraction]], [[implementer-lint-loop]], [[review-fix-intent-alignment]], [[model-map-test-pattern]], [[agent-tier-budget-frontmatter]]