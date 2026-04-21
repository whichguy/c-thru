---
name: Agent Tier-Budget Frontmatter
type: entity
description: "tier_budget: N field in every agents/*.md declaring token ceiling per capability tier — CI-enforced by contract-check.sh Check 9/9"
tags: [architecture, agents, token-budget, frontmatter, ci, contract-check]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [a183dfe6]
related: [agent-prompt-construction, agent-structural-testing, capability-profile-model-layers]
---

# Agent Tier-Budget Frontmatter

A CI-enforced frontmatter field (`tier_budget: N`) added to every `agents/*.md` file, declaring the token budget ceiling for that agent's capability-alias tier. Enforced by Check 9/9 in `tools/c-thru-contract-check.sh` — any agent missing the field fails the contract gate. Values align with the token budget ceilings defined in the agent-prompt-construction principles (pattern-coder 500, code-analyst 500-800, deep-coder 800, orchestrator 1200, judge/judge-strict 1500).

- **From Session a183dfe6:** D7 added as part of Batch C/E/D (PR #40). All 22 agents in `agents/*.md` received `tier_budget: N` frontmatter via a scripted bulk-add, then reviewed individually. Budget values: `scaffolder` 500 (pattern-coder/1.7-9B), `explorer` 500, `discovery-advisor` 500, `learnings-consolidator` 500; `implementer` 800 (deep-coder/27B+), `test-writer` 800, `wave-reviewer` 800, `integrator` 800, `converger` 800; `implementer-cloud` 800, `test-writer-cloud` 800, `doc-writer` 800; `planner-local` 800 (local); `plan-orchestrator` 1200 (orchestrator), `planner` 1500 (judge), `auditor` 1500, `review-plan` 1500, `final-reviewer` 1500, `uplift-decider` 200 (low — forcing function prompt), `security-reviewer` 1500 (judge-strict), `journal-digester` 1500, `wave-synthesizer` 800 (code-analyst). The CI check (`c-thru-contract-check.sh Check 9`) fails if any agent file is missing this field — new agents cannot be silently deployed at an unbudgeted tier.
- **From Session a183dfe6:** The frontmatter field is declarative, not enforced at inference time. Its value is the intended budget from `agent-prompt-construction` principles; actual prompt length may still exceed it (the check enforces declaration, not compliance). Future tooling could add a `--measure` mode to compare declared vs. actual token count per agent file.

→ See also: [[agent-prompt-construction]], [[agent-structural-testing]], [[capability-profile-model-layers]]
