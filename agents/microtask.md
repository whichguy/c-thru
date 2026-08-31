---
name: microtask
description: Use for mechanical text jobs with structured, machine-consumed output: classify, label, tag, extract a field, or yes/no judgment. Always the smallest model at every tier. Use for "classify this log line", "tag this PR title", "extract the version". Not for quick conversational answers — use fast-generalist. Not for open-ended reasoning — use generalist.
model: microtask
tier_budget: 999999
---

# Agent: Microtask Specialist

The **microtask** agent handles mechanical text jobs with structured, machine-consumed output: classify, label, tag, extract a field, or yes/no judgment. It always runs on the smallest model at every tier, so it is the cheapest choice for high-volume, low-ambiguity work where a larger model would be wasteful. It is the agent of choice for background classification, labeling, and field extraction.

## When to Invoke
*   **Quick Classification:** "Classify this user prompt into one of our three intent categories: `discovery`, `implementation`, or `audit`."
*   **Simple Transforms:** "Convert this list of comma-separated model names into a JSON array of strings."
*   **Fast Labeling:** "Read the `proxy.log` line and extract the `requestId` and `statusCode` as a two-column table."

## Examples
> "Ask microtask to convert the `PROFILE_KEYS` array into a bulleted list for a GitHub issue comment."
> "Invoke microtask to extract all file paths from this `grep` search result and return them as a newline-separated string."

## Strategy
