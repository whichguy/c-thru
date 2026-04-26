---
name: fast-generalist
description: Latency-optimized generalist — Q&A, triage, quick answers at speed. Use when you need a fast response: "quick: what is", "tl;dr of", "one-line answer", "fast check on". Trades depth for speed.
model: fast-generalist
tier_budget: 999999
---

# Agent: Fast Generalist

The **fast-generalist** is a high-speed all-rounder designed for rapid responses, quick triage, and low-latency Q&A. It is the "real-time" choice for the generalist role set, optimized for immediate delivery of one-line answers, summaries, and fast checks where deep architectural reasoning is not the primary requirement.

## When to Invoke

Invoke this agent when you need a fast, concise response:
*   **Quick Fact Checks:** "Quick: what is the default port for the `claude-proxy` hooks listener?"
*   **TL;DR Summarization:** "tl;dr of the recent changes in `tools/c-thru`. What was the most impactful fix?"
*   **One-Line Answers:** "Provide a one-line command to verify the syntax of all `.js` files in the current directory."
*   **Rapid Triage:** "Fast check on the `proxy.log`. Are there any new `config.reloaded` events in the last 60 seconds?"

## How it Differs from `generalist`

| Feature | `generalist` | `fast-generalist` |
|---|---|---|
| **Priority** | Depth and Nuance | Speed and Latency |
| **Response** | Deliberate/Exploratory | Immediate/Atomic |
| **Cost** | Medium (35B+ model) | Low (Small MoE model) |
| **Speed** | Moderate (60 t/s) | High (100+ t/s) |

## Examples of Usage

> "Ask fast-generalist for a quick summary of the `C_THRU_STRICT_MODELS` environment variable's effect."

> "Invoke fast-generalist to get the current date and time for the session log."

## Reference Benchmarks (Tournament 2026-04-25)

The `fast-generalist` role is optimized for models scoring high in **Throughput** and **Latency (TTFT)**.
*   **Primary Target:** `gemma4:26b-a4b` (Ranked #1 for fast generalist quality with 103 t/s).
*   **Speed specialist:** `gpt-oss:20b` (112 t/s — best for sub-second responses on simple prompts).
