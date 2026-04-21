---
name: Self-Recusal Chain
type: entity
description: "Worker agents can return STATUS: RECUSE with RECOMMEND field; orchestrator Step 5r handles escalation — judge-tier sentinel blocks non-dispatchable recommendations"
tags: [architecture, cascade, recusal, agents, escalation, wave-2]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [a82cecbf, b1731578]
related: [uplift-cascade-pattern, cascade-scope-contraction, agent-prompt-construction, capability-profile-model-layers]
---

# Self-Recusal Chain

A mechanism where c-thru worker agents (implementer, reviewer-fix, test-writer, scaffolder) can return `STATUS: RECUSE` with a `RECOMMEND: <agent-name>` field when they recognize they cannot complete the task. The orchestrator's Step 5r handler processes recusals by dispatching to the recommended agent, with a judge-tier sentinel blocking non-dispatchable recommendations (e.g. `RECOMMEND: judge` — no agent to dispatch to, so the item is marked failed instead of silently swallowed).

- **From Session a82cecbf:** Wave-2 implementation shipped (PR #34, 6 commits, 13 files, 684 lines). All four worker agents received the self-recusal rubric: a `## Self-Recusal` section in each agent prompt describing when to return `STATUS: RECUSE` with `RECOMMEND: <agent-name>`. The per-role `RECOMMEND` values differ — e.g. implementer recommends `implementer-cloud`, reviewer-fix recommends `uplift-decider`. The RECUSE STATUS block is distinct from the regular STATUS block; agents must use one or the other.
- **From Session a82cecbf:** Judge-tier sentinel bug found in review-fix (commit `cd4c0ac`): Step 5r code checked `RECOMMEND` and dispatched to the named agent, but `RECOMMEND: judge` would try to dispatch a nonexistent agent (the planner is invoked differently, not as a wave worker). Fixed with an explicit sentinel check: if `RECOMMEND` names a judge-tier agent, the item is marked `escalated:judge_blocked` in `wave.json` and the orchestrator logs a diagnostic instead of attempting dispatch.
- **From Session a82cecbf:** Converger was the only worker agent missing the self-recusal section after initial implementation — caught by review-fix. The converger's recusal scenario is distinct: it recuses when reconciliation is impossible (e.g. fundamental disagreement between parallel explorer outputs that cannot be resolved by context alone).
- **From Session a82cecbf:** Uplift-decider accept path was missing in the orchestrator (commit `63f0fea`): Step 5r had dispatch paths for `uplift` and `restart` verdicts from the uplift-decider, but `accept` was missing — every accept was being silently dropped by the section-missing guard, treated as a failed escalation. Fixed by adding the accept path that marks the item as complete with the local worker's output.
- **From Session a82cecbf:** Test coverage: `test/planner-return-schema.test.js` gained Section 6 fixtures for RECUSE STATUS blocks — judge-tier sentinel detection, depth cap, never-cloud skip, and think-tag stripping in RECUSE responses.

- **From Session b1731578:** Static contract test coverage added for RECUSE chain: `test/agent-contract-static.test.js` validates (1) RECUSE block presence per roster severity tier (fail/warn/exempt), (2) RECOMMEND escalation target matches the hardcoded chain (e.g. implementer→uplift-decider, reviewer-fix→implementer-cloud), (3) security-reviewer exception (RECOMMEND must be absent), (4) fail-closed: agents in `agent_to_capability` without roster entries fail. 4 spec-gap agents (integrator, doc-writer, discovery-advisor, planner-local) flagged as warnings.

→ See also: [[uplift-cascade-pattern]], [[cascade-scope-contraction]], [[agent-prompt-construction]], [[capability-profile-model-layers]], [[agent-contract-testing]]