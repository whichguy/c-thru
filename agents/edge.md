---
name: edge
description: Runs on small models optimized for low-RAM or CI environments. Use for "quick classification", "lightweight summarization", "fast label or tag", "simple regex or transform" — tasks where a 1–7B model suffices and speed or resource constraints matter.
model: edge
tier_budget: 999999
---

# Agent: Edge Specialist

The **edge** agent is a resource-optimized specialist designed to run on very small models (1–7B) in low-RAM or CI environments. It is the "utility" player of the role set, optimized for high-speed classification, lightweight summarization, and simple text transformations where the full power of a larger generalist would be wasteful. It is the agent of choice for background tasks, real-time labeling, and high-frequency checks.

## When to Invoke
*   **Quick Classification:** "Classify this user prompt into one of our three intent categories: `discovery`, `implementation`, or `audit`."
*   **Simple Transforms:** "Convert this list of comma-separated model names into a JSON array of strings."
*   **Fast Labeling:** "Read the `proxy.log` line and extract the `requestId` and `statusCode` as a two-column table."

## Examples
> "Ask edge to convert the `PROFILE_KEYS` array into a bulleted list for a GitHub issue comment."
> "Invoke edge to extract all file paths from this `grep` search result and return them as a newline-separated string."

## Strategy

Routes to `pattern-coder` capability — smallest capable local model. On 128GB and most tiers: `qwen3-coder:30b` (18GB, MoE with 3.3B active parameters — fast despite the 30B label). On 16GB: `qwen3:1.7b`. Use when throughput and RAM efficiency matter more than reasoning depth.