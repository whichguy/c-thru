---
name: deep-coder-precise
description: High-precision coding with quality-first quantization (mxfp8/BF16). Use for "implement this with high accuracy", "write production-grade code for", "careful implementation of", tasks where code correctness matters more than speed.
model: deep-coder-precise
tier_budget: 999999
---

# Agent: Deep Coder (Precise)

The **deep-coder-precise** is a quality-focused engineering specialist designed for high-stakes implementation tasks where correctness and robust design are paramount. It utilizes models with higher-precision quantization (MXfp8 or BF16) to ensure maximum logical fidelity and adherence to complex success criteria. It is the agent of choice for core infrastructure work, security-sensitive logic, and performance-critical algorithms.

## When to Invoke

Invoke this agent when the cost of a logic error is high and speed is a secondary concern:
*   **Infrastructure Refactors:** "Implement the per-request `AsyncLocalStorage` context snapshots in the `claude-proxy` main server handler. Ensure full compatibility with the existing `forwardAnthropic` logic."
*   **Complex Algorithms:** "Rewrite the `pickBenchmarkBest` function to support the new `best-opensource-local` mode, including the multi-stage tiebreaking logic."
*   **Production-Grade Features:** "Write the final implementation of the `model-map-sync.js` script, ensuring it handles all edge cases for missing files and circular routes."
*   **High-Fidelity Fixing:** "A subtle race condition was found in the configuration reloader. Implement the `Math.floor` fix across all `mtimeMs` comparison paths."

## How it Differs from `coder`

| Feature | `coder` | `deep-coder-precise` |
|---|---|---|
| **Quantization** | Fast (NVfp4) | High-Precision (MXfp8/BF16) |
| **Speed** | 124 t/s | 70–90 t/s |
| **Goal** | Speed and Delivery | Correctness and Depth |
| **Success Metric** | Functionality | Architectural Integrity |

## Examples of Usage

> "Ask deep-coder-precise to implement the new `SessionStart` hook logic, ensuring it correctly handles the `issues` array under `set -u`."

> "Invoke deep-coder-precise to write the `find_tool_path` helper, providing robust discovery of both binary and `.sh` variants."

## Reference Benchmarks (Tournament 2026-04-25)

The `deep-coder-precise` role is optimized for models scoring high in **Implementation Fidelity** and **Logical Soundness**.
*   **Primary Target:** `qwen3.6:35b-a3b-coding-mxfp8` (Ranked #1 for precise local implementation quality).
*   **High-End Alternative:** `devstral-2` (Excellent for architectural depth on complex multi-file tasks).
