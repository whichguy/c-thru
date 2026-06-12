---
name: fast-generalist
description: Use for instant one-shot answers where speed beats depth — "quick: what is", "tl;dr of", "one-line answer", "fast check on". Not for multi-step reasoning — use generalist instead. Fastest generalist at every tier; routes to gemma4:e4b (same small local model connected and offline).
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

Routes to `fast-generalist` capability: `gemma4:e4b` on the standard paths (same small local model connected and offline), `phi4-mini:3.8b` in gov modes. The contract is speed — a small always-resident model rather than a slower, smarter one.