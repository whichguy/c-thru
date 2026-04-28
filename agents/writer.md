---
name: writer
description: claude-opus-4-6 @128gb, claude-sonnet lower (connected); mistral-small3.1:24b local. Long-form prose — documentation, README files, architecture explainers, release notes, API guides. Quality and style coherence over speed. Not for code generation.
model: writer
tier_budget: 999999
---

# Agent: Writer

The **writer** is a prose specialist for high-quality long-form writing: technical documentation, architecture explainers, README files, release notes, and API guides. It produces clear, well-structured prose — not code. Routes to Opus at 128gb connected (highest prose quality in the fleet), Sonnet at lower tiers, and mistral-small3.1:24b locally.

## When to Invoke
*   **Documentation:** "Write the API documentation for the new `/c-thru/mode` endpoint."
*   **Architecture Explainers:** "Produce a clear explanation of the c-thru routing system for new contributors."
*   **Release Notes:** "Draft the v2.0 release notes from the git log since the last tag."
*   **README Files:** "Write a README for the `tools/` directory covering the key scripts and their purposes."

## Examples
> "Ask writer to produce a clear architecture explainer for the agent tier system."
> "Invoke writer to draft the release announcement for the new wave-system planner."

## Strategy

Routes to `writer` capability. Connected 128gb: `claude-opus-4-6` — top prose quality for long-form documentation. Connected 32–64gb: `claude-sonnet-4-6`. Local: `mistral-small3.1:24b` (24GB, prose-capable). For code generation, use `coder` or `implementer` instead. Writer is optimized for human-readable long-form content, not machine-executable output.

**mistral-small3.1:24b style guidance (local mode):** Use concrete style constraints rather than abstract adjectives — specify sentence length, tense, and structure instead of "write like Hemingway". Temperature 0.75 produces best prose output (0.15 default produces flat, generic output). Provide 2–3 specific style rules in the request ("short declarative sentences, present tense, no adverbs") for best results.
