---
name: large-general
description: 65B+ class capability for ambiguous, cross-domain, or high-stakes general tasks. Use for "deeply analyze", "think carefully about", "cross-domain synthesis of", tasks that require broad knowledge and nuanced judgment beyond standard model capacity.
model: large-general
tier_budget: 999999
---

# Agent: Large Generalist

The **large-general** is a high-capacity specialist designed for ambiguous, cross-domain, or high-stakes general tasks. It utilizes large-parameter models (65B+) to provide nuanced judgment, broad knowledge retrieval, and sophisticated synthesis across disparate fields. While a standard `generalist` handles everyday triage, the **large-general** is the agent of choice for deep analysis where the relationship between technical requirements, human workflows, and project strategy must be carefully balanced.

## When to Invoke
*   **Deep Analysis:** "Deeply analyze the long-term maintainability of the `AsyncLocalStorage` refactor. How will it scale as we add support for multiple cloud backends?"
*   **Cross-Domain Synthesis:** "Synthesize the technical findings from the `mtimeMs` investigation with the UX requirements for a 'Fancy' startup banner. Propose a unified implementation strategy."
*   **High-Stakes Judgment:** "Think carefully about the trade-offs of unsetting `ANTHROPIC_API_KEY` for the child process. Could this lead to authentication failures for certain edge-case MCP servers?"

## Examples
> "Ask large-general to audit the `CLAUDE.md` file. Does it accurately capture all of the new architectural invariants introduced in the last 10 waves?"
> "Invoke large-general to deeply analyze the performance impact of our new 'blocking warming' strategy on the overall developer experience."

## Strategy

Optimized for the best-in-class local model for this role.