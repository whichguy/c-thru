---
name: long-context
description: Processes large documents and long contexts — needle-in-haystack, 50K+ token files, entire codebases. Use for "find X in this large file", "summarize this 200-page doc", "search through all of these files", "analyze this entire codebase for". Optimized for recall over large spans.
model: long-context
tier_budget: 999999
---

# Agent: Long Context Specialist

The **long-context** agent is a retrieval and analysis specialist optimized for processing very large documents and extensive conversation histories (50K+ tokens). It excels at "needle-in-a-haystack" retrieval, global summarization of long spans, and cross-file analysis where the total context size would overwhelm a standard generalist model.

## When to Invoke
*   **Needle Retrieval:** "Find the exact line where the `ROUTER_PROXY_PORT` was first introduced in our 2000-line git history log."
*   **Global Summarization:** "Summarize the major design changes that have occurred in `tools/claude-proxy` over the last 30 waves of the current plan."
*   **Repository-Wide Search:** "Analyze the entire codebase and find every instance where `ANTHROPIC_API_KEY` is referenced, ensuring no leaks exist."

## Examples
> "Ask long-context to find all references to the 'v12-adapter' in our archival journals. When was it deprecated?"
> "Invoke long-context to analyze the `Archive/` directory and find out if any of the old GAS scripts contain hardcoded port numbers."

## Strategy

Optimized for the best-in-class local model for this role.