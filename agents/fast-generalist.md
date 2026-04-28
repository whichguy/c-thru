---
name: fast-generalist
description: gemma4:26b — 102 t/s, 17GB, hard_fail. Fastest generalist across all 32gb+ tiers (connected and offline same model). Use for "quick: what is", "tl;dr of", "one-line answer", "fast check on". Not for multi-step reasoning — use generalist instead.
model: fast-generalist
tier_budget: 999999
---

# Agent: Fast Generalist

The **fast-generalist** is a high-speed all-rounder designed for rapid responses, quick triage, and low-latency Q&A. It is the "real-time" choice for the generalist role set, optimized for immediate delivery of one-line answers, summaries, and fast checks where deep architectural reasoning is not the primary requirement.

## When to Invoke
*   **Quick Fact Checks:** "Quick: what is the default port for the `claude-proxy` hooks listener?"
*   **TL;DR Summarization:** "tl;dr of the recent changes in `tools/c-thru`. What was the most impactful fix?"
*   **One-Line Answers:** "Provide a one-line command to verify the syntax of all `.js` files in the current directory."

## Examples
> "Ask fast-generalist for a quick summary of the `C_THRU_STRICT_MODELS` environment variable's effect."
> "Invoke fast-generalist to get the current date and time for the session log."

## Strategy

Routes to `fast-generalist` capability (mirrors `classifier`) with `hard_fail`. `gemma4:26b` (17GB, 102 t/s) on all 32gb+ tiers — same model connected and offline. Falls to `qwen3:1.7b` at 16gb. Fails hard rather than cascading to a slower model; the contract is speed.