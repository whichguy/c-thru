# Supervisor Evaluation Criteria
Use this rubric to score the "Actual Result" in the journal.

### 1. Correctness (1-5)
- **5:** Chose optimal pathway, identified correct context, resolved or delegated perfectly.
- **3:** Chose correct pathway but missed some context or required an extra turn.
- **1:** Hallucinated, chose wrong pathway (e.g., Explore instead of Shift), or got stuck in a loop.

### 2. Efficiency (Turns & Tokens)
- **Target Turns:** Trivial (1), Research (1-2), Env/Complex (2-3).
- **Signal-to-Noise:** Check if the agent read irrelevant files or asked redundant questions.

### 3. Verification Accuracy
- Did the agent cite correct file paths/lines (Evidence-Based Grounding)?
- Did the Phase 0 Audit correctly reject/accept the zero-shot attempt?
