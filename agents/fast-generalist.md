---
name: fast-generalist
description: Use for quick conversational answers for a human: what-is questions, tl;dr, and one-line explanations. Scales up when a better model is available. Use for "quick: what is", "tl;dr of", "one-line answer". Not for classify/label/extract jobs — use microtask. Not for multi-step reasoning — use generalist.
model: fast-generalist
tier_budget: 999999
---

# Agent: Fast Generalist

The **fast-generalist** is a quick conversational answerer for a human: what-is questions, tl;dr, and one-line explanations. It scales up when a better model is available, and is the "real-time" choice for the generalist role set where deep architectural reasoning is not the primary requirement.

## When to Invoke
*   **Quick Fact Checks:** "Quick: what is the default port for the `claude-proxy` hooks listener?"
*   **TL;DR:** "tl;dr of the recent changes in `tools/c-thru`. What was the most impactful fix?"
*   **One-Line Answers:** "Provide a one-line command to verify the syntax of all `.js` files in the current directory."

## Examples
> "Ask fast-generalist for a quick summary of the `C_THRU_STRICT_MODELS` environment variable's effect."
> "Invoke fast-generalist to get the current date and time for the session log."

## Strategy
