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
| `x-c-thru-resolution-chain` | Route resolved through ≥1 hop | ` -> `-joined chain like `req:claude-sonnet-4-6 -> route(claude-sonnet-4-6->anthropic)` | Yes |
| `x-c-thru-resolved-via` | Capability-driven request (e.g. agent uses `model: planner`) | JSON: `{"capability":"planner","profile":"planner","served_by":"...","tier":"64gb","mode":"connected","local_terminal_appended":false}` | Yes |
| `x-c-thru-fallback-from` | Primary route failed and fallback chain matched | Original requested model name (e.g. `gemini-pro-latest` when fallback resolved to a local model) | Yes |
| `x-c-thru-deprecated-model` | Resolved model is in built-in deprecation list or `deprecated_models` config | Migration advice string (e.g. `use gemini-pro-latest (gemini-1.5-* deprecated 2025-09)`) | Yes |

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
| `x-c-thru-thinking-level` | Gemini 3+ used `thinkingLevel` enum | `minimal` \| `low` \| `medium` \| `high`. Per-model variance: gemini-3-pro lacks `medium` (falls back to `high`), only flash supports `minimal` (falls back to `low`) | Yes |
| `x-c-thru-thinking-budget-added` | Proxy expanded `maxOutputTokens` to fit thinking | `<N>` (added budget). On Gemini 3 N is the level's approx budget (minimal=256, low=2048, medium=8192, high=16384); on Gemini 2.5 N equals the explicit `thinkingBudget`. Suppressed on count_tokens. | Yes |
| `x-c-thru-thinking-tokens` | Upstream returned `usageMetadata.thoughtsTokenCount` | `<N>`. **Non-streaming only** — headers can't be set after SSE `writeHead`. Streaming surfaces this via a custom `c-thru-thinking-tokens` SSE event (see below). | No |

`output_tokens` includes thinking tokens (Anthropic parity):
`candidatesTokenCount + thoughtsTokenCount`. Streaming and non-streaming
both follow this convention.

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

The headers are stamped from two locations:

1. **`buildCthruResponseHeaders`** (`tools/claude-proxy:~2090`) — Gemini path. Reads non-enumerable `_*` stashes on the response body (e.g. `_thinkingAutoEnabled`, `_cacheStatus`) plus `requestMeta` for resolution-derived fields. Streaming and non-streaming Gemini both call this.
2. **Inline header writes** (`tools/claude-proxy:~1217, ~1417, ~1815`) — Anthropic / OpenRouter / passthrough paths. Stamp `x-c-thru-served-by` / `-resolved-via` / `-resolution-chain` / `-fallback-from` directly when forming `outHeaders`.
3. **Handler-top `res.setHeader`** — `x-c-thru-dashboard` only. Set once at the top of the request handler (before any routing) so every response carries it; `setHeader` values merge with later `writeHead` header objects, which is why this works for both control endpoints and streaming responses.

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
| `openai` | 501 stub | Anthropic→OpenAI translation — not yet implemented; returns 501 with an informative message |

**Why separate from `format`?**
`format` is used for wire-level concerns (auth header selection: `x-goog-api-key` vs `Authorization`).
`call_style` is used for translation-layer routing. Decoupling them allows:
- Documenting future `call_style:"openai"` intent on an endpoint without changing current dispatch
- Overriding translation independently of auth/wire format (e.g. passthrough to a Gemini-URL endpoint)

**Example — `gemini_ai_compat`** uses `format:"anthropic"` (passthrough auth) but `call_style:"openai"` to
document that its `/v1beta/openai` URL speaks OpenAI protocol. Once `forwardOpenAI` is implemented,
it will dispatch correctly without any config change.

**Backward compatibility:** all existing configs work unchanged. `format:"gemini"` infers
`call_style:"gemini"`, `format:"anthropic"` infers `call_style:"anthropic"`, `format:"openai"` infers
`call_style:"openai"` (still 501 — no behavior change).

## See also

- `docs/gemini-gap-roadmap.md` — gap inventory; each `Gx` entry that
  ships a new header documents it here.
- `CLAUDE.md` — top-level summary (links here for the full reference).
- `docs/journaling.md` — how `journal/<capability>.jsonl` records
  capture these headers per request.
