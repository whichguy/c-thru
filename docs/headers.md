# `x-c-thru-*` response header reference

The proxy stamps a family of `x-c-thru-*` response headers on every
non-trivial request to surface routing decisions, translation gaps,
and observability data that has no native Anthropic equivalent. This
page is the single source of truth — references inline in
`tools/claude-proxy` should point here.

Headers are emitted on both streaming (SSE `writeHead`) and
non-streaming responses unless explicitly noted as one or the other.
Streaming headers must be set before the first `writeHead` call —
see the per-header notes for headers that cannot be backfilled
mid-stream.

## Observability

| Header | Set when | Value | Streaming? |
|---|---|---|---|
| `x-c-thru-dashboard` | Always (every response, once the listener is up) | Discovery URL of the live stats dashboard, e.g. `http://127.0.0.1:10017/c-thru/dashboard`. Stamped via `res.setHeader` at the top of the request handler — covers control endpoints, proxied Messages calls, and streaming alike. | Yes |
| `x-c-thru-backend-latency-ms` | Always (when request reaches upstream) | Round-trip time from proxy→backend in milliseconds (integer string) | Yes |
| `x-c-thru-auth-missing` | `auth_env` (explicit or derived from the host table) is configured on the endpoint but the referenced env var is unset at request time | `1` | Yes |
| `x-c-thru-auth-derived` | Always (when a request reaches `applyOutboundAuth`) | Profile chosen for outbound auth: `bearer_priority` \| `header_env` \| `passthrough` \| `none` \| `subscription` \| `explicit_object`. Lets you debug "why is my key not being sent?" without reading code. See `docs/subscription-auth.md`. | Yes |
| `x-c-thru-tier-detected` | Always | Hardware tier computed from raw `os.totalmem()` — ignores `CLAUDE_LLM_PROFILE` / `CLAUDE_LLM_MEMORY_GB` overrides (e.g. `64gb`) | Yes |
| `x-c-thru-tier-used` | Always | Effective tier after all overrides — this is what model resolution used (e.g. `16gb` when `CLAUDE_LLM_PROFILE=16gb` is set on a 128 GB machine) | Yes |

`x-c-thru-tier-detected` and `x-c-thru-tier-used` differ when a
`CLAUDE_LLM_PROFILE` override is active. Comparing the two headers is
the fastest way to determine whether a routing decision was driven by
the actual hardware or an explicit override.

## Routing & resolution

| Header | Set when | Value | Streaming? |
|---|---|---|---|
| `x-c-thru-served-by` | Always (when route resolves) | Concrete model name the proxy forwarded to (after alias / capability / sigil resolution) | Yes |
| `x-c-thru-agent-identity` | Every routed Messages request | How agent identity was obtained: `sentinel` (signed prompt marker), `header` (signed c-thru agent headers), or `none` | Yes |
| `x-c-thru-resolution-chain` | Route resolved through ≥1 hop | ` -> `-joined chain like `req:claude-sonnet-5 -> route(claude-sonnet-5->anthropic)` | Yes |
| `x-c-thru-resolved-via` | Capability-driven request (e.g. agent uses `model: planner`) | JSON with `capability`, `served_by`, `tier`, `mode`, `latency_ms`, and `local_terminal_appended`; trusted agent requests also include `agent` | Yes |
| `x-c-thru-fallback-from` | Primary route failed and fallback chain matched | Backend ID that failed before the successful fallback dispatch | Yes |
| `x-c-thru-deprecated-model` | Resolved model is in built-in deprecation list or `deprecated_models` config | Migration advice string (e.g. `use gemini-pro-latest (gemini-1.5-* deprecated 2025-09)`) | Yes |
| `x-c-thru-count-tokens` | `/v1/messages/count_tokens` short-circuited by proxy (Ollama backends) | `estimate` — proxy-side heuristic, not an exact count | No |

## Cache & deduplication

| Header | Set when | Value | Streaming? |
|---|---|---|---|
| `x-c-thru-cache-status` | Gemini context-cache attempt (G4) returned a non-`none` status | `hit` \| `miss` (never `none` — that's silently elided) | Yes |
| `x-c-thru-user-id` | Anthropic `metadata.user_id` was on the request | Verbatim user_id string (Gemini has no native equivalent) | Yes |

## Translation gaps & feature loss

| Header | Set when | Value | Streaming? |
|---|---|---|---|
| `x-c-thru-schema-scrubbed` | Tool-use schemas had Gemini-incompatible constructs stripped | Comma-list of dropped fields: `oneOf,allOf,$ref,additionalProperties` | Yes |
| `x-c-thru-redacted-thinking-dropped` | Anthropic `redacted_thinking` block was in request history | `1` (Gemini cannot decrypt the opaque blob, so it's dropped silently otherwise) | Yes |
| `x-c-thru-translation-gap` | `mapAnthropicToGemini` encountered any content-block type it cannot represent (`redacted_thinking`, `server_tool_use`, `web_search_tool_result`, `web_fetch_tool_result`, `code_execution_tool_result`, `tool_search_tool_result`, `mcp_tool_use`, `mcp_tool_result`, `container_upload`, …), an inbound `text` block carried `citations` (`text.citations`), or `body.tools[i].type` declared an Anthropic server tool other than `"custom"` (`tool:web_search_20250305`, `tool:code_execution_20250522`, …) | Comma-list of dropped block-type names + advisory tags; deduplicated across the request. See `docs/anthropic-api-coverage.md` for the full block × backend matrix. | Yes |
| `x-c-thru-beta-dropped` | Request had `anthropic-beta` header tokens that Gemini can't honor | Comma-list of dropped tokens (`prompt-caching-2024-07-31,computer-use-2024-10-22`) | Yes |
| `x-c-thru-passthrough` | Response was produced by the Anthropic catch-all forwarder (`forwardToAnthropicCatchAll`) — no proxy translation, body piped verbatim from upstream | `1` | Yes |
| `x-c-thru-passthrough-host` | Set alongside `x-c-thru-passthrough` | Hostname of the upstream the request was forwarded to (e.g. `api.anthropic.com`). Lets clients distinguish proxy-translated from catch-all-forwarded responses without log diving. | Yes |

## Thinking observability (Gemini ↔ Anthropic)

| Header | Set when | Value | Streaming? |
|---|---|---|---|
| `x-c-thru-thinking-auto-enabled` | Proxy auto-enabled thinking on Gemini 3 Pro family | `1`. Suppressed on `/v1/messages/count_tokens` (no model invocation) | Yes |
| `x-c-thru-thinking-level` | Gemini 3+ used `thinkingLevel`, including mapped Anthropic `output_config.effort` | `minimal` \| `low` \| `medium` \| `high`. Per-model variance is coerced to a supported level: legacy Gemini 3 Pro lacks `medium`; Gemini 3.1 Flash-Lite Image accepts only `minimal`/`high`. Inexact mappings set `x-c-thru-translation-gap`. | Yes |
| `x-c-thru-thinking-tokens` | Upstream returned `usageMetadata.thoughtsTokenCount` | `<N>`. **Non-streaming only** — headers can't be set after SSE `writeHead`. Streaming surfaces this via a custom `c-thru-thinking-tokens` SSE event (see below). | No |

`output_tokens` includes thinking tokens (Anthropic parity):
`candidatesTokenCount + thoughtsTokenCount`. Streaming and non-streaming
both follow this convention. `max_tokens` remains the caller's hard total-output
ceiling; c-thru does not raise `maxOutputTokens` to make room for thinking.

### Streaming-only: `c-thru-thinking-tokens` SSE event

When `thoughtsTokenCount > 0` on a streaming response, the proxy emits
a custom event before `message_delta`:

```
event: c-thru-thinking-tokens
data: {"type":"c-thru-thinking-tokens","thinking_tokens":33}
```

Strict Anthropic clients ignore unknown event types per the SSE spec,
so this is safe to emit unconditionally. Anthropic's `message_delta.usage`
stays spec-compliant (`output_tokens` only). Callers that want the
breakdown read the custom event; everyone else sees normal Anthropic SSE.

## Standard Anthropic headers

| Header | Set when | Value |
|---|---|---|
| `request-id` | Always | Upstream `request-id` if present and matches `^req_[a-f0-9]+$`, otherwise generated `req_<hex16>` (Anthropic guarantees one on every response for client log correlation — G10) |

## Trigger expressions in code

The headers are stamped from three implementation surfaces:

1. **`buildCthruResponseHeaders`** — shared by **Gemini and OpenAI/xAI** success paths. Reads non-enumerable `_*` stashes on the body (e.g. `_thinkingAutoEnabled`, `_cacheStatus` for Gemini; OpenAI passes the mapped body) plus `requestMeta` for resolution-derived routing headers (`served-by`, `resolved-via`, `resolution-chain`, `fallback-from`). Streaming and non-streaming both call this before `writeHead`.
2. **Forwarding functions** (`forwardAnthropic`, Ollama stream/non-stream) — stamp the same routing headers inline when forming upstream response headers (Anthropic does not go through `buildCthruResponseHeaders`).
3. **Request handler `res.setHeader` calls** — `x-c-thru-dashboard` is set before routing, and `x-c-thru-agent-identity` is set after the trust/routing decision but before provider dispatch. `setHeader` values merge with later `writeHead` header objects.

When adding a new header:
- Pick the function/site that owns the data (don't duplicate logic).
- Stash translation-derived data on `geminiBody` via
  `Object.defineProperty(..., {enumerable:false, configurable:true})` so
  it doesn't leak into JSON.stringify output. Resolution-derived data
  goes on `requestMeta`.
- For streaming, set the header before the first `writeHead`. If the
  data only arrives mid-stream (like `thoughtsTokenCount`), surface it
  via the SSE event stream instead — headers cannot be backfilled.
- Update this page in the same commit.

## Endpoint config: `call_style`

`call_style` controls which forwarding function handles a request for a given endpoint.
It is independent of `format` (which describes the wire protocol the endpoint speaks).
When absent, `call_style` is inferred from `format`.

| `call_style` | Forwarding function | Description |
|---|---|---|
| `anthropic` (default) | `forwardAnthropic` | Verbatim passthrough — body forwarded as-is, headers rewritten |
| `gemini` | `dispatchGeminiBackend` | Full Anthropic→Gemini translation: URL construction, body mapping, streaming state machine, context caching, thinking blocks |
| `openai` | `dispatchOpenAIBackend` → `forwardOpenAI` | Anthropic Messages→OpenAI Responses translation, including streaming and tool-use conversion |

**Why separate from `format`?**
`format` is used for wire-level concerns (auth header selection: `x-goog-api-key` vs `Authorization`).
`call_style` is used for translation-layer routing. Decoupling them allows:
- Selecting the implemented OpenAI Responses translator independently of auth/wire-format metadata
- Overriding translation independently of auth/wire format (e.g. passthrough to a Gemini-URL endpoint)

**Supported translation styles today:** `anthropic` (passthrough), `gemini`, and `openai`
(Anthropic Messages→OpenAI Responses translation).

**Backward compatibility:** `format:"gemini"` infers `call_style:"gemini"`, `format:"anthropic"`
infers `call_style:"anthropic"`, and `format:"openai"` infers `call_style:"openai"`.

## See also

- `docs/gemini-gap-roadmap.md` — gap inventory; each `Gx` entry that
  ships a new header documents it here.
- `CLAUDE.md` — top-level summary (links here for the full reference).
- `docs/journaling.md` — how `journal/<capability>.jsonl` records
  capture these headers per request.
