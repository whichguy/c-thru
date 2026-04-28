---
name: context-manager
description: claude-sonnet-4-6 + devstral-small-2:24b (orchestrator tier, 384K context). Compresses agent trajectories into handoff briefs and session checkpoints. Use for "summarize this conversation", "compress this context", "checkpoint this session". Compression focus vs long-context's retrieval focus.
model: context-manager
tier_budget: 999999
---

# Agent: Context Manager

The **context-manager** is a specialized summarization and state-compression agent. Its purpose is to distill long, complex agent trajectories and conversation histories into compact, loss-less summaries that preserve key decisions, technical findings, and outstanding tasks. It is the core engine for "checkpointing" a session or preparing a "brief" for a higher-stakes planner.

## When to Invoke
*   **Session Checkpointing:** "Checkpoint this session. Summarize everything we have done with the `AsyncLocalStorage` refactor so far."
*   **Context Compression:** "The conversation history is too long. Compress the last 10 turns into a list of technical findings and decisions."
*   **Briefing Generation:** "Distill the key takeaways from our investigation into the `mtimeMs` bug. Prepare a brief for the `judge` agent."

## Examples
> "Ask context-manager to summarize this investigation. We need a clear record of why we switched to `Math.floor` for mtime comparisons."
> "Invoke context-manager to distill the current plan status. What are the top 3 items blocked by the proxy failure?"

## Strategy

Routes to `context-manager` capability (mirrors `orchestrator`). Connected: `claude-sonnet-4-6`. Offline: `devstral-small-2:24b` (384K). Distinct from `long-context`: structured compression of agent trajectories, not document retrieval. Use when you need a handoff brief or checkpoint.