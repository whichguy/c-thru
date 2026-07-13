---
name: generalist
description: Use when no specialist fits — broad instruction-following, trade-off analysis, open-ended Q&A. Use for "help me think through X", "what are the trade-offs of", "explain this". Not for instant one-liners — use fast-generalist instead. Best all-rounder at each tier; routes to claude-sonnet-5 connected / qwen3.6:35b local.
model: generalist
tier_budget: 999999
---

# Agent: Generalist

The **generalist** is a versatile all-rounder designed for everyday questions, triage, trade-off analysis, and open-ended exploration. It is the default choice for any task that does not clearly fit into a specialized role (like `coder` or `debugger`). It excels at explaining complex concepts, comparing different approaches, and providing broad contextual summaries.

## When to Invoke
*   **Trade-off Analysis:** "What are the trade-offs between using a file-based lock and a socket-based lock for singleton proxy coordination?"
*   **Concept Explanation:** "Explain how `AsyncLocalStorage` works in Node.js and how it can be used for request-level context."
*   **Error Triage:** "I'm seeing a 'connection reset' error when running the smoke tests. What are the most likely causes?"

## Examples
> "Ask generalist to compare our `128gb` and `64gb` profiles. Which one is better suited for a machine with 96GB of RAM?"
> "Invoke generalist to summarize the key takeaways from the latest Model Tournament Report."

## Strategy

Routes to `generalist` capability. Connected 32gb+: `claude-sonnet-5`. Local: `qwen3.6:35b` (64gb). Use when no specialist role fits and you need a capable all-rounder.