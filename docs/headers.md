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
| `x-c-thru-beta-dropped` | Request had `anthropic-beta` header tokens that Gemini can't honor | Comma-list of dropped tokens (`prompt-caching-2024-07-31,computer-use-2024-10-22`) | Yes |

## Thinking observability (Gemini ↔ Anthropic)

| Header | Set when | Value | Streaming? |
|---|---|---|---|
| `x-c-thru-thinking-auto-enabled` | Proxy auto-enabled thinking on Gemini 3 Pro family | `1`. Suppressed on `/v1/messages/count_tokens` (no model invocation) | Yes |
| `x-c-thru-thinking-level` | Gemini 3+ used `thinkingLevel` enum | `minimal` \| `low` \| `medium` \| `high`. Per-model variance: gemini-3-pro lacks `medium` (falls back to `high`), only flash supports `minimal` (falls back to `low`) | Yes |
| `x-c-thru-thinking-budget-added` | Proxy expanded `maxOutputTokens` to fit thinking | `<N>` (added budget). On Gemini 3 N is the level's approx budget (minimal=256, low=2048, medium=8192, high=16384); on Gemini 2.5 N equals the explicit `thinkingBudget`. Suppressed on count_tokens. | Yes |
| `x-c-thru-thinking-tokens` | Upstream returned `usageMetadata.thoughtsTokenCount` | `<N>`. **Non-streaming only** — headers can't be set after SSE `writeHead`. Streaming surfaces this inside `message_delta.usage.thinking_output_tokens` | No |

`output_tokens` includes thinking tokens (Anthropic parity):
`candidatesTokenCount + thoughtsTokenCount`. Streaming and non-streaming
both follow this convention. The non-spec
`message_delta.usage.thinking_output_tokens` SSE field is a temporary
workaround pending a proper custom SSE event (TODO: Task #8).

## Standard Anthropic headers

| Header | Set when | Value |
|---|---|---|
| `request-id` | Always | Upstream `request-id` if present and matches `^req_[a-f0-9]+$`, otherwise generated `req_<hex16>` (Anthropic guarantees one on every response for client log correlation — G10) |

## Trigger expressions in code

The headers are stamped from two locations:

1. **`buildCthruResponseHeaders`** (`tools/claude-proxy:~2090`) — Gemini path. Reads non-enumerable `_*` stashes on the response body (e.g. `_thinkingAutoEnabled`, `_cacheStatus`) plus `requestMeta` for resolution-derived fields. Streaming and non-streaming Gemini both call this.
2. **Inline header writes** (`tools/claude-proxy:~1217, ~1417, ~1815`) — Anthropic / OpenRouter / passthrough paths. Stamp `x-c-thru-served-by` / `-resolved-via` / `-resolution-chain` / `-fallback-from` directly when forming `outHeaders`.

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

## See also

- `docs/gemini-gap-roadmap.md` — gap inventory; each `Gx` entry that
  ships a new header documents it here.
- `CLAUDE.md` — top-level summary (links here for the full reference).
- `docs/journaling.md` — how `journal/<capability>.jsonl` records
  capture these headers per request.
