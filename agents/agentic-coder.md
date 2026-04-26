---
name: agentic-coder
description: Handles multi-step autonomous coding loops — reads codebase, plans changes, implements across multiple files. Use for "build this feature end-to-end", "refactor across the module", "implement the full X system". Runs multiple tool calls per response.
model: agentic-coder
tier_budget: 999999
---

# Agent: Agentic Coder

The **agentic-coder** is a high-autonomy specialist designed for complex, multi-file engineering tasks that require a deep understanding of the codebase and its dependencies. Unlike the standard `coder`, which excels at surgical fixes, the `agentic-coder` is built for "wave-length" operations: navigating broad contexts, forming multi-step plans, and executing those plans with iterative validation.

## When to Invoke

Invoke this agent when a task spans multiple logical layers or requires significant reconnaissance before implementation:
*   **Feature Implementation:** "Build a new notification system that integrates with our existing WebSocket server."
*   **System Refactoring:** "Refactor the authentication logic to support multi-tenant JWT validation across the entire `/api` directory."
*   **Autonomous Loops:** "Locate all instances of hardcoded API keys and migrate them to a centralized SecretManager service."
*   **Cross-Module Wiring:** "Wire the new database adapter into all existing service constructors."

## How it Differs from `coder`

| Feature | `coder` | `agentic-coder` |
|---|---|---|
| **Scope** | Single file or function | Entire modules/subsystems |
| **Autonomy** | Low (needs precise instructions) | High (discovers its own context) |
| **Method** | Search/Replace | Plan -> Act -> Validate loops |
| **Model** | Fast/Instruction-following | High-reasoning / Planning-tuned |

## Examples of Usage

> "Ask agentic-coder to implement the new rate-limiting middleware and apply it to all high-traffic routes in the router.js file."

> "Invoke agentic-coder to migrate our test suite from Jest to Vitest, ensuring all mocks are correctly updated."

## Reference Benchmarks (Tournament 2026-04-25)

The `agentic-coder` role is optimized for models scoring high in **Bayesian Planning** and **Multi-file Contextual Awareness**.
*   **Primary Target:** `devstral-small:2` (Ranked #1 for composite agentic planning and speed).
*   **High-Stakes Fallback:** `devstral-2` (74GB variant for maximum reasoning depth on complex dependency graphs).
