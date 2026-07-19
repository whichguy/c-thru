# Anthropic ↔ OpenAI gap inventory + prioritized fill-in

## Context

OpenAI Responses translation is live for Anthropic Messages traffic: request
mapping, non-stream and SSE response mapping, tools, status/error handling, and
proxy-side token estimation. The shipping lineage is `135070b`, `a671704`,
`adb74c7`, `c240c86`, `2d79a06`, and the verified current-top merge lineage
`8181340` / `f8dbbe8`; this cleanup pass adds the terminal-stream, refusal,
error-vocabulary, and reasoning-gap hardening documented below.

Missing or invalid `OPENAI_API_KEY` falling through to `routes.default` is
intentional documented fallback-cascade behavior shared by all backends, not an
authentication bug. CI is currently local-only for live OpenAI validation:
`.github/workflows/live-suites.yml` needs both a repository `OPENAI_API_KEY`
secret and `OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}` in its `env:` block.

---

## Severity rubric

- **P0** — Claude Code breaks visibly (wrong status code, hung request, lost data).
- **P1** — silently degrades a Claude Code feature.
- **P2** — observability / nice-to-have; behavior is otherwise usable.
- **P3** — explicitly out of scope (no equivalent or no realistic traffic).

---

## P0 — Visible breakage

| ID | Gap | Evidence | Sketch |
|----|-----|----------|--------|
| **O1** ✓ | P0 Responses translation shipped. | Commits above; offline routing/translation suites. | Request/response mapping and live-suite registration. |
| **O2** ✓ | An upstream SSE close without a Responses terminal event was synthesized as success. | This pass regression. | Pre-commit error or committed terminal Anthropic error, never `message_stop`. |
| **O3** ✓ | Streamed `response.refusal.delta` text was discarded. | This pass regression. | Forward deltas and close on `response.refusal.done`. |

---

## P1 — Silent degradation

| ID | Gap | Evidence | Sketch |
|----|-----|----------|--------|
| **O4** | Image/document content-block mapping. | P0 mapper is text-history-only. | Map supported OpenAI input content parts. |
| **O5** | Multi-turn tool round-trips. | Inbound `tool_use` / `tool_result` history is visibly dropped. | Translate function-call and function-call-output history. |
| **O6** | Reasoning-token budget expansion. | Reasoning is not budget-expanded. | Define Anthropic thinking-budget semantics for Responses. |
| **O7** | `thinking` / `redacted_thinking` full round-trip. | Only summary streaming is represented today. | Design a safe lossless mapping. |
| **O8** | Error-type vocabulary completeness beyond confirmed Anthropic types. | This pass allowlists the documented set. | Characterize OpenAI error codes/types before mapping. |
| **O9** | `top_k` / `stop_sequences` support. | Both are surfaced as request gap headers. | Map only where Responses semantics are equivalent. |
| **O10** ✓ | Unknown OpenAI error types were blindly passed through. | This pass regression. | Allowlist Anthropic vocabulary, then status fallback. |
| **O11** ✓ | Non-stream `reasoning` output was silently dropped. | This pass regression. | Tag-and-drop with `x-c-thru-translation-gap: reasoning`. |

---

## P2 — Observability / hardening

| ID | Gap | Evidence | Sketch |
|----|-----|----------|--------|
| **O12** | Observability headers. | Partial `x-c-thru-*` coverage exists. | Expand documented response/request diagnostic headers after P1 behavior settles. |

---

## P3 — Out of scope

- Server tools.
- Files / Batches API.
- Stateful session chaining.

---

## Recommended sequencing

1. O4 image/document mapping.
2. O5 multi-turn tool round-trips.
3. O6 reasoning-token budget expansion.
4. O7 thinking round-trip design.
5. O8/O9 vocabulary and sampling parity.
6. O12 observability polish.

---

## Critical files

| File | Role in fixes |
|---|---|
| `tools/claude-proxy` | OpenAI request/response translation and header behavior. |
| `test/proxy-openai-translation.test.js` | Offline mapping, stream, and resilience regressions. |
| `test/proxy-openai-routing.test.js` | Dispatch, fallback, auth, and HTTP error behavior. |
| `test/proxy-openai-live-shapes.test.js` | Gated real API shape validation. |

## Reused infrastructure

- `withProxy`, `httpJson`, `httpStream`, `assert`, `assertEq`, `skip`, and
  `summary` from `test/helpers.js`.
- `mapAnthropicToOpenAI`, `mapOpenAIOutputToAnthropic`,
  `buildCthruResponseHeaders`, and `applyOutboundAuth`.

## Verification

```sh
node test/proxy-openai-translation.test.js
node test/proxy-openai-routing.test.js
C_THRU_LIVE_OPENAI=1 OPENAI_API_KEY=$KEY \
  node test/proxy-openai-live-shapes.test.js
```

The cleanup pass additionally verifies a quiet-stream ping, client disconnect,
non-stream cap/malformed body behavior, usage cardinality, hostile auth-header
stripping, missing-terminal failures, refusal deltas, error-type fallback, and
reasoning gap signaling.

## Out of scope for this plan

- Implementing the P1/P2/P3 gaps listed above.
- Wiring the required OpenAI secret into CI; that needs repository/workflow
  authority outside this scoped cleanup.
