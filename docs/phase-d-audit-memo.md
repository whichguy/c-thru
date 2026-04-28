# Phase D — Anthropic-Protocol Coverage Audit

**Scope:** Static-only audit of `tools/claude-proxy` after the Phase A–C2 refactor that
re-pointed Ollama backends at `/v1/messages` pass-through (commits `b530b2c..68d5801`).
**Method:** Read-only inspection of `tools/claude-proxy` (2130 lines) — no live traffic.
**Output:** Per-item verdict + line citations. Soak deliberately skipped per user direction;
Phase 0 already empirically validated the highest-risk wire-format items.

Verdict legend:
- `confirmed-OK` — code path is correct as-is for the new pass-through model
- `broken-needs-fix` — concrete bug; gets a separate fix commit on `main`
- `unsupported-document` — works structurally but behaviour depends on upstream/model and
  cannot be settled by static reading; capture as a known limitation

---

## D1 — `/v1/messages/count_tokens` endpoint

**Verdict:** `unsupported-document`

**Lines:** `tools/claude-proxy:1980` (route match), `tools/claude-proxy:949` (path forwarding)

**Evidence:** No dedicated handler. The dispatcher matches `req.url.startsWith('/v1/messages')`
which also catches `/v1/messages/count_tokens`. Body parsing requires a `string`
`body.model` (L1997-1999), which a count-tokens payload supplies. The request is then
resolved through `forwardAnthropic`, where `forwardedPath = basePrefix + req.url` (L948-949)
preserves the `/count_tokens` suffix when forwarding upstream. For real Anthropic backends
that endpoint exists and works. For Ollama's `/v1/messages` adapter it is undocumented —
will likely return 404, and the proxy will re-wrap that as an `not_found_error` in
Anthropic shape (see D9). Mark as model/backend-specific behaviour to discover via real
use, not a proxy-side bug.

## D2 — `/v1/models` endpoint

**Verdict:** `unsupported-document`

**Lines:** `tools/claude-proxy:1935-1974` (`/v1/active-models` — c-thru-private,
unrelated), `tools/claude-proxy:2101` (404 fallthrough)

**Evidence:** No `/v1/models` route. The router only handles `/ping`, `/c-thru/*`,
`/hooks/context`, `/v1/active-models`, `/v1/probe-llm`, and `/v1/messages*`; everything else
falls into the trailing `sendAnthropicError(res, 404, ...)` at L2101. Claude Code does not
appear to call `/v1/models` in normal operation, so this has not surfaced. If it ever does,
the fix is a one-line short-circuit that returns whatever shape the client expects (most
likely the same `local_models`/`capabilities` payload as `/v1/active-models`). Document as
a known gap.

## D3 — Anthropic beta / version / auth header survival

**Verdict:** `confirmed-OK`

**Lines:** `tools/claude-proxy:628-644` (`scrubCthruHeaders`)

**Evidence:** The function deletes only `host`, `connection`, `content-length`, and any
`x-c-thru-*` prefix. `anthropic-version`, `anthropic-beta`, and `authorization` are not
referenced and pass through unchanged. For Ollama backends, `forwardAnthropic` then
overwrites `authorization` with `Bearer ollama` (L938) and strips `x-api-key` (L939) —
this is the intended scrub of the ambient real Anthropic key, not a header-survival
problem.

## D4 — `mapStopReason()` reachability

**Verdict:** `confirmed-OK`

**Lines:** `tools/claude-proxy:559-568` (definition), `tools/claude-proxy:1361` (call from
`setupOllamaStream`), `tools/claude-proxy:1542` (call from `handleOllamaNonStream`)

**Evidence:** Both call sites are inside the legacy NDJSON → Anthropic-SSE translation
helpers, which are themselves only invoked from `forwardOllamaLegacy` (`tools/claude-proxy:1690,1692`).
`forwardAnthropic` never reads Ollama-style `done_reason` — it pipes upstream verbatim and
trusts upstream to emit Anthropic's `stop_reason` directly in `message_delta`. No leakage
of legacy mapping into the new path.

## D5 — Usage / billing field extraction

**Verdict:** `confirmed-OK`

**Lines:** `tools/claude-proxy:1003-1037` (`forwardAnthropic` usage parser),
`tools/claude-proxy:1359-1360, 1540-1541` (legacy parser, isolated)

**Evidence:** The new path parses `usage.input_tokens` from the SSE `message_start` frame
(L1025-1028) and `usage.output_tokens` from `message_delta` (L1029-1032), and top-level
`usage` for non-stream (L1033-1037). It contains no reference to `prompt_eval_count` or
`eval_count`; those Ollama-native fields are read only by `setupOllamaStream` /
`handleOllamaNonStream`, which are the legacy-only path. No accidental cross-wiring.

## D6 — `cache_control` and Anthropic-only body fields

**Verdict:** `confirmed-OK`

**Lines:** `tools/claude-proxy:1092` (body write), `tools/claude-proxy:927-933` (no body
mutation in `forwardAnthropic`)

**Evidence:** `forwardAnthropic` writes the body verbatim with `up.write(JSON.stringify(body))`
at L1092. The only mutation in the new path is `body.model = effectiveModel` performed by
the caller (L2094) before dispatch. There is no field-stripping, no projection. Phase 0
confirmed Ollama 0.21.2's `/v1/messages` adapter accepts `cache_control` blocks and
`anthropic-beta` headers without error.

## D7 — Streaming event-type coverage (extended)

**Verdict:** `confirmed-OK` for the six event types Phase 0 verified;
`unsupported-document` for `ping` and `signature_delta` which require live emission.

**Lines:** `tools/claude-proxy:1071` (`upRes.pipe(res)`), `tools/claude-proxy:1006-1011`
(tee for usage extraction)

**Evidence:** `forwardAnthropic` is a transparent pipe — every byte upstream emits reaches
the client unchanged, modulo a separate cap-bounded copy used solely for usage parsing.
Therefore any SSE event type Ollama emits, including ones Phase 0 did not probe (e.g.
`ping`, `signature_delta` for thinking models with redaction), is forwarded byte-for-byte
without translation. Static reading cannot determine whether Ollama actually emits these —
flag for behavioural follow-up if Anthropic-side features regress.

## D8 — Image / multimodal blocks

**Verdict:** structurally `confirmed-OK`; behaviourally `unsupported-document`

**Lines:** `tools/claude-proxy:1092` (verbatim body forwarding)

**Evidence:** Same mechanism as D6 — the proxy does not project, strip, or transform
content blocks on the new path. Image blocks reach Ollama's `/v1/messages` adapter
unchanged. Whether Ollama (a) accepts image content blocks at the adapter level, and
(b) routes them to a model that can interpret them, is a model-specific question outside
the proxy's surface. No proxy-side bug.

## D9 — Error response shape parity

**Verdict:** `unsupported-document` (minor lossy re-wrap)

**Lines:** `tools/claude-proxy:961-979` (re-wrap on fallback exhaustion),
`tools/claude-proxy:585-590` (`sendAnthropicError`), `tools/claude-proxy:902-905`
(`shouldFallbackOnStatus`)

**Evidence:** Two paths.
- **Status 400 from upstream** is excluded from the fallback gate and falls through to
  `upRes.pipe(res)` at L1071 — verbatim shape preservation.
- **Status 401/403/404/429/5xx** triggers `tryFallbackOrFail`; if every fallback target
  is exhausted, the proxy emits its own envelope via `sendAnthropicError`
  (L976), which is `{type: 'error', error: {type, message}}`. This drops the upstream
  `request_id` field and any vendor-specific `error.type` discriminator, replacing it
  with the proxy's own status-derived `anthropicErrorType()` mapping. Phase 0 confirmed
  Ollama returns `{type, error:{type, message}, request_id}` natively for 404; the
  re-wrap path discards the `request_id`. Functionally correct (clients still get a
  parseable Anthropic-shape error) but a small fidelity loss vs. true pass-through.
  Track as an observable, not a bug; if request-id correlation across upstream logs
  becomes important, fix by changing `forwardAnthropic` to pipe the upstream error body
  verbatim when fallback is not configured.

## D10 — Hooks / health endpoints (`/hooks/context`, `/ping`)

**Verdict:** `confirmed-OK`

**Lines:** `tools/claude-proxy:1878` (`/ping`), `tools/claude-proxy:1923-1933`
(`/hooks/context`)

**Evidence:** Both endpoints `return send(res, 200, ...)` immediately, before any
backend resolution or dispatch. No path leads from either into `forwardAnthropic`,
`forwardOllamaLegacy`, or `dispatchOllamaBackend`. These are pure proxy-private
handlers and cannot regress against Ollama wire-format changes.

## Bonus — `forwardAnthropic` rename / consolidation

**Verdict:** Skipped — out of scope per the original plan.

**Evidence:** The function name is technically inaccurate — it now handles all
backends that speak the Anthropic Messages API including Ollama's `/v1/messages`
adapter — but renaming would touch every dispatch site (L817, L851, L893, L1630, L2098)
for zero behavioural change. Address opportunistically when next editing this file
for an unrelated reason.

---

## Summary

| Item | Verdict | Action |
|---|---|---|
| D1 — count_tokens | unsupported-document | known limitation; one-line short-circuit if it surfaces |
| D2 — /v1/models | unsupported-document | known limitation; one-line short-circuit if it surfaces |
| D3 — beta headers | confirmed-OK | none |
| D4 — mapStopReason | confirmed-OK | none |
| D5 — usage extraction | confirmed-OK | none |
| D6 — body verbatim | confirmed-OK | none |
| D7 — SSE event coverage | confirmed-OK / unsupported-document | flag if thinking-with-redaction regresses |
| D8 — multimodal | confirmed-OK / unsupported-document | model-dependent |
| D9 — error parity | unsupported-document | minor — request_id squashed on fallback-exhausted re-wrap |
| D10 — hooks endpoints | confirmed-OK | none |

**No `broken-needs-fix` items.** No follow-up patches required from this audit.

Three items end up in the `unsupported-document` bucket (D1, D2, and D9's request_id
loss). Per CLAUDE.md guidance ("known-limitation entries we'd document … if we accumulate
more than 2"), this crosses the threshold — a single CLAUDE.md entry under the proxy
section would be the lightest follow-up. Defer that consolidation until at least one of
the three causes a real complaint, since each is independently low-impact.
