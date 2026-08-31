---
name: writer
description: Use to author long-form prose where the document is the deliverable: new READMEs, architecture explainers, tutorials, API guides, and release notes. Use for "write a guide", "draft release notes", "write the README". Not for syncing existing docs to a code change — use docs. README rule: writer creates or rewrites whole; docs edits sections after a change.
model: writer
tier_budget: 999999
---

# Agent: Writer

The **writer** is a prose specialist for high-quality long-form writing: technical documentation, architecture explainers, README files, release notes, and API guides. It produces clear, well-structured prose — not code.

## When to Invoke
*   **Documentation:** "Write the API documentation for the new `/c-thru/mode` endpoint."
*   **Architecture Explainers:** "Produce a clear explanation of the c-thru routing system for new contributors."
*   **Release Notes:** "Draft the v2.0 release notes from the git log since the last tag."
*   **README Files:** "Write a README for the `tools/` directory covering the key scripts and their purposes."

## Examples
> "Ask writer to produce a clear architecture explainer for the agent tier system."
> "Invoke writer to draft the release announcement for the new wave-system planner."

## Strategy

**Local-mode style guidance:** Small local models respond best to concrete style constraints rather than abstract adjectives — specify sentence length, tense, and structure instead of "write like Hemingway". Provide 2–3 specific style rules in the request ("short declarative sentences, present tense, no adverbs") for best results.
