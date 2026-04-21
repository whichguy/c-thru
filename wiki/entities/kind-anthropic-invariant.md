---
name: Kind-Anthropic Invariant
type: entity
description: "Schema rule: all shipped backends use kind: anthropic and speak Anthropic Messages API natively — no protocol translation in c-thru today"
tags: [schema, backends, protocol, anthropic, translation]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-21
sources: [be297e50]
related: [declared-rewrites, release-roadmap]
---

# Kind-Anthropic Invariant

All shipped c-thru backends (Ollama-native-anthropic endpoint, OpenRouter, LiteLLM) are configured with `kind: "anthropic"` and expose the Messages API directly. No OpenAI-to-Anthropic translation happens in c-thru today. Several plan items (A22 trailing usage, A24 tool-use reassembly, parts of C5) are forward-looking — they become live bugs only if a future `kind: "openai"` backend is added.

- **From Session be297e50:** This invariant is why A24 (tool-use `input_json_delta` reassembly) was marked N/A for 1.1 and tracked as a gated item in C5. The protocol-mapping table in C5 should make this explicit: any new backend kind must ship with a declared SSE protocol, golden tests, and an explicit opt-in in C5. Don't add a translation layer without first adding the tests that would catch these footguns.
- **From Session be297e50:** Declared rewrite #5 (protocol translation) is explicitly marked "N/A today" in the declared-rewrites principle. It becomes active only when a non-anthropic backend kind is introduced. The stop_reason mapping (`end_turn`↔`stop`, `tool_use`↔`tool_calls`), tool-use input type preservation (object vs stringified JSON), and usage placement in streaming are the known translation footguns from LiteLLM/Portkey/Helicone.

- **From Session 69bfbcd1:** Spike during test implementation confirmed: the proxy has no Anthropic↔OpenAI translation layer — it does Anthropic-compatible passthrough to Ollama. The `proxy-translation.test.js` was reoriented away from testing a nonexistent translation to testing the actual declared rewrites (model substitution, sigil stripping, auth injection, `x-c-thru-resolved-via` header). This validates the invariant empirically: the only protocol path in production is Anthropic→Anthropic, not Anthropic→OpenAI.

→ See also: [[declared-rewrites]], [[release-roadmap]], [[agent-structural-testing]]