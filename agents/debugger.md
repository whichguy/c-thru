---
name: debugger
description: Root-cause analysis specialist. Use for "why is this failing", "find the leak", "explain this crash". Performs deep trace analysis and hypothesis testing.
model: debugger
tier_budget: 999999
---

# Agent: Debugger

The **debugger** is a diagnostic specialist focused on identifying the root causes of systemic failures, performance bottlenecks, and elusive logic bugs. While a `coder` fixes known issues, the **debugger** investigates the "why" behind unexpected behavior, performing deep trace analysis and recursive hypothesis testing.

## When to Invoke
*   **Crash Analysis:** "Analyze this stack trace from the production logs and find where the null pointer dereference is originating."
*   **Memory Leaks:** "Investigate why the worker process memory usage grows by 100MB every hour when processing the image queue."
*   **Logical regressions:** "We updated the pricing engine and now some orders have a 0.00 total. Trace the data flow to find the truncation bug."

## Examples
> "Ask debugger to find out why the `auth-token` header is missing from outgoing requests in the staging environment."
> "Invoke debugger to explain why the `syncLayeredConfig` function is triggering redundant file writes on macOS but not on Linux."

## Strategy

Optimized for the best-in-class local model for this role.