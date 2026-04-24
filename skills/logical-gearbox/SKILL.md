---
name: logical-gearbox
description: |
  Codifies the visual 'ASCII Gearbox' format for debugging agent logic.
  Used to trace state transitions, logic loops, and evidence grounding.
---

# logical-gearbox

Use this format to visualize the 'Internal Gearbox' of a complex discovery/resolution loop.

## Visual Schema

[PHASE 🔵: EPISTEMIC AUDIT] 🛡️
- Represents the Phase 0 gate.
- Colors: 🔵 Blue = Booting/Auditing.

[PHASE 🟡: THE RATIONALIZER] ⚙️
- Represents the Inquiry Graph and Backlog calculation.
- Colors: 🟡 Yellow = Processing/Thinking.

[PHASE 🟣: INSTRUMENTAL ACTION] 🛠️
- Represents the actual tool execution.
- Colors: 🟣 Purple = Acting.

[PHASE 🟢: SSoT SYNC] 💾
- Represents the state file update and wiki contribution.
- Colors: 🟢 Green = Persisting Memory.

[PHASE 🔴: THE PARITY SHIELD] 🛡️
- Represents the final logical consistency check.
- Colors: 🔴 Red = Terminating/Verifying.

## Rendering Protocol
1.  **Map State:** Identify which logical block the agent is in.
2.  **Trace Inquiry:** Show the "Expected Information Gain" for the turn.
3.  **Audit Grounding:** Link the current turn to an Evidence ID.
