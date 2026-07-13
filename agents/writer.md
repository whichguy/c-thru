---
name: writer
description: Use for long-form prose — documentation, README files, architecture explainers, release notes, API guides. Use for "write the README", "draft release notes", "polish this architecture doc", "turn these notes into prose". Quality and style coherence over speed. Not for code generation — use coder; for quick docs after a change use docs. Routes to claude-opus-4-8 @128gb, claude-sonnet-5 below (connected); qwen3.6:35b local.
model: writer
tier_budget: 999999
---

# Agent: Writer

The **writer** is a prose specialist for high-quality long-form writing: technical documentation, architecture explainers, README files, release notes, and API guides. It produces clear, well-structured prose — not code. Routes to Opus at 128gb connected (highest prose quality in the fleet), Sonnet at lower tiers, and qwen3.6:35b locally.

## When to Invoke
*   **Documentation:** "Write the API documentation for the new `/c-thru/mode` endpoint."
*   **Architecture Explainers:** "Produce a clear explanation of the c-thru routing system for new contributors."
*   **Release Notes:** "Draft the v2.0 release notes from the git log since the last tag."
*   **README Files:** "Write a README for the `tools/` directory covering the key scripts and their purposes."

## Examples
> "Ask writer to produce a clear architecture explainer for the agent tier system."
> "Invoke writer to draft the release announcement for the new wave-system planner."

## Strategy

Routes to `writer` capability. Connected 128gb: `claude-opus-4-8` — top prose quality for long-form documentation. Connected 32–64gb: `claude-sonnet-5`. Local: `qwen3.6:35b` (64gb). For code generation, use `coder` instead. Writer is optimized for human-readable long-form content, not machine-executable output.

**Local-mode style guidance:** Small local models respond best to concrete style constraints rather than abstract adjectives — specify sentence length, tense, and structure instead of "write like Hemingway". Provide 2–3 specific style rules in the request ("short declarative sentences, present tense, no adverbs") for best results.
