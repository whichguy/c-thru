# Anthropic API Coverage Matrix (claude-proxy)

> **Status**: living document. Update whenever a new endpoint, content-block
> type, or server tool is handled — and whenever Tier 2 verification finds a
> previously-assumed passthrough is actually lossy.
>
> See also: `docs/headers.md` (every `x-c-thru-*` response header),
> `docs/gemini-gap-roadmap.md` (Gemini translation roadmap).

## Cell vocabulary

| Symbol | Meaning |
|---|---|
| ✅ | Explicit translated handler — verified roundtrip in tests |
| 🔁 | Catch-all passthrough — exercised by the in-repo stub test (`test/anthropic-api-coverage.test.js`); auth + headers + method propagation verified against a local stub. **Not** verified against live `api.anthropic.com` for response-body shape per endpoint. |
| ⚠️ | Catch-all passthrough — **unverified** (may regress on auth, beta-headers, multipart, SSE, or non-POST methods) |
| 🚫 | Explicit 501 with structured Anthropic-shape error (`error.type: "not_implemented"`) |
| ➖ | N/A — backend has no equivalent semantics |

The "🚫 vs catch-all" decision is made at request time. The proxy forwards
Anthropic-only paths to the configured `anthropic` endpoint whenever one is
configured — `applyOutboundAuth` synthesizes the right header from env or
subscription state, and Claude Code calls that arrive without inbound auth
(notably `/v1/oauth/token` for subscription token refresh) still reach the
upstream that can serve them. The proxy only short-circuits to a structured
501 when no `anthropic` endpoint exists at all (purely-local config). See
`unsupportedForBackend()` and `ANTHROPIC_ONLY_PATHS` in `tools/claude-proxy`.

`/v1/oauth/token` and `/v1/files/{id}/content` are intentionally **not**
in `ANTHROPIC_ONLY_PATHS` — OAuth is the bootstrap path (must always
forward) and content download has a custom routing rule (Gemini Files API
handles upload/list/get/delete only, so content download flows through the
catch-all even when a Gemini backend is present).

## Backend columns

| Column | Identifier in proxy |
|---|---|
| **Anthropic** | `call_style: "anthropic"` (default), `endpoints.anthropic`, OpenRouter, etc. |
| **Gemini** | `call_style: "gemini"` (Google AI Studio + Vertex). Translated by `forwardGemini`. |
| **Ollama** | `kind: "ollama"` or `localhost:11434`. Default path is `forwardAnthropic` to Ollama's `/v1/messages` adapter (Ollama 0.4+); `legacy_ollama_chat: true` opts into `forwardOllamaLegacy` (`/api/chat`). |
| **OpenAI** | `call_style: "openai"` — currently a hard 501 stub (see Tier 3d). |

---

## Endpoint coverage

| Path | Method(s) | Anthropic | Gemini | Ollama | OpenAI |
|---|---|---|---|---|---|
| `/v1/messages` (non-stream) | POST | ✅ | ✅ | ✅ | 🚫 |
| `/v1/messages` (stream) | POST | ✅ | ✅ | ✅ | 🚫 |
| `/v1/messages/count_tokens` | POST | ✅ (passthrough) | ✅ (`:countTokens`) | ➖ | 🚫 |
| `/v1/messages/batches` | POST | ⚠️ catch-all → Anthropic | ➖ no native batch API | ➖ | 🚫 |
| `/v1/messages/batches` (list) | GET | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/messages/batches/{id}` | GET | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/messages/batches/{id}/results` | GET | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/messages/batches/{id}/cancel` | POST | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/messages/batches/{id}` | DELETE | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/models` | GET | ✅ (synthesized) | ✅ (synthesized) | ✅ (synthesized) | ✅ (synthesized) |
| `/v1/models/{id}` | GET | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/files` (upload) | POST | ⚠️ catch-all → Anthropic (multipart) | ✅ via Files API translator | ➖ | 🚫 |
| `/v1/files` (list) | GET | ⚠️ catch-all → Anthropic | ✅ | ➖ | 🚫 |
| `/v1/files/{id}` (metadata) | GET | ⚠️ catch-all → Anthropic | ✅ | ➖ | 🚫 |
| `/v1/files/{id}/content` (download) | GET | 🔁 catch-all → Anthropic | 🚫 not handled by Gemini Files translator — falls through to Anthropic catch-all even when Gemini backend present | ➖ | 🚫 |
| `/v1/files/{id}` | DELETE | ⚠️ catch-all → Anthropic | ✅ | ➖ | 🚫 |
| `/v1/skills*` (skills-2025-10-02) | POST/GET/PATCH/DELETE | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/agents*` (managed-agents-2026-04-01) | POST/GET/PATCH/DELETE | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/sessions*` | POST/GET/PATCH/DELETE | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/sessions/{id}/stream` | GET (SSE) | ⚠️ catch-all (long-lived SSE — unverified) | ➖ | ➖ | 🚫 |
| `/v1/sessions/{id}/events` | POST | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/sessions/{id}/archive` | POST | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/environments*` | POST/GET/PATCH/DELETE | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/vaults*` | POST/GET/PATCH/DELETE | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/oauth/token` | POST | 🔁 catch-all → Anthropic (bootstrap path — never gated) | ➖ | ➖ | 🚫 |
| `/v1/organizations/me` | GET | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/organizations/{id}/users*` | * | ⚠️ catch-all → Anthropic (admin key required) | ➖ | ➖ | 🚫 |
| `/v1/organizations/{id}/invites*` | * | ⚠️ catch-all → Anthropic (admin key) | ➖ | ➖ | 🚫 |
| `/v1/organizations/{id}/workspaces*` | * | ⚠️ catch-all → Anthropic (admin key) | ➖ | ➖ | 🚫 |
| `/v1/organizations/{id}/api_keys*` | * | ⚠️ catch-all → Anthropic (admin key) | ➖ | ➖ | 🚫 |
| `/v1/usage_report/messages` | GET | ⚠️ catch-all | ➖ | ➖ | 🚫 |
| `/v1/usage_report/claude_code` | GET | ⚠️ catch-all | ➖ | ➖ | 🚫 |
| `/v1/cost_report` | GET | ⚠️ catch-all | ➖ | ➖ | 🚫 |
| `/v1/rate_limits` | GET | ⚠️ catch-all | ➖ | ➖ | 🚫 |
| `/v1/audit_logs` | GET | ⚠️ catch-all | ➖ | ➖ | 🚫 |
| `/v1/complete` (legacy) | POST | ⚠️ catch-all | ➖ | ➖ | 🚫 |

---

## Sub-matrix: content-block translation for `/v1/messages`

Cells describe what happens to a block of that type in the **inbound** request
on its way to the upstream backend. Output translation (upstream → Anthropic)
is a separate concern handled by `forwardGemini` SSE assembly and the Ollama
adapters.

| Block type | Anthropic | Gemini | Ollama (`/v1/messages`) | Ollama (legacy `/api/chat`) |
|---|---|---|---|---|
| `text` | ✅ | ✅ → `parts[].text` | ✅ | ✅ |
| `image` (base64/url/file) | ✅ | ✅ → `inlineData` / `fileData` | ✅ (forwarded; backend may reject) | ⚠️ flattened to text |
| `document` (PDF) | ✅ | ✅ → `inlineData` / `fileData` (PDF mime) | ✅ (forwarded) | ⚠️ flattened |
| `tool_use` | ✅ | ✅ → `functionCall` (with `thoughtSignature` for Gemini 3+) | ✅ | 🚫 stripped |
| `tool_result` | ✅ | ✅ → `functionResponse` (`is_error` wrapped in `.error`) | ✅ | 🚫 stripped |
| `thinking` | ✅ | ✅ → `parts[].thought:true` (+ `thoughtSignature`) | ✅ | 🚫 stripped |
| `redacted_thinking` | ✅ | 🚫 dropped (Gemini cannot decrypt; surfaced via `x-c-thru-redacted-thinking-dropped` + `x-c-thru-translation-gap`) | ✅ | 🚫 stripped |
| `server_tool_use` | ✅ | 🚫 dropped (Gemini grounding has different lifecycle; gap header) | ⚠️ unknown | 🚫 stripped |
| `web_search_tool_result` | ✅ | 🚫 dropped (gap header) | ⚠️ unknown | 🚫 stripped |
| `web_fetch_tool_result` | ✅ | 🚫 dropped (gap header) | ⚠️ unknown | 🚫 stripped |
| `code_execution_tool_result` | ✅ | 🚫 dropped (gap header) | ⚠️ unknown | 🚫 stripped |
| `tool_search_tool_result` | ✅ | 🚫 dropped (gap header) | ⚠️ unknown | 🚫 stripped |
| `mcp_tool_use` | ✅ | 🚫 dropped (gap header) | ⚠️ unknown | 🚫 stripped |
| `mcp_tool_result` | ✅ | 🚫 dropped (gap header) | ⚠️ unknown | 🚫 stripped |
| `container_upload` | ✅ | 🚫 dropped (gap header) | ⚠️ unknown | 🚫 stripped |
| `citations[]` field on text | ✅ (passthrough) | ⚠️ stripped on translate to `parts[].text` (gap header may not fire — citations live on a parent `text` block) | ⚠️ unknown | 🚫 stripped |

The **translation-gap header** (`x-c-thru-translation-gap`) was added to make
the 🚫 cells in the Gemini column observable. When `mapAnthropicToGemini`
encounters a block type it does not handle, it records the type into a Set
and `buildCthruResponseHeaders` joins the set into a comma-separated header.
Absent header = no gaps recorded.

---

## Sub-matrix: server tools

Server tools are tool definitions sent in the request `tools[]` array (each
with a `type: "<server_tool>_<version>"` discriminator). Cell describes
forwarding behavior:

| Server tool | Anthropic | Gemini | Ollama | OpenAI |
|---|---|---|---|---|
| `web_search_20260209` | ✅ passthrough | ⚠️ stripped by `scrubGeminiSchema` (no equivalent) | ⚠️ unknown | 🚫 |
| `web_fetch_20250910` | ✅ | ⚠️ stripped | ⚠️ unknown | 🚫 |
| `code_execution_20250522` | ✅ | ⚠️ stripped (Gemini code-execution exists but lifecycle differs) | ⚠️ unknown | 🚫 |
| `tool_search_20250930` | ✅ | ⚠️ stripped | ⚠️ unknown | 🚫 |
| `computer_20250124` | ✅ | ⚠️ stripped | ⚠️ unknown | 🚫 |
| `bash_20250124` | ✅ | ⚠️ stripped | ⚠️ unknown | 🚫 |
| `text_editor_20250728` | ✅ | ⚠️ stripped | ⚠️ unknown | 🚫 |
| `memory_20250818` | ✅ | ⚠️ stripped | ⚠️ unknown | 🚫 |
| `advisor` | ✅ | ⚠️ stripped | ⚠️ unknown | 🚫 |
| `mcp_servers[]` (top-level) | ✅ | ⚠️ stripped | ⚠️ unknown | 🚫 |

Translation of any of these into Gemini-/Ollama-native equivalents is **out of
scope** for this audit — each is its own design task (see "Non-goals" in the
audit plan).

---

## Known passthrough gaps (Tier 2 verification findings)

These are passthrough cells that are currently marked ⚠️ because the
verification step turned up a question we cannot definitively answer without
either an integration test against the live upstream or a code-comment audit
against future regressions.

1. **Multipart `POST /v1/files` to Anthropic.** The catch-all uses
   `req.pipe(up)` which preserves the raw body and lets the upstream see the
   original `content-type: multipart/form-data; boundary=…`. `scrubCthruHeaders`
   deletes `content-length` (forcing chunked transfer); upstream Anthropic
   accepts chunked uploads. **Status: likely 🔁; flip on first user report.**

2. **Long-lived SSE on `GET /v1/sessions/{id}/stream` and slow `POST /v1/messages/batches`.**
   The catch-all idle timeout is bypassed when `Accept: text/event-stream` is
   present (covers the sessions stream) and when the path matches
   `/v1/messages/batches*` (covers slow batch creation, which can take well
   over a minute). All other catch-all paths use a 60 s idle cap. If a new
   long-lived endpoint is added, extend the carve-out in
   `forwardToAnthropicCatchAll`.

3. **DELETE / PATCH method propagation.** `req.method` is forwarded verbatim
   in the `lib.request({…, method: req.method, …})` call. Methods other than
   GET/POST appear to work, but no integration test exercises them. **Status:
   ⚠️ until covered by `test/anthropic-api-coverage.test.js`.**

4. **Admin-key auth (`sk-ant-admin-…`).** `applyOutboundAuth` runs
   `bearer_priority` for any backend whose `kind: "anthropic"` (or derived
   profile is `bearer_priority`). The incoming `x-api-key` is forwarded
   verbatim when no `Authorization: Bearer …` header is present. Admin keys
   look like regular keys to the wire layer, so they should pass through. The
   `auth-derived` header reports `bearer_priority` regardless of admin/user
   distinction — that is expected (the proxy does not inspect the key shape).

5. **`anthropic-beta` / `anthropic-version` headers.** `scrubCthruHeaders`
   only removes `host`, `content-length`, and `x-c-thru-*`. Beta/version
   headers pass through unchanged on every backend. The Gemini path
   additionally surfaces dropped beta tokens as `x-c-thru-beta-dropped`
   (Gemini upstream doesn't honor any Anthropic beta token).

6. **Catch-all forwards to Anthropic even in non-Anthropic modes.** This is
   intentional for Admin/OAuth/Skills/Agents (no Gemini/Ollama equivalent
   exists), but combined with the lack of pre-flight auth check, a client in
   `best-local-oss` mode without an Anthropic key would get a confusing 401
   from `api.anthropic.com`. The new
   `ANTHROPIC_ONLY_PATHS` gate flips this to a structured 501 instead — see
   `unsupportedForBackend` in `tools/claude-proxy`.

7. **`x-c-thru-translation-gap` header (new).** Documents which content-block
   types `mapAnthropicToGemini` could not represent. Cumulative across the
   request: a single value of `redacted_thinking,server_tool_use` means both
   were dropped. Documented in `docs/headers.md`.

8. **Ambient `ANTHROPIC_API_KEY` on a loopback proxy.** The relaxed gate
   forwards any inbound request to api.anthropic.com whenever an
   `endpoints.anthropic` is configured — `applyOutboundAuth` synthesizes the
   header from `process.env.ANTHROPIC_API_KEY`. Combined with the proxy's
   loopback bind (`127.0.0.1:<port>`), this means **any local process that
   can reach the proxy port can issue billed Anthropic calls (including
   admin-API operations if the env key is an `sk-ant-admin-…`) without ever
   providing a key of its own.** This is the deliberate design — Claude Code
   cannot present a key on every internal call — but operators running a
   shared workstation should be aware. Mitigations: bind to a UNIX socket or
   require subscription mode (`auth: "subscription"`) so the key never leaks
   from a Bearer-only flow.

---

## Verification

End-to-end smoke (manual):

- `node --check tools/claude-proxy` and `bash -n tools/c-thru` pass.
- `make test-fast` passes (includes `test/anthropic-api-coverage.test.js`).
- With proxy running, `CLAUDE_LLM_MODE=best-local-oss`, **no Anthropic auth**:
  ```
  curl -is localhost:$PORT/v1/messages/batches -d '{}'
  → HTTP/1.1 501 Not Implemented
  → {"type":"error","error":{"type":"not_implemented", ...}}
  ```
- With `CLAUDE_LLM_MODE=best-cloud` and `ANTHROPIC_API_KEY` set: the same call
  forwards to Anthropic (assert via outbound socket capture).
- A `/v1/messages` request to a Gemini backend containing a `redacted_thinking`
  block returns a response with header
  `x-c-thru-translation-gap: redacted_thinking`.
