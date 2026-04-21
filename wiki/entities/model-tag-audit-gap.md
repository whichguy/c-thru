---
name: Model-Tag Audit Gap
type: entity
description: "Config model-map tags referencing Ollama models not installed locally — proxy falls back or fails silently unless tags match pulled models (model-tag vs installed-model gap)"
tags: [model-map, ollama, config, audit, fallback]
confidence: high
last_verified: 2026-04-21
last_updated: 2026-04-21
created: 2026-04-21
sources: [64f2589b, 408250c4, ca03c216]
related: [capability-profile-model-layers, fallback-event-system]
---

# Model-Tag Audit Gap

Several model tags in `config/model-map.json` referenced Ollama models that were not pulled/installed locally, meaning the proxy would either fall back via the equivalents chain or fail. The gap was discovered by comparing `ollama list` output against config tags.

- **From Session 64f2589b:** Audit of installed vs config model tags revealed 6 missing: `devstral-small:2` (not a real Ollama tag — Mistral's "Devstral Small" is `devstral:24b`), `qwen3.5:1.7b` (superseded by `qwen3:1.7b`), `qwen3.5:27b` and `qwen3.5:122b` (not pulled; replaced by `qwen3.6:35b`), `deepseek-r1:14b` (not pulled; replaced by `gpt-oss:20b`), `gemma4:26b-a4b` (not pulled; replaced by `gemma4:26b-mxfp8`). All six were replaced with actually-installed alternatives in a comprehensive config rewrite.
- **From Session 64f2589b:** The `devstral-small:2` tag is particularly misleading — Mistral's internal naming ("Devstral Small" = 24B model) doesn't match any Ollama tag. The actual tag is `devstral:24b` or `devstral:latest`. This was replaced with `qwen3.5:35b-a3b-coding-nvfp4` for the coder role (installed, 21GB, code-specialized MoE with 3B active params).
- **From Session 64f2589b:** Lesson: any model-map change should be validated against `ollama list` output. The proxy's fallback chain can mask missing models, making silent degradation hard to detect. A CI or startup check comparing config tags against pulled models would catch this.
- **From Session 408250c4:** Config replacements from the audit committed to `config/model-map.json`: `qwen3.5:1.7b` → `qwen3:1.7b` across all tiers, `deepseek-r1:14b` → `gpt-oss:20b` for reviewer roles, `devstral-small:2` → `gpt-oss:20b` for code-analyst/deep-coder, `gemma4:e4b` → `gpt-oss:20b` for 48gb reviewer, `qwen3.5:27b`/`qwen3.5:122b` → `qwen3.6:35b` for disconnect slots, `gemma4:26b-a4b` → `gemma4:26b-mxfp8` for 64gb/128gb workhorse/classifier. Test file updated: `llm-mode-resolution-matrix.test.js` now asserts `qwen3.6:35b` in equivalents instead of `qwen3.5:27b`/`qwen3.5:122b`.

→ See also: [[capability-profile-model-layers]], [[fallback-event-system]], [[model-map-test-pattern]], [[qwen-series-selection]], [[llm-mode-resolution]], [[ollama-endpoint-divergence]], [[local-model-prompt-research]]