---
name: Qwen Series Selection
type: entity
description: "Qwen3.5 vs qwen3.6 model series for c-thru role assignments — qwen3.6:35b for agentic coding, qwen3.5:35b-a3b-coding-nvfp4 for coder role, no qwen3.6:27b on Ollama"
tags: [model-map, qwen, ollama, agentic-coding, nvfp4]
confidence: high
last_verified: 2026-04-21
last_updated: 2026-04-22
created: 2026-04-21
sources: [64f2589b, ca03c216, b1731578]
related: [capability-profile-model-layers, model-tag-audit-gap, moe-speed-capability-dual, gpt-oss-model]
---

# Qwen Series Selection

The Qwen model family has two active series on Ollama that serve different c-thru roles: **qwen3.5** (multimodal generalist, many sizes) and **qwen3.6** (agentic coding + reasoning, 35B only on Ollama). The `qwen3.5:35b-a3b-coding-nvfp4` variant is a code-specialized nvfp4-quantized MoE that serves the `coder` role.

- **From Session 64f2589b:** Research comparison: qwen3.5 (0.8B, 2B, 4B, 9B, 27B, 35B, 122B on Ollama) is a multimodal generalist series; qwen3.6:35b is a follow-on purpose-built for agentic coding and repository-level reasoning with 256K context. No `qwen3.6:27b` exists on Ollama — the series only has 35B. Decision: replace `qwen3.5:27b` and `qwen3.5:122b` disconnect slots with `qwen3.6:35b` (installed, better agentic capability, consolidates two tags to one).
- **From Session 64f2589b:** `qwen3.5:35b-a3b-coding-nvfp4` (21GB on disk, 3B active params MoE, nvfp4 quantization) was already installed and unused in config. It's code-specialized unlike base qwen3.5:35b, making it the correct `coder` assignment for 48gb/64gb/128gb tiers — replacing the non-existent `devstral-small:2`. The `a3b` suffix means 3B active parameters; `coding` indicates fine-tuned for code; `nvfp4` is NVIDIA's FP4 quantization format.
- **From Session 64f2589b:** Consolidation principle: fewer distinct Ollama pulls is better for disk and warm-up time. Replacing `qwen3.5:27b` + `qwen3.5:122b` with `qwen3.6:35b` eliminates one pull while improving capability. The 122B model (~70-75GB) was the largest non-judge local model and only ran on 128gb tier — removing it frees significant RAM headroom.
- **From Session ca03c216:** qwen3.6:35b thinking is **ON by default** (the original "no thinking mode" claim was wrong — confirmed by HuggingFace model card). Must send `think: false` as a top-level `/api/chat` field to disable. `PARAMETER think false` in Modelfile returns "unknown parameter" error (issue #14809, no timeline). The same thinking+tools empty-output bug (issue #10976) applies — disable thinking when tools are active.
- **From Session ca03c216:** Qwen3.5 penalty sampling was partially fixed in Ollama v0.17.5 (PR #14537, maintainer `jmorganca`) — repeat-based sampling now works on Go runner. **Must re-pull models after upgrading** — without re-pulling, old model state persists and penalties remain silently ignored. Tool calling format fixed in v0.17.6 (PR #14605) — Qwen3.5 now uses XML/qwen3-coder pipeline, not Hermes JSON. Some tool-calling issues persist (issue #14493).
- **From Session ca03c216:** Qwen3.5 requires a substantial system prompt or enters a reasoning death spiral ("Wait, I'll check if I should use a table..."). Embedding critical instructions in user turns works more reliably than system-prompt-only placement. `/no_think` in user turns is a security issue — mode directives persist across the conversation (state hijack vector).

- **From Session b1731578:** Behavioral test finding: qwen3.6:35b (and other qwen3 thinking models) exhaust small max_tokens budgets (≤2000) entirely in the `<think>` phase, producing zero text output. Fix: (1) raise max_tokens to 4000–6000 for thinking-model agents, and (2) append `/no_think` to the user message to suppress extended thinking for single-turn API calls. `/no_think` is safe in single-turn test harnesses (unlike multi-turn conversations where it's a security/state-hijack risk). Exception: agents that parse inline key-value output (discovery-advisor, planner-local) break when `/no_think` is appended — the suffix disrupts their format parsing; set `noThink: false` per-agent for those.

- **From Session 75859eff:** `/no_think` placement refinement for behavioral tests: prior guidance (b1731578) appended `/no_think` to the user message globally, then set `noThink: false` per-agent for KV-format agents. Preferred approach: prepend `/no_think` to the **system prompt** for Qwen3-routed capability tiers (`pattern-coder`, `orchestrator`, `local-planner`). System-prompt placement is safer — it never corrupts user message format regardless of agent type, eliminating the need for per-agent `noThink` flags. The `noThink: false` flag on individual ROSTER entries can be removed entirely when this approach is used.

→ See also: [[capability-profile-model-layers]], [[model-tag-audit-gap]], [[moe-speed-capability-dual]], [[gpt-oss-model]], [[local-model-prompt-techniques]]