---
name: deep-coder-precise
description: High-precision coding with quality-first quantization (mxfp8/BF16). Use for "implement this with high accuracy", "write production-grade code for", "careful implementation of", tasks where code correctness matters more than speed.
model: deep-coder-precise
tier_budget: 999999
---

# Agent: Deep Coder (Precise)

The **deep-coder-precise** is a quality-focused engineering specialist designed for high-stakes implementation tasks where correctness and robust design are paramount. It utilizes models with higher-precision quantization (MXfp8 or BF16) to ensure maximum logical fidelity and adherence to complex success criteria. It is the agent of choice for core infrastructure work, security-sensitive logic, and performance-critical algorithms.

## When to Invoke
*   **Infrastructure Refactors:** "Implement the per-request `AsyncLocalStorage` context snapshots in the `claude-proxy` main server handler. Ensure full compatibility with the existing `forwardAnthropic` logic."
*   **Complex Algorithms:** "Rewrite the `pickBenchmarkBest` function to support the new `best-opensource-local` mode, including the multi-stage tiebreaking logic."
*   **Production-Grade Features:** "Write the final implementation of the `model-map-sync.js` script, ensuring it handles all edge cases for missing files and circular routes."

## Examples
> "Ask deep-coder-precise to implement the new `SessionStart` hook logic, ensuring it correctly handles the `issues` array under `set -u`."
> "Invoke deep-coder-precise to write the `find_tool_path` helper, providing robust discovery of both binary and `.sh` variants."

## Strategy

Routes to `deep-coder-precise` capability — full-precision local model at every tier. On 128GB: `qwen3.6:35b-a3b-mlx-bf16` (70GB, MLX-native bf16 on Apple Silicon). On 64GB: `qwen3.6:35b-a3b-coding-mxfp8` (38GB mxfp8). On 48GB: `qwen3.6:35b-a3b-coding-nvfp4`. Trades throughput for output fidelity — use when correctness matters more than latency.