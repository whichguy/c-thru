---
name: competitive-evolution
description: |
  Codifies the 'Grand Tournament' process for evolving prompts and system logic.
  Ensures isolation, strict scoring against gold standards, and institutional memory.
---

# competitive-evolution

This skill manages the iterative refinement of agentic logic through competitive stress-testing (The GAN Strategy).

## The Tournament Protocol

... [Previous phases remain] ...

### Phase 5: State-Space Archive (The Plan Outcome)
Every tournament turn or resolution MUST emit the final **`supervisor_state.md`**.
- This file serves as the **Immutable Knowledge Graph** of the operations.
- It must contain the final **Inquiry Graph**, **Surgical Evidence Map**, and **Verification Proof**.
- **Rule:** The "Well-Crafted Response" is not just the answer; it is the **State File** that proves how the answer was reached.

## Evolution Loop
1.  **Select Champion:** Use the variant with the highest average score as the baseline.
2.  **Hypothesize Improvement:** Generate a new candidate that specifically targets a failure mode (e.g., adding Anti-Flap logic).
3.  **Stress Test:** Run the new candidate against the **High-Entropy Bank**.
4.  **Audit:** If the score increases and logic converges, commit as `eval-pass`. If not, commit `eval-fail` and revert.

## Invariants
- **No Self-Deception:** An agent cannot grade its own performance.
- **Stateless Truth:** Truth is defined by the Evidence Map, not the conversation history.
- **Pedagogical History:** Every failed experiment is a required lesson for the next iteration.
