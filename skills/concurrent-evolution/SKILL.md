---
name: concurrent-evolution
description: |
  Evolve agentic logic through high-concurrency (8x) stress testing.
  Uses a parallelized pool to run isolated contexts and grade results.
---

# concurrent-evolution

Use this skill to run massive batches of test cases (up to 11,000) using a concurrency of 8.

## The Parallel Protocol
1.  **Pool Management:** Spawns 8 independent "Fresh Context" runners.
2.  **Stateless Execution:** Each runner is a sovereign entity with zero context bleed.
3.  **Real-Time Grading:** Scores are calculated turn-by-turn against the Gold Standard.

## Primary Tool: `c-thru-parallel`
```bash
node tools/c-thru-parallel.js --variant <path> --count <n>
```

---

### **Instruction for the Agent**
When you run a concurrent test, you MUST:
- Use `tools/c-thru-parallel.js`.
- Monitor the 8 threads for "Logical Flapping."
- Journal the summary of the 8-case batch using `tools/c-thru-journal`.
