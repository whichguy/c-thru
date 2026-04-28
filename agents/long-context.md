---
name: long-context
description: claude-sonnet-4-6 + devstral-small-2:24b (384K context). Large document retrieval, needle-in-haystack, 50K+ token spans. Use for "find X in this large file", "summarize this 200-page doc", "search through all of these files". The 384K window is the differentiator over generalist.
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

Routes to `long-context` capability (mirrors `orchestrator`). Connected: `claude-sonnet-4-6`. Offline: `devstral-small-2:24b` (384K context window — the primary reason to use over generalist). Context window size matters more than model tier; use when the task exceeds the 65K default window.