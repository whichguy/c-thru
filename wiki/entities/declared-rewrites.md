---
name: Declared-Rewrites Principle
type: entity
description: "Architectural rule: c-thru only transforms a declared list of request/response fields; everything else passes byte-for-byte (transparent proxy, no policy)"
tags: [architecture, transparency, proxy, rfc9110]
confidence: high
last_verified: 2026-04-21
created: 2026-04-18
last_updated: 2026-04-21
sources: [be297e50, ed761c3c, 386b8e16, 9d601210]
related: [load-bearing-invariant, release-roadmap, kind-anthropic-invariant, narrow-threat-model, capability-profile-model-layers, config-swap-invariant]
---

# Declared-Rewrites Principle

c-thru is a non-transparent/transforming HTTP proxy per RFC 9110 §3.7. It operates at the JS object level (`req.headers`, `upRes.pipe(res)`), not the packet level — Node handles chunked encoding, TE/CL disambiguation, and hop-by-hop headers. The proxy commits to an exhaustive list of permitted transforms; anything not on the list passes through unchanged. No validation, no allowlists, no sanitization. If the user installed c-thru, they own the config; c-thru trusts the config. Over-protection is a regression.

- **From Session be297e50:** The declared rewrites are: (1) request body `model` field → resolved backend model, (2) request URL + `Host` → route-selected backend URL, (3) request `Authorization` header → route-configured credential, (4) SSE `usage` injection when upstream omits it, (5) protocol translation — N/A today (gated on `kind: "openai"` backend). This principle explicitly caused A2 (header allowlist) and A5 (env-name validation) to be DROPPED — both would have been policy, not correctness.
- **From Session be297e50:** Node handles Transfer-Encoding chunked decode/encode, CL vs TE:chunked disambiguation, hop-by-hop headers on the request path (built from scratch so they never leak), and HTTP/1.1 keep-alive framing. What c-thru must handle: stream lifecycle (pipe cleanup, bounded buffers, error propagation), body-field transforms, request construction (auth), and logical header passthrough on the response path. Response-path `Keep-Alive`, `Upgrade`, `Proxy-Authenticate` can leak via spread — cosmetic cleanup (A15), low priority.

- **From Session ed761c3c:** The model-router plugin (`claude-craft/plugins/model-router/handlers/model-router.sh`) was the only hook that independently rewrote `tool_input.model` — it's unregistered dead code. This confirms the declared-rewrites single-writer contract in practice: no external component should replicate the proxy's `body.model` transform. See [[hook-model-rewriting-removal]].
- **From Session 386b8e16:** The proxy-only rule is now codified in `CLAUDE.md` under "Model rewriting: proxy-only" — hooks may observe or gate but must not touch `tool_input.model` or `body.model`. The model-router plugin was deleted from claude-craft and its live symlink at `~/.claude/plugins/model-router` was removed (it was actually firing on every call, not dead as initially assessed).
- **From Session 9d601210:** v1.2 adds a declared response-header rewrite: `x-c-thru-resolved-via` carrying `{capability, profile, served_by}` JSON. This header must be baked into `respHeaders` before `res.writeHead()` — late `res.setHeader()` is a no-op on streaming SSE paths after headers flush. A helper `addResolvedViaHeader(respHeaders, resolved)` consolidates the five write sites to avoid drift.

- **From Session feat/llm-mode-multi-provider (2026-04-20):** `@<backend>` sigil is the eighth declared rewrite (proxy-only, no hook involvement): when the terminal model matches `/^(.+)@([A-Za-z0-9_-]+)$/` and the suffix names a declared backend, `resolveBackend` binds directly to that backend and strips the suffix before forwarding upstream. The base model name (without `@suffix`) is what the provider sees. Validator rejects sigils that reference undeclared backends. Hook layer must not intercept or rewrite sigil'd model names — they are routing metadata, not provider model identifiers.

- **From Session 48948541:** `model_overrides` is the sixth declared rewrite (seventh if counting `x-c-thru-resolved-via` as a separate entry): a flat `{"concrete-model": "replacement"}` map in `config/model-map.json` applied unconditionally at the top of `resolveRouteModel`, before the routes graph traversal. Covers primary requests and fallback candidates (because `resolveFallbackModel` calls `resolveRouteModel`). No cycle guard needed here — override applies once; the downstream routes traversal carries its own cycle detection. Emits `proxy.model_overrides.remap` debug event with `{from, to}` fields. Self-loops (`"A": "A"`) are rejected by the validator. Absent or empty key is valid.

- **From Session feat/best-quality-modes (2026-04-21):** `x-c-thru-resolved-via` gains two new keys — `mode` (the active `llm_mode` string at call time) and `local_terminal_appended` (boolean, `true` when the proxy appended a local-terminal model to the fallback chain). Full schema: `{capability, profile, served_by, tier, mode, local_terminal_appended}`. All keys always present on capability responses; `local_terminal_appended` is `false` when the local-terminal guard did not fire.

- **From Session c6237d83:** The `x-c-thru-resolved-via` header gained two new keys: `mode` (active `llm_mode` at request time) and `local_terminal_appended` (boolean, true when proxy appended a local-terminal model to the chain). Full schema: `{capability, profile, served_by, tier, mode, local_terminal_appended}`. All keys always present on capability responses; `local_terminal_appended` is `false` when the local-terminal guard did not fire. This extension is the ninth declared rewrite.

→ See also: [[load-bearing-invariant]], [[release-roadmap]], [[kind-anthropic-invariant]], [[narrow-threat-model]], [[hook-model-rewriting-removal]], [[capability-profile-model-layers]], [[best-quality-modes]], [[planner-signals-design]], [[fallback-event-system]]