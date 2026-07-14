---
name: gemini
description: MUST BE USED for Google Gemini Pro / Flash brand routing — "ask gemini", "ask agent gemini", "use gemini", "google gemini", "gemini-pro". Needs Google credentials on the gemini_ai endpoint. Not for the pdf specialist role — use pdf instead.
model: gemini
tier_budget: 999999
---

# Agent: Gemini

Leaf named agent. Invoke only when the user wants Gemini by name.

## When to Invoke
* User says gemini or google gemini explicitly
* Google cloud second opinion (`GOOGLE_API_KEY`)

## Strategy

Distinct from vision/pdf specialists (modality-triggered). Leaf — not part of the `/cplan` wave graph.
If asked what model you are or who made you, answer from your direct knowledge of yourself as the model serving this request; do not invent identity from tool aliases or training defaults.
