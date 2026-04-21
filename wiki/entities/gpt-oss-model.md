---
name: gpt-oss Model
type: entity
description: "OpenAI's first open-weight model (Apache 2.0) — 21B total / 3.6B active MoE, o3-mini class reasoning, ideal for reviewer/orchestrator/deep-coder slots (MoE speed-capability dual advantage)"
tags: [model-map, ollama, gpt-oss, reviewer, orchestrator]
confidence: high
last_verified: 2026-04-21
last_updated: 2026-04-21
created: 2026-04-21
sources: [64f2589b, ca03c216]
related: [capability-profile-model-layers, model-tag-audit-gap, moe-speed-capability-dual]
---

# gpt-oss Model

OpenAI's first open-weight model (`gpt-oss:20b` on Ollama). Apache 2.0 license, 21B total params / 3.6B active MoE, MXFP4 quant, 13GB on disk, 128K context. Benchmarks at o3-mini level — matches deepseek-r1:14b on MMLU-Pro (85%), strong chain-of-thought reasoning, native tool use. Was installed but unused in the model-map before this session.

- **From Session 64f2589b:** Discovered via `ollama list` that `gpt-oss:20b` (13GB) was installed but not referenced anywhere in `config/model-map.json`. Research confirmed it benchmarks at o3-mini level with transparent chain-of-thought — ideal for reasoning-heavy agentic roles. Added to model-map as: `reviewer` on 32gb/48gb/128gb (replacing uninstalled `deepseek-r1:14b`), `deep-coder` on 32gb/48gb/64gb (replacing `devstral-small:2`), and `orchestrator` on 48gb (replacing `qwen3.5:9b` — too lightweight for debugging orchestration).
- **From Session 64f2589b:** Key advantage: 3.6B active params gives small-model inference speed while the 21B total params provide large-model knowledge. This MoE architecture makes it suitable for both speed-first and capability-first roles, unlike dense models where speed and capability trade off directly.
- **From Session ca03c216:** gpt-oss uses OpenAI's proprietary **Harmony** format (not ChatML) with three output channels: `analysis` (raw CoT, private), `commentary` (tool call narration), `final` (user-facing answer). Ollama's default chat template implements Harmony automatically, but downstream parsers expecting plain ChatML are caught off-guard by the `reasoning_content` field alongside `content`. **Security critical:** the `analysis` channel has NOT been trained to the same safety standards as `final` — OpenAI's Harmony Cookbook explicitly warns never to expose it to end users.
- **From Session ca03c216:** Reasoning cannot be fully disabled — only effort level can be tuned (`low`/`medium`/high`). `Reasoning: high` causes random reasoning loops in agentic tool-use scenarios (issue #12606); default to `medium`, never use `high` with tool calls. The `reasoning_effort` API parameter is unreliable — community reports the model ignoring it after updates (issue #12589). System prompt method (`Reasoning: low`) is more reliable in practice than the API parameter.
- **From Session ca03c216:** Ollama strips `reasoning_content` between turns — only `content` is retained in history. For tool chaining, OpenAI's Cookbook says to preserve analysis messages, but Ollama doesn't support the Responses API natively. Tool calls require `response_format: { type: 'text' }` (never `json_object`). Typo-sensitive: prompts with typos trigger repetitive generation loops sharing a root cause with the `Reasoning: high` bug (#12741 closed as dup of #12606).

→ See also: [[capability-profile-model-layers]], [[model-tag-audit-gap]], [[moe-speed-capability-dual]], [[qwen-series-selection]], [[local-model-prompt-techniques]]