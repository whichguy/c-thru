---
name: long-context
description: Use for large-document retrieval and needle-in-haystack over 50K+ token spans — "find X in this large file", "summarize this 200-page doc", "search through all of these files". The oversized context window is the differentiator — prefer generalist for ordinary-length reasoning. Routes to claude-sonnet-5 connected / qwen3.6:35b local.
model: long-context
tier_budget: 999999
color: cyan
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

Routes to `long-context` capability. Connected: `claude-sonnet-5`. Offline: `qwen3.6:35b` (256K context window — the primary reason to use over generalist). Context window size matters more than model tier; use when the task exceeds the 65K default window.