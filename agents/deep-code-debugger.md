---
name: deep-code-debugger
description: deepseek-r1:14b @16-32gb, deepseek-r1:32b @48gb+. Extended chain-of-thought reasoning for root-cause analysis. Use for multi-step causal bugs, memory leaks, race conditions. Slow but verifiable. Prefer fast-code-debugger for quick triage.
model: deep-code-debugger
tier_budget: 999999
---

# Agent: Deep Code Debugger

The **deep-code-debugger** is a root-cause analysis specialist. It investigates the "why" behind unexpected behavior through extended reasoning chains and recursive hypothesis testing. Use when fast triage hasn't resolved the issue or you need a verifiable causal chain, not just candidate guesses.

## When to Invoke
*   **Crash Analysis:** "Analyze this stack trace from the production logs and find where the null pointer dereference is originating."
*   **Memory Leaks:** "Investigate why the worker process memory usage grows by 100MB every hour when processing the image queue."
*   **Logical Regressions:** "We updated the pricing engine and now some orders have a 0.00 total. Trace the data flow to find the truncation bug."

## Examples
> "Ask deep-code-debugger to find out why the `auth-token` header is missing from outgoing requests in the staging environment."
> "Invoke deep-code-debugger to explain why the `syncLayeredConfig` function is triggering redundant file writes on macOS but not on Linux."

## Strategy

Routes to `deep-code-debugger` capability. 16–32gb: `deepseek-r1:14b` (9GB, 51 t/s). 48gb+: `deepseek-r1:32b` (19GB, 25 t/s). Not a coding model — a reasoning model. Produces extended hypothesis chains (30–120s). Use over `fast-code-debugger` when surface candidates don't pan out or you need a verified step-by-step causal chain.

**deepseek-r1 distill activation:** The models backing this agent are distilled variants, not full R1. They require a brief role declaration to activate reasoning mode — include "You are a software debugger specializing in root-cause analysis." when constructing prompts. Do NOT add "think step-by-step" instructions — the model reasons internally. Never use few-shot examples; they degrade distill-variant reasoning quality (source: Together AI + HF discussion #2).
