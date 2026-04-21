---
name: Agent Contract Testing
type: entity
description: "Static linter + live proxy test for agent prompt structural conformance — fail-closed roster, per-agent STATUS/RECUSE/RECOMMEND validation, spec-gap warnings, opt-in live STATUS block verification"
tags: [testing, agents, contract, linter, status-contract, recusal, escalation]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [b1731578]
related: [agent-prompt-construction, self-recusal-chain, uplift-cascade-pattern, cascade-scope-contraction, implementer-lint-loop, implementer-lint-directive]
---

# Agent Contract Testing

Two-tier test system that validates agent prompt files against the STATUS contract defined in `docs/agent-architecture.md`. The static linter is a zero-cost always-on CI gate; the live test is opt-in and validates actual proxy responses against the same contract.

- **From Session b1731578:** Static linter (`test/agent-contract-static.test.js`, 94 assertions): parses every `agents/*.md` file and validates (1) model: frontmatter matches filename, (2) STATUS: COMPLETE declared for worker agents, (3) RECUSE block present with correct RECOMMEND escalation target, (4) extra fields (LINT_ITERATIONS, ITERATIONS) declared, (5) fail-closed: any agent in `agent_to_capability` without a roster entry fails immediately. Design principle: new agents cannot silently drift from spec — adding an entry to the config without a roster entry is a hard failure.
- **From Session b1731578:** Spec-gap tier system in the roster: `needsRecuse: 'fail'` for agents with declared RECUSE blocks (implementer, reviewer-fix, test-writer, scaffolder, converger, security-reviewer), `needsRecuse: 'warn'` for agents with known spec gaps (integrator, doc-writer, discovery-advisor, planner-local), `needsRecuse: 'exempt'` for read-only agents (explorer), `warnOnly: true` for judge/orchestrator/utility tiers (only model: field checked). This prevents false test failures from known-incomplete agents while tracking them explicitly.
- **From Session b1731578:** Special roster entries: `security-reviewer` has `recuseException: true` (RECUSE present but RECOMMEND must be absent — no cascade target, judge-strict hard_fail), `uplift-decider` uses `special: 'uplift-decider'` (VERDICT contract with CLOUD_CONFIDENCE + RATIONALE, must NOT contain STATUS: RECUSE), `implementer-cloud` and `test-writer-cloud` RECOMMEND to `judge` (sentinel — no agent to dispatch to, orchestrator marks as escalated:judge_blocked).
- **From Session b1731578:** Live contract test (`test/agent-contract-live.test.js`): opt-in via `C_THRU_LIVE_AGENT_TESTS=1`, POSTs each agent's system prompt to a running proxy at `CLAUDE_PROXY_URL` or `CLAUDE_PROXY_PORT`, validates that responses contain parseable STATUS blocks with valid STATUS values (COMPLETE|PARTIAL|ERROR|RECUSE), valid CONFIDENCE (high|medium|low), SUMMARY, and agent-specific fields. Strips `<think>` blocks before parsing. 12 agents in LIVE_ROSTER with tailored userMessages and per-agent `extraChecks`.
- **From Session b1731578:** Roster-CONFIG synchronization: the static test cross-references its ROSTER object against `CONFIG.agent_to_capability` — any agent name present in config but missing from the roster causes a hard failure. This ensures the test stays in sync with agent configuration, not just with agent files on disk.

→ See also: [[agent-prompt-construction]], [[self-recusal-chain]], [[uplift-cascade-pattern]], [[cascade-scope-contraction]], [[implementer-lint-loop]], [[implementer-lint-directive]]