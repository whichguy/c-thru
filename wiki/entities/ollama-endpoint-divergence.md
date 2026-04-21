---
name: Ollama Endpoint Divergence
type: entity
description: "Behavioral differences between Ollama /api/chat, /api/generate, and /v1/chat/completions — thinking, format, streaming, tool calls all behave differently per endpoint (proxy routing concern)"
tags: [ollama, proxy, api, endpoint, thinking, format]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
sources: [ca03c216]
related: [ollama-http-api-migration, declared-rewrites, gpt-oss-model, qwen-series-selection]
---

# Ollama Endpoint Divergence

Ollama's three API endpoints are NOT interchangeable — thinking mode, format constraints, streaming behavior, and tool calls all differ per endpoint and per model family. The proxy must route to the correct endpoint per model to avoid silent failures.

- **From Session ca03c216:** `think: false` works as a top-level key on `/api/chat` but is **silently ignored** on `/api/generate` for all thinking-capable Qwen models (issue #14793). With `/api/generate` + thinking enabled + small `num_predict`, thinking tokens consume the entire budget and `response` is empty with no error. For Gemma4, the behavior is reversed: thinking is **disabled by default** on `/api/generate` (issue #15268, open as of Ollama 0.20.0) — opposite of Qwen. The proxy must use `/api/chat` for all thinking-mode control.
- **From Session ca03c216:** `/v1/chat/completions` (OpenAI-compat) puts all model output in the `reasoning` field with empty `content` for Gemma4 and gpt-oss when streaming. The `think` parameter is only supported on native `/api/chat`. Any client using the OAI-compat path (LangChain, OpenAI SDK) receives empty content. The proxy must route to `/api/chat` for these model families.
- **From Session ca03c216:** `format=` (grammar-constrained JSON) conflicts with `think: false` on Gemma4 (issue #15260): setting both silently drops the format constraint. For Qwen, structured output + `think: false` has different interaction — `format=` works with `temperature: 0` but not with thinking active (issue #10929: duplicated opening brace in JSON). The proxy must never combine `think: false` with `format=` for Gemma4.
- **From Session ca03c216:** Tool calls are stripped from conversation history on `/api/chat` for Qwen3 models — the tool call content is removed before template rendering on subsequent turns, leaving only `<|im_start|>assistant<|im_end|>`. This corrupts multi-turn tool-use conversations. Workaround: embed tools in the Modelfile `SYSTEM` block rather than the API `tools` field (issue #14601). The proxy's tool-call handling must account for this stripping.
- **From Session ca03c216:** For gpt-oss, tool calls require `response_format: { type: 'text' }` — never `json_object`, which causes empty content responses. The `reasoning_effort` parameter must be passed as a string (`"low"`, `"medium"`, `"high"`), not a boolean — boolean values cause a Go parser type-mismatch error (issue #12004).

→ See also: [[ollama-http-api-migration]], [[declared-rewrites]], [[gpt-oss-model]], [[qwen-series-selection]], [[best-quality-modes]]