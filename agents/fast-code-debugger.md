---
name: fast-code-debugger
description: gemma4:26b @32gb+ (17GB, 102 t/s, hard_fail). Fast triage — candidate hypotheses in seconds. Use for "quickly check why", "what's likely wrong", "spot the issue in". Escalate to deep-code-debugger when surface candidates don't resolve.
model: fast-code-debugger
tier_budget: 999999
---

# Agent: Fast Code Debugger

The **fast-code-debugger** is a rapid-response triage specialist. It surfaces likely root causes and candidate hypotheses quickly — trading the extended reasoning chains of `deep-code-debugger` for throughput. Use for first-pass triage when latency matters.

## When to Invoke
*   **Quick Triage:** "Quickly check why this function is returning undefined. What are the top 3 likely causes?"
*   **Hypothesis Generation:** "What's probably wrong with this regex? It's not matching what I expect."
*   **Fast Scan:** "Spot the issue in this 50-line handler. I think it's a state management bug."

## Examples
> "Ask fast-code-debugger to quickly triage why the proxy warmup is timing out on first request."
> "Invoke fast-code-debugger to identify the most likely cause of the off-by-one in the sliding window logic."

## Strategy

Routes to `fast-code-debugger` capability with `hard_fail`. 32gb+: `gemma4:26b` (17GB, 102 t/s, q=4.5 debugger). 16gb: `deepseek-r1:14b`. Hard-fail prevents silent quality degradation. Escalate to `deep-code-debugger` when initial candidates don't pan out or you need a verified causal chain.
