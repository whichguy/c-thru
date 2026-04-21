---
name: Agent Structural Testing
type: entity
description: "Testing agent markdown files for structural correctness beyond contract-check — STATUS contracts, RECUSE blocks, fail-closed rosters, escalation chain integrity"
tags: [testing, agents, structural-validation, contract-check, status-contract]
confidence: medium
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [69bfbcd1, 3dfdb834]
related: [agent-prompt-construction, cascade-scope-contraction, implementer-lint-loop, review-fix-intent-alignment, model-map-test-pattern]

# Agent Structural Testing

Two layers of agent testing exist: `c-thru-contract-check.sh` (dangling subagent_type references, missing prompt keys vs declared Input: lines) and agent-status-schema.test.js (STATUS block parsing/validation). Neither validates agent prompt content — RECUSE blocks, escalation chain references, or internal consistency between declared STATUS fields and actual prompt content.

- **From Session 69bfbcd1:** Fail-closed roster gap discovered: 5 agents in `config/model-map.json#agent_to_capability` (planner, journal-digester, plan-orchestrator, wave-synthesizer, learnings-consolidator) had no entry in the fail-closed test roster. A fail-closed test must list every known agent; omissions cause false-positive FAILs. Fixed by adding the 5 missing agents to the test before implementation.
- **From Session 69bfbcd1:** 4 agents (integrator, doc-writer, discovery-advisor, planner-local) are missing RECUSE blocks in their prompt files. The existing contract-check doesn't validate prompt content sections. Planned: new test file `test/agent-prompt-structure.test.sh` to validate RECUSE blocks, STATUS contract conformance (required fields present, VERDICT enum values match spec), and escalation chain integrity (RECOMMEND values reference valid successor agents).
- **From Session 69bfbcd1:** Two-layer test architecture for agents: (1) static structural tests — shell scripts that grep/parse agent .md files for required sections and validate cross-references against `config/model-map.json#agent_to_capability`; (2) live schema tests — spawn a proxy, send an agent capability alias, validate the response matches the declared STATUS schema. Static tests are CI-friendly (no proxy needed); live tests require a running proxy.
- **From Session 3dfdb834:** Planned `test/agent-contract-static.test.js` (Node.js, always-on CI gate): parses every `agents/*.md` file, asserts structural conformance to `docs/agent-architecture.md §"Worker STATUS contract"`. 9 checks per agent: frontmatter model field, agent_to_capability membership, STATUS enum, RECUSE block, RECOMMEND target validity, escalation chain match, extra field declarations (LINT_ITERATIONS for implementer, ITERATIONS for reviewer-fix), uplift-decider VERDICT/CLOUD_CONFIDENCE/RATIONALE form, security-reviewer RECUSE exception. Fail-closed: any agent in `agent_to_capability` not in the roster → FAIL with "new agent not covered by contract tests."
- **From Session 3dfdb834:** Planned `test/agent-contract-live.test.js` (opt-in via `C_THRU_LIVE_AGENT_TESTS=1`): reads each worker agent's system prompt from `agents/<name>.md`, POSTs to running proxy at `model=<agent-name>` with minimal task, validates STATUS block in response. Uses proxy + model routing (no claude harness indirection). Per-agent timeout 60s, `max_tokens: 800`. Skips entirely if env unset, skips individual agents if proxy unreachable after 8s. Validates STATUS enum, CONFIDENCE, SUMMARY, agent-specific extras. Does NOT validate output quality, exact model selection, or SSE streaming.

→ See also: [[agent-prompt-construction]], [[cascade-scope-contraction]], [[implementer-lint-loop]], [[review-fix-intent-alignment]], [[model-map-test-pattern]]