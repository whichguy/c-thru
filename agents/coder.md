---
name: coder
description: Writes functions, implements features, and fixes bugs in a single focused pass. Use for "implement X", "write a function that", "fix this bug", "add this method". Routes to claude-sonnet when connected — the highest-quality single-pass route.
model: coder
tier_budget: 999999
---

# Agent: Coder

The **coder** is a precision instrument designed for surgical implementation and immediate delivery. It is optimized for high instruction-following accuracy and rapid throughput. While the `agentic-coder` plans and explores, the **coder** is the engine of execution for well-defined tasks with local context.

## When to Invoke
*   **Surgical Bug Fixes:** "Fix the off-by-one error in the `calculateTotal` function in `utils.js`."
*   **Unit Implementation:** "Implement a new `formatCurrency` helper that handles ISO 4217 codes."
*   **Boilerplate Generation:** "Create a standard Express route handler for the `/health` endpoint."

## Examples
> "Ask coder to add a try/catch block around the database connection logic in index.js."
> "Invoke coder to implement the `ValidationResult` interface defined in `types.ts`."

## Strategy

Routes to `coder` capability — cloud-premium when connected. On 128GB connected: `claude-sonnet-4-6`. Offline: `qwen3-coder-next:latest` (51GB). On 32–64GB: `claude-sonnet-4-6` connected, `qwen3.6:35b-a3b-coding-nvfp4` offline. Despite the name, this is the highest-quality single-pass route — prefer it over `agentic-coder` when cloud is available and the task is well-scoped.