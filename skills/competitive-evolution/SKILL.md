---
name: competitive-evolution
description: |
  Codifies the 'Grand Tournament' process for evolving prompts and system logic.
  Ensures isolation, strict scoring against gold standards, and institutional memory.
---

# competitive-evolution

This skill manages the iterative refinement of agentic logic through competitive stress-testing (The GAN Strategy).

## The Tournament Protocol

### Phase 1: Isolation & Instantiation
Every test run MUST be a "Fresh Context" event.
1.  Strip all residual chat history.
2.  Instantiate the candidate prompt as a sovereign entity.
3.  Execute using **Harness v3 (Isolation Protocol)** to prevent context leakage.

### Phase 2: Competitive Scoring
Grade the response using the **Structural Gold Standard (100-pt Rubric)**:
- **Pathway Accuracy (30 pts):** Optimal branch selected.
- **Evidence Grounding (30 pts):** Surgical `Path@Lines` citations.
- **Logical Parity (20 pts):** BLOCKING questions solved without self-deception.
- **Senior Handoff (20 pts):** Side-Effects + Verification Strategy.

### Phase 3: Flapping Audit
Compare the result against previous iterations in the **Teacher-Researcher Journal**.
- Identify if the variant is "toggling" between conclusions across turns.
- Check for **Logical Divergence** (Expansion of search space without information gain).

### Phase 4: Chronicler Handoff
Record the outcome using the **Git Transaction Protocol**.
```bash
./tools/c-thru-journal [pass|fail] --component "..." --logic "..." --eval "Tournament Score: N/100"
```

## Evolution Loop
1.  **Select Champion:** Use the variant with the highest average score as the baseline.
2.  **Hypothesize Improvement:** Generate a new candidate that specifically targets a failure mode (e.g., adding Anti-Flap logic).
3.  **Stress Test:** Run the new candidate against the **High-Entropy Bank**.
4.  **Audit:** If the score increases and logic converges, commit as `eval-pass`. If not, commit `eval-fail` and revert.

## Invariants
- **No Self-Deception:** An agent cannot grade its own performance.
- **Stateless Truth:** Truth is defined by the Evidence Map, not the conversation history.
- **Pedagogical History:** Every failed experiment is a required lesson for the next iteration.
