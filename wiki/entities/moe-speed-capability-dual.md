---
name: MoE Speed-Capability Dual Advantage
type: entity
description: "MoE models (gpt-oss:20b, qwen3.6:35b, qwen3.5:35b-a3b) provide both fast inference and high capability — 3-4B active params means small-model speed with large-model knowledge, eliminating the traditional speed-vs-quality tradeoff"
tags: [model-map, architecture, moe, performance, design-decision]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
sources: [64f2589b]
related: [capability-profile-model-layers, gpt-oss-model]
---

# MoE Speed-Capability Dual Advantage

Design principle for c-thru role assignments: MoE (Mixture-of-Experts) models blur the traditional speed-vs-capability tradeoff because they have large total parameter counts but small active parameter counts during inference. A model like `gpt-oss:20b` (3.6B active / 21B total) or `qwen3.6:35b` (3B active / 35B total) delivers near-small-model latency with near-large-model knowledge.

- **From Session 64f2589b:** The role-tier analysis revealed two categories: speed-first roles (classifier, explorer, commit-message-generator, pattern-coder) that run on every prompt, and capability-first roles (reviewer, orchestrator, deep-coder, judge) where quality matters more than latency. The insight: MoE models satisfy both constraints simultaneously, making them ideal for capability-first roles on memory-constrained tiers. This drove the decision to assign `gpt-oss:20b` (3.6B active) to 48gb orchestrator over `qwen3.5:9b` (9B dense) — same speed class, significantly stronger reasoning.
- **From Session 64f2589b:** Dense models like `qwen3.5:9b` and `gemma4:26b` occupy the traditional tradeoff: either fast but limited (9B dense) or capable but slow (26B dense). MoE models with 3-4B active params sit in a sweet spot: the proxy can assign them to capability-first roles on 32gb-48gb tiers without paying the latency penalty of a 26B dense model, while still getting better reasoning quality than a 9B dense model. This particularly matters for the `orchestrator` role, which needs debugging capability (chain-of-thought, tool use, hypothesis tracing) at inference speed.

The MoE speed advantage is directly encoded in `speed_score` values in `fallback_chains`: `gpt-oss:20b` (speed=90) and `qwen3.5:35b-a3b-coding-nvfp4` (speed=85) sit above `qwen3.6:35b` (speed=60) and dense 26B models (speed=55) despite having comparable or higher quality scores. The quality-tolerance tiebreaker in `cloud-best-quality`/`local-best-quality` modes exploits this: within the quality band, the MoE candidate is preferred for its inference speed. See [[best-quality-modes]] for tiebreaker algorithm.

→ See also: [[capability-profile-model-layers]], [[gpt-oss-model]], [[qwen-series-selection]], [[best-quality-modes]]