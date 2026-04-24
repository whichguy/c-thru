---
name: competitive-evolution
description: |
  Evolve agentic logic through repeatable, isolated competitive stress-testing.
  Enforces statelessness and strict 100-point structural scoring.
---

# competitive-evolution

Use this skill to run a prompt variant (PROD or DEBUG) through the 2,200-case test bank in 100% isolated context.

## Primary Tool: `c-thru-tournament`

### The "Clean-Run" Benchmark
Executes a batch of cases. For every single case, the system prompt is re-instantiated in a fresh Gemini context to prevent any context pollution.

```bash
# Run 100 isolated tests for the PROD variant
node tools/c-thru-tournament.js --batch --variant agents/supervisor.md --count 100

# Run 100 isolated tests for the DEBUG variant
node tools/c-thru-tournament.js --batch --variant agents/supervisor-debug.md --count 100
```

## The Isolation Guarantee
1.  **Fresh Context:** The harness strips all residual history before every test.
2.  **Sovereign State:** Every run starts with a clean `supervisor_state.md`.
3.  **Hermetic Archival:** Every outcome is moved to `test/results/archives/` via the cleanup tool before the next prompt is loaded.

## Evaluation Workflow
To verify a new change:
1.  Stage your prompt change.
2.  **Invoke:** "Gemini, run a clean-context benchmark on agents/supervisor.md for 20 cases."
3.  **Score:** The evaluator will grade based on the 100-pt Gold Standard.
4.  **Journal:** If the average score improves, commit as `eval-pass`. If it declines, commit `eval-fail` and revert.

---

### **Logical Directives**
- **"Run PROD benchmark"**: Executes the batch using the token-optimized binary.
- **"Run DEBUG benchmark"**: Executes the batch using the full-telemetry source.
