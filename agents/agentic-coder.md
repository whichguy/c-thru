---
name: agentic-coder
description: Handles multi-step autonomous coding loops — reads codebase, plans changes, implements across multiple files. Use for "build this feature end-to-end", "refactor across the module", "implement the full X system". Always routes local — never cloud — so it remains available even when disconnected.
model: agentic-coder
tier_budget: 999999
---

# Agent: Agentic Coder

The **agentic-coder** is a high-autonomy specialist designed for complex, multi-file engineering tasks that require a deep understanding of the codebase and its dependencies. Unlike the standard `coder`, which excels at surgical fixes, the `agentic-coder` is built for "wave-length" operations: navigating broad contexts, forming multi-step plans, and executing those plans with iterative validation.

## When to Invoke
*   **Feature Implementation:** "Build a new notification system that integrates with our existing WebSocket server."
*   **System Refactoring:** "Refactor the authentication logic to support multi-tenant JWT validation across the entire `/api` directory."
*   **Autonomous Loops:** "Locate all instances of hardcoded API keys and migrate them to a centralized SecretManager service."

## Examples
> "Ask agentic-coder to implement the new rate-limiting middleware and apply it to all high-traffic routes in the router.js file."
> "Invoke agentic-coder to migrate our test suite from Jest to Vitest, ensuring all mocks are correctly updated."

## Strategy

Routes to `agentic-coder` capability — always local, never cloud. On 128GB: `qwen3.6:35b-a3b-coding-nvfp4` (21GB, fast nvfp4). On 32–64GB: `devstral-small-2:24b` (15GB, 68% SWE-bench). The local-first constraint keeps this agent available in offline/fleet environments and leaves cloud quota for judge and orchestrator.