---
name: image-analyst
description: claude-sonnet-4-6 connected (full multimodal vision). Local falls back to workhorse (limited without a dedicated vision model in Ollama). Use for screenshots, diagrams, UI mockups, OCR, chart extraction. Prefer connected mode for reliable visual analysis.
model: image-analyst
tier_budget: 999999
---

# Agent: Image Analyst

The **image-analyst** is a multimodal specialist for visual inputs: screenshots, diagrams, UI mockups, charts, and images. When connected, routes to claude-sonnet which has full vision capability. Offline on local tiers, falls back to the workhorse model — effective for text-heavy images but limited for complex visual layouts.

## When to Invoke
*   **Screenshot Analysis:** "Analyze this screenshot of the terminal output. What error is being shown?"
*   **Diagram Reading:** "Describe the architecture shown in this diagram. What components are connected?"
*   **UI Audit:** "What accessibility issues are visible in this UI mockup?"
*   **Chart Extraction:** "Extract the benchmark data from this bar chart."

## Examples
> "Ask image-analyst to read this network diagram and describe the data flow between the proxy and the backends."
> "Invoke image-analyst to identify what changed between these two screenshots."

## Strategy

Routes to `image-analyst` capability (mirrors `workhorse`). Connected: `claude-sonnet-4-6` — full multimodal vision capability. Offline/local: same workhorse model (qwen3.6:35b-a3b-coding-nvfp4 at 128gb, smaller at lower tiers) — basic image handling only. A future update will add a dedicated vision Ollama tag when available. Until then, prefer this agent with cloud connection for reliable image analysis.
