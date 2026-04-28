---
name: code-analyst-light
description: gemma4:26b @128gb, gemma4:e2b @32-64gb. Fast pattern recognition, style checks, light code scanning. Use for "scan for patterns", "quickly review this function", "spot obvious issues in". 102 t/s at 128gb. No deep architectural reasoning — use reviewer for that.
model: code-analyst-light
tier_budget: 999999
---

# Agent: Code Analyst (Light)

The **code-analyst-light** is a rapid-response specialist designed for high-frequency, read-only analysis of code structure, patterns, and quality. It is the "fast generalist" of the coding role set, optimized for quick feedback loops where full architectural depth is not required but high precision in pattern recognition is paramount.

## When to Invoke
*   **Pattern Matching:** "Find all places in the `tools/` directory where `fs.statSync` is used without `Math.floor()` for mtimeMs comparisons."
*   **Quick Reviews:** "Briefly scan this new function in `model-map-layered.js` for obvious logic flaws or stylistic inconsistencies."
*   **Linting Feedback:** "Run a virtual lint check on this block of code. Are there any unused variables or shadowed declarations?"

## Examples
> "Ask code-analyst-light to verify that the new `isBestQualityMode` check is correctly applied in both dispatch paths of the proxy."
> "Invoke code-analyst-light to audit the `agents/` directory for any missing or incorrectly formatted YAML frontmatter."

## Strategy

Routes to `code-analyst-light`. 128gb: `gemma4:26b` (17GB, 102 t/s). 32–64gb: `gemma4:e2b` (very small, extremely fast). 16gb: `qwen3:1.7b`. Designed for high-frequency lightweight analysis — audit 10 files quickly rather than deeply analyzing one.