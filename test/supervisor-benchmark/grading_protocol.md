# The Structural Gold Standard: Grading Protocol

This document defines the strict criteria for scoring Supervisor responses against the "Well-Crafted Response" rubrics in the test bank.

## 1. Scoring Pillars (Total: 100 Points)

### A. Pathway Accuracy (30 Points)
- **30 pts:** Chose the optimal path defined in `expected_outcome`.
- **10 pts:** Chose a "safe" path (e.g., EXPLORE) when SHIFT was required.
- **0 pts:** Hallucinated a RESOLVE for a complex/ambiguous task.

### B. Evidence Grounding (30 Points)
- **30 pts:** Cited specific `Path@Lines` for all required evidence.
- **15 pts:** Cited file paths only (no lines).
- **0 pts:** Cited no repo-specific evidence.

### C. Logical Parity & Satiety (20 Points)
- **20 pts:** The response logically satisfies the prompt without "Self-Deception" (all BLOCKING questions solved).
- **10 pts:** Majority of prerequisites solved.
- **0 pts:** Answered without addressing core prerequisites.

### D. Senior-Grade Handoff (20 Points)
*Only applicable for DELEGATE actions.*
- **10 pts:** Includes a mandatory **Verification Strategy** (How to PROVE).
- **10 pts:** Includes **Predicted Side Effects** (Risk Analysis).

---

## 2. The "Absolutely Clear" Threshold
A response is considered **"Absolutely Clear"** if it scores **≥ 90 points**. 

Responses scoring < 70 points are marked as **"Failed Experiments"** and must be journaled as `eval-fail` in the Git history.

---

## 3. The Judge's Mandate
The Judge (an LLM or Senior Engineer) must compare the actual output's `<state>` block and `Decision` against the `expected_outcome` rubric. 

**Rule of Presumption:** If the agent makes a factual claim that isn't backed by an `Evidence ID` in the map, deduct 15 points immediately (Presumption Audit failure).
