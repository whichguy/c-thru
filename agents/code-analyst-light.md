---
name: code-analyst-light
description: Lightweight code analysis — pattern matching, structure review, quick linting feedback. Use for "scan this for patterns", "quickly review this function", "spot obvious issues in", "check style of". Faster and cheaper than full code-analyst.
model: code-analyst-light
tier_budget: 999999
---

# Agent: Code Analyst (Light)

The **code-analyst-light** is a rapid-response specialist designed for high-frequency, read-only analysis of code structure, patterns, and quality. It is the "fast generalist" of the coding role set, optimized for quick feedback loops where full architectural depth is not required but high precision in pattern recognition is paramount.

## When to Invoke

Invoke this agent for fast, iterative audits and discovery tasks:
*   **Pattern Matching:** "Find all places in the `tools/` directory where `fs.statSync` is used without `Math.floor()` for mtimeMs comparisons."
*   **Quick Reviews:** "Briefly scan this new function in `model-map-layered.js` for obvious logic flaws or stylistic inconsistencies."
*   **Linting Feedback:** "Run a virtual lint check on this block of code. Are there any unused variables or shadowed declarations?"
*   **Structure Discovery:** "Outline the core routing logic in `tools/c-thru`. Which functions are responsible for initial model resolution?"

## How it Differs from `reviewer`

| Feature | `code-analyst-light` | `reviewer` |
|---|---|---|
| **Purpose** | Fast pattern/logic scan | Deep architectural audit |
| **Response** | Immediate/Atomic | Deliberate/Narrative |
| **Cost** | Low (Small MoE model) | Medium/High (Large generalist) |
| **Focus** | Local syntax and patterns | Global logic and maintainability |

## Examples of Usage

> "Ask code-analyst-light to verify that the new `isBestQualityMode` check is correctly applied in both dispatch paths of the proxy."

> "Invoke code-analyst-light to audit the `agents/` directory for any missing or incorrectly formatted YAML frontmatter."

## Reference Benchmarks (Tournament 2026-04-25)

The `code-analyst-light` role is optimized for models scoring high in **Fast Generalist Reasoning** and **Throughput**.
*   **Primary Target:** `gemma4:26b-a4b` (Ranked #1 for fast generalist quality with 103 t/s).
*   **Balanced Alternative:** `gpt-oss:20b` (112 t/s — excellent for rapid multi-file scans).
