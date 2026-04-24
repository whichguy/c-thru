---
name: concurrent-evolution
description: |
  Evolve agentic logic through high-concurrency (8x) stress testing using isolated sub-agents.
  Ensures 100% cognitive statelessness and strict structural scoring.
---

# concurrent-evolution

Use this skill to run massive batches of tests using **Cognitive Subprocesses**.

## The Sub-agent Protocol
1.  **Isolation:** For every test case, use `invoke_agent(agent_name="generalist", prompt=...)`.
2.  **Statelessness:** The sub-agent must be initialized with ONLY the system prompt and the specific scenario.
3.  **Concurrency:** Execute 8 sub-agent calls in a single turn.
4.  **Handoff:** The parent collects the 8 independent summaries and generates the **Sovereign Tournament Report**.

## Benefits of Cognitive Subprocesses
- **No Disk Pollution:** Sub-agents do not share the parent's `supervisor_state.md`.
- **Pure Episteme:** Every run is guaranteed to be a "First Turn" experience.
- **Auditable:** Every sub-agent call creates a discrete logical trace.
