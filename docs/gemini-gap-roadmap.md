# Anthropic ↔ Gemini gap inventory + prioritized fill-in

## Context

The Gemini live-validation pass (commit `30dd374`) shipped 95/95 shape tests +
26/26 e2e + 33/33 offline translation. Several assertions had to be patched
or self-skip because the proxy doesn't implement the underlying Anthropic API
surface, or implements it weakly. Those skips are not bugs in the tests —
they are signposts to real gaps in Claude Code → Gemini coverage.

This document is the single source of truth listing every gap, grouped by
impact on real Claude Code traffic, with enough detail per gap to schedule
each as its own follow-up commit. It is a **gap roadmap**, not an
implementation. Each P0/P1 entry is sized small enough to be one commit.

---

## Severity rubric

- **P0** — Claude Code breaks visibly (wrong status code, hung request, lost
  data) when it sends this against a Gemini route.
- **P1** — silently degrades a Claude Code feature; user gets a worse answer
  than they would on Anthropic. No error, no log.
- **P2** — observability / nice-to-have; behavior matches Anthropic well
  enough today.
- **P3** — explicitly out of scope (no Gemini equivalent, or Anthropic-only
  feature with no realistic Claude Code traffic).

---

## P0 — Visible breakage

| ID | Gap | Live evidence | Sketch |
|----|-----|---------------|--------|
| **G1** | `/v1/messages/count_tokens` misroutes through the message handler — returns `{type:"message"}` instead of `{type:"message_count"}`, and burns a real Gemini message call to estimate tokens. | S17 patched to skip when `status===200` | Add early-return handler in proxy URL dispatch. Translate to Gemini `:countTokens`; map `totalTokens` → `{input_tokens}`. ~40 LOC near the `/v1/messages` route in `tools/claude-proxy`. |
| **G2** | `/v1/models` returns 404. Claude Code's auto-completion / model picker silently degrades. | S18 PASS (pins 404) | Add handler that translates Gemini `models.list` (or static list from `endpoints` config) into Anthropic `{data:[{type:"model",id,display_name,created_at}]}` shape. Cheap. |
| **G3** | Vision content blocks (`type:"image"`, base64 + `media_type`) — **zero handling** in `mapAnthropicToGemini`. Claude Code sends these every time the user shows a screenshot. Currently they are likely passed verbatim → Gemini 400. | No coverage (no test sends an image block) | In `mapAnthropicToGemini`, add a branch: image block → Gemini `inlineData:{mimeType, data}`. Add S26 live test that sends a 1×1 PNG and asserts 200. |

---

## P1 — Silent degradation

| ID | Gap | Live evidence | Sketch |
|----|-----|---------------|--------|
| **G4** | `cache_control` markers in system / user blocks are stripped silently. Claude Code uses these aggressively — losing them means every CC turn pays full prompt cost on Gemini routes. | S13b PASS (strip confirmed) | Wire to Gemini's [Context Caching API](https://ai.google.dev/gemini-api/docs/caching) when system block carries `cache_control:{type:"ephemeral"}`. Cache key from content hash; reuse `cachedContent` reference on subsequent requests. Bigger commit (~150 LOC, cache-store + lifecycle). |
| **G5** | `tool_result.is_error=true` is dropped — Gemini sees a normal tool response and may not know to retry. | No coverage | In tool_result mapping (search `tool_result` in `mapAnthropicToGemini`), translate `is_error=true` → Gemini `functionResponse.response.error` field. ~10 LOC + 1 translation test. |
| **G6** | `thoughtSignature` empty in non-streaming thinking responses, present in streaming. Multi-turn conversations that echo the prior thinking back lose the signature → upstream may reject in the future. Currently Gemini accepts an empty signature. | S21 patched to assert `typeof === 'string'`, not non-empty | In non-streaming response partition, find the per-part `thoughtSignature` and emit on the `thinking` content_block. Same source field as the streaming `signature_delta` already uses. ~15 LOC. |
| **G7** | `prompt-caching-2024-07-31` and other beta headers silently dropped; no observability that they were dropped. | S19 PASS (no 4xx, no signal) | In header forwarding, add `x-c-thru-beta-dropped: <comma-list>` response header so callers can detect feature loss. ~5 LOC + assertion in S19. |
| **G8** | Document/PDF content blocks (`type:"document"`) — no mapping. Claude Code's PDF reader sends these. | No coverage | Mirror G3 pattern: document block → Gemini `inlineData:{mimeType:'application/pdf', data}` for inline; switch to `fileData:{fileUri}` once we wire the Files API (G9). |

---

## P2 — Observability / hardening

| ID | Gap | Live evidence | Sketch |
|----|-----|---------------|--------|
| **G9** | No Files API equivalent (`/v1/files`). Claude Code can upload large PDFs/images and reference by ID. Today only inline base64 works (caps at ~20MB request). | No coverage | Add `/v1/files` handler proxying to Gemini Files API. Returns Anthropic-shape `{id:'file_…', mime_type, size_bytes}`. Larger feature; defer until G3/G8 land. |
| **G10** | `request_id` not propagated on responses. Anthropic's docs guarantee one — Claude Code logs/retries depend on it. | No coverage | Add `request-id` response header. Generate `req_<hex>` if absent from upstream. ~3 LOC. |
| **G11** | SSE keepalive (`: ping`) presence not asserted on long streams; if upstream goes quiet, `claude` CLI may hang. | S20 SKIP (upstream too fast) | Verify our SSE writer emits a comment line every ~10s during quiet upstream periods. May already work — needs an artificial-latency test to confirm. |
| **G12** | Flash-lite / older Gemini variants do emit thinking blocks (S22 surprised us). Today we always partition them as `thinking` content. Anthropic clients may not expect thinking on non-thinking models → may render twice. | S22 patched to skip when thinking present | Decide: pass through as-is (current), or only emit thinking blocks when `body.thinking?.type==='enabled'`. Trade-off note in code. |
| **G13** | Schema scrubber removes constructs Gemini rejects (`oneOf`/`allOf`/`$ref`/`additionalProperties`) silently. If a tool relied on the construct, behavior diverges from Anthropic. Surface as warning header. | S8 PASS (silent strip) | Emit `x-c-thru-schema-scrubbed: <fields>` on tool calls so users see when constructs were dropped. ~5 LOC. |
| **G14** ✓ | Gemini 3 counts thinking against `maxOutputTokens` — `max_tokens=300` produced 10 visible tokens because the budget pooled. `output_tokens` reported visible-only (Anthropic semantics include thinking). Gemini 3 Pro's flagship reasoning was gated behind opt-in. | Live test: `gemini-pro-latest` truncated at 10 tokens with `max_tokens=300` | **Shipped.** Auto-enable thinking on Gemini 3 Pro (default budget 1024, opt-out via `thinking:{type:'disabled'}`). Expand `maxOutputTokens` to `max_tokens + thinkingBudget`. Sum `candidatesTokenCount + thoughtsTokenCount` into `output_tokens`. Surface via `x-c-thru-thinking-{auto-enabled,budget-added,tokens}` headers + streaming `message_delta.usage.thinking_output_tokens`. Tests 17/17b/18/19/19b/19c/20/20b/20c/20d/20e. |
| **G15** ✓ | `/model` runtime picker drops non-`claude-*` IDs from `/v1/models`, so Gemini was unreachable mid-session even though the proxy advertised it. | Live: 9 Gemini IDs returned by `/v1/models` but picker shows 0 | **Shipped.** Added `claude-via-gemini-pro` and `claude-via-gemini-flash` aliases in `model_routes`. The `claude-via-` prefix makes the picker label obvious as a routed entry. Direct `gemini-*` IDs still work. |

---

## P3 — Out of scope

- **Citations** (Anthropic search-tool feature; no Gemini equivalent).
- **Computer-use tool** (Anthropic-only).
- **Native `web_search` tool** (Anthropic and Gemini both have one, but the
  schemas differ enough that "passthrough" is the right call — let the
  client send Gemini's `google_search` directly).
- **Batches API** (`/v1/messages/batches`) — neither real-time CC nor any
  c-thru workflow uses this today.
- **`anthropic-beta: interleaved-thinking-2025-05-14`** — already exercised
  by S24 and works.

---

## Recommended sequencing

Land in this order; each is a single commit:

1. **G1** (count_tokens) — small, breaks an obvious public endpoint, easy
   regression test.
2. **G3** (image content blocks) — biggest user-visible win for Claude Code
   on Gemini routes. Add S26 live test.
3. **G6** (non-streaming thoughtSignature) — tiny fix, future-proofs against
   Gemini tightening signature validation. Re-tighten S21 assertion.
4. **G5** (tool_result.is_error) — small correctness fix.
5. **G2** (`/v1/models`) — small surface, polish.
6. **G7** (beta-dropped header) — observability, unblocks future audits.
7. **G10** (request_id propagation) — small, polish.
8. **G13** (schema-scrubbed warning header) — observability.
9. **G12** (thinking-emission policy decision) — ask first; not obviously
   right in either direction.
10. **G8** (document blocks inline) — depends on G3 pattern.
11. **G9** (Files API) — biggest of the bunch; do last.
12. **G4** (Gemini Context Caching) — biggest user-visible win after G3, but
    largest commit. Do last because it touches request lifecycle.

---

## Critical files

| File | Role in fixes |
|---|---|
| `tools/claude-proxy` | All translation, routing, header handling — every G* lands here. |
| `test/proxy-gemini-translation.test.js` | Add unit cases for G3/G5/G6/G8 mock translations. |
| `test/proxy-gemini-live-shapes.test.js` | Add S26 (image), S27 (count_tokens), S28 (/v1/models), S29 (request_id), S30 (cache_control), S31 (document). Re-tighten S21 after G6. |
| `test/proxy-gemini-routing.test.js` | Add routing cases for `/v1/messages/count_tokens` and `/v1/models`. |
| `test/proxy-gemini-live-e2e.test.sh` | Add L14 (Claude Code pastes a screenshot → CC gets a description). |

## Reused infrastructure

- `withProxy`, `httpJson`, `assert`, `skip`, `summary` from `test/helpers.js`
  — all gap tests reuse these.
- Existing `mapAnthropicToGemini` / `mapGeminiToAnthropic` functions in
  `tools/claude-proxy` — extend, don't replace.
- Existing scrubber `scrubSchema` — reuse for image block validation if any
  schema fields slip in.
- `applyOutboundAuth` for any new endpoint that needs `x-goog-api-key`.

## Verification

Each commit ships with:

```sh
# Offline first
node test/proxy-gemini-translation.test.js
node test/proxy-gemini-routing.test.js

# Then live (gated)
GOOGLE_API_KEY=$KEY C_THRU_LIVE_GEMINI=1 \
  node test/proxy-gemini-live-shapes.test.js
GOOGLE_API_KEY=$KEY C_THRU_LIVE_GEMINI=1 \
  bash test/proxy-gemini-live-e2e.test.sh
```

Per-gap success criteria:

- **G1**: `POST /v1/messages/count_tokens` returns `{type:"message_count", input_tokens:N}`, no model invocation in journal.
- **G2**: `GET /v1/models` returns Anthropic-shaped `{data:[…]}` listing all configured Gemini models.
- **G3**: S26 sends a 1×1 PNG → 200 status; model description mentions "image" or color.
- **G4**: Same prompt twice in a row → second turn shows `cache_creation_input_tokens=0, cache_read_input_tokens>0` in usage.
- **G5**: `is_error:true` tool_result → Gemini `functionResponse.response.error` in serialized request body.
- **G6**: S21 thoughtSignature non-empty when upstream returns one.
- **G7**: `S19` re-asserts `x-c-thru-beta-dropped` header lists the dropped beta tokens.
- **G10**: All responses carry a `request-id` header matching `^req_[a-f0-9]{16}$`.

## Out of scope for this plan

- Implementation of any G*. This plan only **identifies** and **prioritizes**
  them.
- Vertex AI parity for new endpoints. Vertex routing already works for
  `/v1/messages` (T3-T5) — extend later, not in the same commits as G1/G2.
- Fixing the pre-existing routing test failure (`no x-goog-api-key when env
  unset`) — separate environment-leakage bug.
