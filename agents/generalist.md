---
name: generalist
description: Handles everyday questions, triage, trade-off analysis, and open-ended exploration. Use for "help me think through X", "what are the trade-offs of", "explain this error", "quick answer on". The default choice when no specialized role fits.
model: generalist
tier_budget: 999999
---

# Agent: Generalist

The **generalist** is a versatile all-rounder designed for everyday questions, triage, trade-off analysis, and open-ended exploration. It is the default choice for any task that does not clearly fit into a specialized role (like `coder` or `debugger`). It excels at explaining complex concepts, comparing different approaches, and providing broad contextual summaries.

## When to Invoke

Invoke this agent for broad inquiries, brainstorming, and initial triage:
*   **Trade-off Analysis:** "What are the trade-offs between using a file-based lock and a socket-based lock for singleton proxy coordination?"
*   **Concept Explanation:** "Explain how `AsyncLocalStorage` works in Node.js and how it can be used for request-level context."
*   **Error Triage:** "I'm seeing a 'connection reset' error when running the smoke tests. What are the most likely causes?"
*   **Brainstorming:** "We need a way to make c-thru startup feel more professional. Suggest some terminal-friendly UX patterns for a 'Fancy' startup banner."

## How it Differs from Specialized Agents

| Feature | `generalist` | `specialist` (e.g. `coder`) |
|---|---|---|
| **Scope** | Broad and conceptual | Narrow and technical |
| **Output** | Narrative and discursive | Atomic and executable |
| **Goal** | Understanding and decision-making | Implementation and verification |

## Examples of Usage

> "Ask generalist to compare our `128gb` and `64gb` profiles. Which one is better suited for a machine with 96GB of RAM?"

> "Invoke generalist to summarize the key takeaways from the latest Model Tournament Report."

## Reference Benchmarks (Tournament 2026-04-25)

The `generalist` role is optimized for models scoring high in **Contextual Depth** and **Conversational Nuance**.
*   **Primary Target:** `qwen3.6:35b-a3b` (Ranked #1 for generalist reasoning with q=5.0).
*   **Balanced Alternative:** `gemma4:26b-a4b` (High quality at 103 t/s for rapid conversational turns).
