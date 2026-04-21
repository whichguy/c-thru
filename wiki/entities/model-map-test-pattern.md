---
name: Model-Map Test Pattern
type: entity
description: "Test files referencing shipped config must track tag changes; fixture-based tests are immune. Mirror-drift guard (§18) cross-checks stub vs real resolver. @backend sigil pitfall in integration stubs."
tags: [testing, model-map, maintenance, config-churn, mirror-drift]
confidence: high
last_verified: 2026-04-21
created: 2026-04-20
last_updated: 2026-04-22
sources: [64f2589b, c6237d83, a82cecbf, 863318b0]
related: [capability-profile-model-layers, model-tag-audit-gap, llm-mode-resolution, best-quality-modes, self-recusal-chain]
---

# Model-Map Test Pattern

Three test files exercise model-map logic, but only one reads the shipped `config/model-map.json` for assertion values. The other two use synthetic fixtures and are immune to config tag changes.

- **From Session 64f2589b:** `test/llm-mode-resolution-matrix.test.js` asserts against shipped config (e.g. `claude-opus-4-6` equivalents must include `qwen3.6:35b`). When model tags change, this file must be updated. `test/llm-profiles-editor.test.js` and `test/model-map-v12-adapter.test.js` use arbitrary fixture values to test write mechanics and adapter synthesis — they do NOT read shipped config and are safe across tag changes.
- **From Session c6237d83:** Mirror-drift guard (§18): `llm-mode-resolution-matrix.test.js` now imports the real `resolveProfileModel` from `tools/model-map-resolve.js` and compares its output against the test's local stub for key inputs, asserting they remain identical. This catches cases where the test stub silently diverges from production — e.g. the production resolver was missing a null-guard that the stub had. Pattern: when a test duplicates production logic, add a cross-check import.
- **From Session c6237d83:** `@backend` sigils in test fixtures cause cooldown-key and assertion mismatches: the sigil-stripped model name seen by the backend differs from the `fallback_chains[].model` key, so cooldown lookups and request-assertion comparisons break. Solution: use a single "smart" backend stub that returns different status codes for different model names, avoiding multi-backend `@sigil` routing entirely. Used in §7 (active-path fallback) and §8 (local-terminal guard) of `test/proxy-resolution-matrix.test.js`.

- **From Session 69bfbcd1:** 7 new test files shipped (PR #37, 320 assertions): `model-map-validate.test.js` (25), `capability-alias-resolve.test.js` (124 — 22 agents × 5 tiers against production config), `model-map-layered.test.js` (21), `hw-profile.test.js` (30), `proxy-translation.test.js` (30 — reoriented from Anthropic↔OpenAI translation to declared rewrites after spike found no translation layer), `llm-capabilities-mcp.test.js` (69), `agent-status-schema.test.js` (21). Banner format fix: helpers.js `summary()` printed `N/N passed` but plan requires `N tests: N passed, 0 failed` — all 7 files now use the canonical format.
- **From Session 69bfbcd1:** `capability-alias-resolve.test.js` exercises production config: every agent in `agent_to_capability` must resolve to a concrete model at every hardware tier. Fail-closed by default — any agent that fails to resolve is a real bug, not a test gap. Initial run found 5 agents missing from the roster (planner, journal-digester, plan-orchestrator, wave-synthesizer, learnings-consolidator).

- **From Session a82cecbf:** `test/planner-return-schema.test.js` gained Section 6: RECUSE STATUS fixtures — 8 Wave-2 escalation cases covering judge-tier sentinel detection, depth cap, never-cloud skip, and think-tag stripping in RECUSE responses. These fixtures test the self-recusal chain's contract at the parser level, complementing the integration-level escalation tests in `agent-status-schema.test.js`.
- **From Session f20f3ade:** `test/resolve-capability.test.js` (61 assertions) shipped as companion to the `model-map-resolve.js` extraction. Uses a minimal fixture (5 capabilities × 5 tiers × 4 modes = cartesian product) to validate all resolution paths: `resolveProfileModel`, `resolveLlmMode`, `resolveProfileName`, `resolveLogicalAlias`, `resolveCapabilityAlias`, `resolveConnectivityMode`. Also includes one integration test that loads the real shipped config and resolves every known alias through every tier/mode combination. Runs independently of `llm-mode-resolution-matrix.test.js` — the extraction created two separate test files that validate different surfaces (resolver internals vs. end-to-end mode matrix).
- **From Session 863318b0:** Stdlib-only test convention: all `test/*.test.js` files use a hand-rolled `ok()/fail()` pattern with `process.exit(exitCode)` — no mocha, chai, or other test framework. The project has no `package.json` (no npm install step), so adding a test-runner dependency would create a new class of CI breakage for no practical benefit. CI only needs an exit code; TAP reporters and assertion libraries are unnecessary. This convention applies to all 9+ test files including `agent-contract-static.test.js` and `agent-contract-live.test.js` (PR #39). When writing new tests, follow the `ok(condition, 'message'); fail('message')` pattern from existing files — do not introduce external deps.

→ See also: [[capability-profile-model-layers]], [[model-tag-audit-gap]], [[llm-mode-resolution]], [[best-quality-modes]], [[self-recusal-chain]], [[agent-structural-testing]], [[model-map-resolve-module]]