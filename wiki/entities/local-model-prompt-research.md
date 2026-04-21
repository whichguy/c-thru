---
name: Local Model Prompt Research
type: entity
description: "Living research doc (docs/local-model-prompt-techniques.md) + update skill for local model Ollama behavior — prompt patterns, API parameters, failure modes, version-specific fixes, authoritative corrections"
tags: [research, ollama, prompt-techniques, documentation, model-behavior]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
sources: [ca03c216]
related: [ollama-endpoint-divergence, gpt-oss-model, qwen-series-selection, model-tag-audit-gap]
---

# Local Model Prompt Research

`docs/local-model-prompt-techniques.md` is a living research document covering Ollama client-observable behavior for all active local models in `config/model-map.json`. Updated via `/update-model-research` skill. Scope: prompting patterns, request parameters, response format, tool-calling behavior, dangers, and best practices. Internal server mechanics are excluded unless they explain a client-visible API behavior.

- **From Session ca03c216:** Created through a 4-pass research process: (1) initial research from Reddit/HF/GitHub, (2) fact-check with citation verification and dissenting opinions, (3) Ollama-specific behavior layer, (4) authoritative disavowals and corrections from model makers and Ollama maintainers. Each pass corrected claims from the previous pass — the most significant being: qwen3.6:35b thinking mode was ON by default (not absent), penalty sampling was fixed in v0.17.5 (not "silently ignored forever"), and the Gemma4:26b empty-response bug was disputed by an Ollama collaborator who reproduced successfully.
- **From Session ca03c216:** The `/update-model-research` skill (`skills/update-model-research/SKILL.md`) runs 5 phases: Inventory → Parallel Research → Delta Analysis → Update → Change Summary. Key design decisions: (a) strict citation standard — every claim needs a URL; (b) client-actionability filter — findings must be actionable from the API client perspective, not server-operator-only; (c) confidence labels (confirmed, community consensus, disputed, unverified); (d) version-specific fixes must note minimum version and re-pull requirement. Flags: `--model <family>`, `--section <topic>`, `--dry-run`, `--cite-check`.
- **From Session ca03c216:** The "Authoritative Corrections & Disavowals" section in the doc is append-only — new entries are added but existing ones are never rewritten unless a stronger authoritative source supersedes them. This preserves the correction history and prevents circular corrections. The body sections are updated to match (stale version references removed, fixed-in-version tags applied), but the corrections section serves as the immutable audit trail.
- **From Session ca03c216:** Critical finding pattern: many reported "model bugs" are actually Ollama runner bugs. Cross-runtime isolation (same GGUF on llama.cpp-server vs Ollama) proved the Gemma4 JSON failure is Ollama's grammar sampler, not model weights (0/10 failures on llama.cpp vs 60-100% on Ollama). This debugging technique should be applied before attributing any failure to model weights — always test on an alternative runtime first.
- **From Session ca03c216:** Client-actionability scope was established after repeated user corrections: the doc covers only what's observable/actable through the Ollama API (prompting patterns, request `options` parameters, response format, tool-calling behavior). Server deployment config (`OLLAMA_FLASH_ATTENTION`, `OLLAMA_KV_CACHE_TYPE`, `PARAMETER num_gpu`) was stripped. All `PARAMETER` blocks were reframed as `"options": {...}` JSON passable per-request. Filter question: *"Can a developer writing an API client act on this when crafting a prompt or API call?"*
- **From Session ca03c216:** The skill's Phase 5 surfaces model-map parameter default candidates — confident per-model API options (temperature, top_p, mirostat) ready for `config/model-map.json`. This requires a new top-level key in model-map, which means `model-map-edit.js`'s `applyUpdates` whitelist must also be updated (see model-map-edit-key-whitelist).

→ See also: [[ollama-endpoint-divergence]], [[gpt-oss-model]], [[qwen-series-selection]], [[model-tag-audit-gap]], [[ollama-http-api-migration]], [[model-map-edit-key-whitelist]]