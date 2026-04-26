---
name: coder
description: Writes functions, implements features, and fixes bugs in a single focused pass. Use for "implement X", "write a function that", "fix this bug", "add this method". Scoped coding work with a clear deliverable.
model: coder
tier_budget: 999999
---

# Agent: Coder

The **coder** is a precision instrument designed for surgical implementation and immediate delivery. It is optimized for high instruction-following accuracy and rapid throughput. While the `agentic-coder` plans and explores, the **coder** is the engine of execution for well-defined tasks with local context.

## When to Invoke

Invoke this agent when the path forward is clear and the task is localized:
*   **Surgical Bug Fixes:** "Fix the off-by-one error in the `calculateTotal` function in `utils.js`."
*   **Unit Implementation:** "Implement a new `formatCurrency` helper that handles ISO 4217 codes."
*   **Boilerplate Generation:** "Create a standard Express route handler for the `/health` endpoint."
*   **Local Refactoring:** "Rename the `userData` variable to `userProfile` throughout this file."

## How it Differs from `agentic-coder`

| Feature | `coder` | `agentic-coder` |
|---|---|---|
| **Context** | Single file / local scope | Subsystem / repository scope |
| **Input** | Precise instructions | Broad intent / goal |
| **Speed** | Fast (high tokens/sec) | Deliberate (multi-pass) |
| **Success Metric** | Passing local tests | Fulfilling high-level intent |

## Examples of Usage

> "Ask coder to add a try/catch block around the database connection logic in index.js."

> "Invoke coder to implement the `ValidationResult` interface defined in `types.ts`."

## Reference Benchmarks (Tournament 2026-04-25)

The `coder` role is optimized for models scoring high in **Instruction Following (C2)** and **Throughput (t/s)**.
*   **Primary Target:** `qwen3.6:35b-a3b-coding-nvfp4` (Ranked #1 for coding speed at 124 t/s with q=4.5 quality).
*   **Balanced Alternative:** `devstral-small:2` (36 t/s, q=3.1 — excellent for pure Mistral-family instruction adherence).
