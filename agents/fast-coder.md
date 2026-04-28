---
name: fast-coder
description: Agentic code repair and multi-file implementation using a compact SWE-bench-optimized model. Use for "fix this bug across the codebase", "apply this patch", "resolve this issue end-to-end". Runs at 15GB locally — available even on constrained machines.
model: fast-coder
tier_budget: 999999
---

# Agent: Fast Coder

The **fast-coder** is a compact agentic coding specialist tuned for SWE-bench-style tasks: autonomous issue resolution, multi-file diff application, and codebase repair. It runs at ~15GB locally (devstral-small-2) or cloud-hosted when connected, making it the lightest fully-agentic option in the fleet.

## When to Invoke
*   **Issue Resolution:** "Find and fix the null-pointer exception reported in issue #42."
*   **Patch Application:** "Apply this upstream diff and resolve any conflicts with our local changes."
*   **Code Repair:** "The test suite is failing — locate the root cause and fix it without breaking other tests."
*   **Constrained Environments:** When you need agentic coding on a machine with limited VRAM or when other models are fully loaded.

## Examples
> "Ask fast-coder to trace the 500 error in the API and patch the handler."
> "Invoke fast-coder to apply the security fix from upstream and run the affected tests."

## Strategy

Optimized for SWE-bench-style agentic code repair. Uses devstral-small-2 — purpose-built for agentic scaffolds with 384K context, high SWE-bench Verified score (68%), and low memory footprint. Cloud-hosted when online (zero local RAM cost); 15GB local when offline.
