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
| **xAI (Grok)** | `endpoints.xai` — `format: "anthropic"` passthrough to `https://api.x.ai/v1/messages`. **Upstream status:** xAI documents Anthropic SDK / Messages compatibility as **fully deprecated** (prefer Responses API or gRPC for new clients). c-thru still uses Messages for brand-agent and `best-cloud-gov` Grok cells; the proxy sanitizes known 400 shapes (`sanitizeXaiAnthropicBody`). Non-2xx responses log `anthropic.upstream.error` (safe `message` + `body_preview`, `tools_in`, `xai`); midstream SSE failures log `client_cancelled` on `anthropic.upstream.midstream_error`. **Canary:** `C_THRU_LIVE_XAI=1 node test/proxy-xai-live.test.js` (C1–C5). Auth: `XAI_API_KEY` via `header_env` (never Anthropic client keys). The separate Grok Build CLI (`grok-cc`) does **not** use this path. See `docs/agent-architecture.md` § Grok surfaces. |
| **OpenAI** | `call_style: "openai"` — currently a hard 501 stub (see Tier 3d). Reserved durable landing zone if Anthropic Messages on xAI is hard-sunset (Chat Completions / Responses translator). |

---

## Claude Code LLM gateway contract

Claude Code over `ANTHROPIC_BASE_URL` is an **Anthropic Messages-format gateway
client**. The authoritative operator contract is Anthropic’s
[gateway protocol reference](https://code.claude.com/docs/en/llm-gateway-protocol)
(plus [connect](https://code.claude.com/docs/en/llm-gateway-connect) /
[rollout](https://code.claude.com/docs/en/llm-gateway-rollout)). c-thru’s
`claude-proxy` is that gateway: it also *translates* to Gemini/Ollama and
sanitizes xAI Messages quirks. The matrix below is the full Anthropic API
surface; this section marks what is **load-bearing for day-to-day Claude Code**
vs rare admin / Managed Agents traffic.

### Load-bearing for Claude Code (must stay green)

| Requirement | Official | c-thru | Pins |
|---|---|---|---|
| `POST /v1/messages` (+ `?beta=true`) | Required | ✅ all backends above | suite-wide |
| Stream SSE as bytes arrive (no full-body buffer) | Required | ✅ Anthropic: `upRes.pipe(res)` after headers; Gemini/Ollama: re-encoded Anthropic SSE | `test/proxy-gateway-protocol.test.js` §1; `test/proxy-streaming.test.js` |
| Forward `anthropic-beta` / `anthropic-version` open-list | Required | ✅ `scrubCthruHeaders` only strips host / content-length / `x-c-thru-*` | `test/proxy-gateway-protocol.test.js` §3 |
| Forward request body fields unchanged (Anthropic upstream) | Required | ✅ passthrough; translators intentionally rewrite | `tool_reference` pin §4 |
| Upstream **400** error wording unmodified | Required (CC auto-recovery matches text) | ✅ non-fallback 400: raw body; 5xx may use structured wrapper | `test/proxy-gateway-protocol.test.js` §2 |
| `POST /v1/messages/count_tokens` | Optional (CC estimates if absent) | ✅ | `test/proxy-count-tokens.test.js` |
| `GET /v1/models` | Optional discovery | ✅ synthesized from `model_routes` + `claude-via-*` | §5 of gateway-protocol suite |
| `HEAD /` | Best-effort startup probe | ✅ empty 200 | §5 |
| Long-lived SSE / stall | Client idle ~5m on gateways (`API_FORCE_IDLE_TIMEOUT`) | Proxy `STREAM_STALL_HARDFAIL_MS` (~5m) + translate-path `event: ping` keepalives | env: `CLAUDE_PROXY_PING_INTERVAL_MS` |

### Model discovery filter (Claude Code client)

When `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, Claude Code calls
`GET /v1/models?limit=1000` and **keeps only** entries whose `id` starts with
`claude` or `anthropic`. Non-Claude route keys (e.g. `grok-4.5`, `gemini-*`)
are ignored unless the proxy synthesizes `claude-via-<key>` aliases.

Default `picker_alias_endpoints`: `gemini_ai`, `gemini_vertex`, **`xai`**.
Override with a top-level array in `model-map.json`. Normal c-thru sessions
also inject fleet agents via `--agents` and do not require discovery.

### Client features the proxy cannot re-enable

With a non-first-party `ANTHROPIC_BASE_URL`, Claude Code itself disables or
defaults-off several features (see env-vars docs). Operators may opt back in:

| Feature | Client default on gateway | Operator note |
|---|---|---|
| Remote Control | Off (≥2.1.196) | By design; not a proxy gap |
| MCP tool search | Off | Set `ENABLE_TOOL_SEARCH=true` if the proxy/upstream forwards `tool_reference` blocks (c-thru Anthropic path does) |
| Fine-grained tool streaming | Off | `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1` |
| Adaptive thinking | Sent for current Claude models | Anthropic OK; non-Anthropic may 400 → `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` |

### Proxy-native control plane (not Anthropic)

These URIs are c-thru operator/hooks surfaces, not Claude API:

- `GET /ping`, `HEAD /`
- `GET /c-thru/status|recent|dashboard`, plan dashboards
- `POST /c-thru/mode|reload|stats/clear`
- `POST /hooks/context` — control-plane cheatsheet for hooks. **Long** payload
  (endpoint list + brief when-to-query) for SessionStart/PreCompact/empty body;
  **short** (endpoint list only) when the body has a non-empty `prompt`
  (UserPromptSubmit / `c-thru-classify`). See `docs/headers.md` for
  `x-c-thru-served-by` / `x-c-thru-resolved-via` (prefer those over guessing).
- Session identity prefix: `/s/<session-id>/…` stripped before dispatch

Response observability: `docs/headers.md` (`x-c-thru-*`).

### Rare / catch-all (Claude Code seldom hits via local proxy)

Batches, Files, Skills, Agents, Sessions (incl. `GET …/stream`), Environments,
Vaults, OAuth, org/admin, usage reports — see endpoint matrix. Pattern:
`ANTHROPIC_ONLY_PATHS` → Anthropic catch-all when configured, else structured
501. Long-lived session SSE skips the catch-all idle timeout when
`Accept: text/event-stream` is present.

---

## Endpoint coverage

| Path | Method(s) | Anthropic | Gemini | Ollama | OpenAI |
|---|---|---|---|---|---|
| `/v1/messages` (non-stream) | POST | ✅ | ✅ | ✅ | 🚫 |
| `/v1/messages` (stream) | POST | ✅ | ✅ | ✅ | 🚫 |
| `/v1/messages/count_tokens` | POST | ✅ (passthrough) | ✅ (`:countTokens`) | ✅ (proxy-side estimate) | 🚫 |
| `/v1/messages/batches` | POST | ⚠️ catch-all → Anthropic | ➖ no native batch API | ➖ | 🚫 |
| `/v1/messages/batches` (list) | GET | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/messages/batches/{id}` | GET | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/messages/batches/{id}/results` | GET | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/messages/batches/{id}/cancel` | POST | ⚠️ catch-all → Anthropic | ➖ | ➖ | 🚫 |
| `/v1/messages/batches/{id}` | DELETE | 🔁 catch-all → Anthropic (live-verified[^live]) | ➖ | ➖ | 🚫 |
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
| `/v1/organizations/me` | GET | 🔁 catch-all → Anthropic (live-verified[^live]) | ➖ | ➖ | 🚫 |
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

[^live]: Live-verified by `test/anthropic-api-coverage-live.test.js` against
real `api.anthropic.com` through the proxy. Opt-in: requires
`C_THRU_LIVE_ANTHROPIC=1` and `ANTHROPIC_API_KEY`; default suite skips. Run
via `make test-live`. Asserts `x-c-thru-passthrough: 1` response header,
upstream-shape error bodies (`error.type: "not_found_error"`),
DELETE method propagation through the catch-all forwarder, and
`anthropic-beta` header round-trip without 400.

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
| `citations[]` field on text | ✅ (passthrough) | ⚠️ stripped on translate to `parts[].text`; gap recorded as `text.citations` | ⚠️ unknown | 🚫 stripped |

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
   in the `lib.request({…, method: req.method, …})` call. **Status: 🔁 for
   DELETE** — `test/anthropic-api-coverage-live.test.js` exercises
   `DELETE /v1/messages/batches/<bogus>` against live Anthropic and asserts
   the upstream `error.type: "not_found_error"` is returned. PATCH remains
   ⚠️ (no live exerciser yet).

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
   were dropped. Documented in `docs/headers.md`. The recorded vocabulary
   includes:
   - Unhandled content-block types verbatim (`redacted_thinking`,
     `server_tool_use`, `web_search_tool_result`, `web_fetch_tool_result`,
     `code_execution_tool_result`, `tool_search_tool_result`, `mcp_tool_use`,
     `mcp_tool_result`, `container_upload`, …).
   - `text.citations` — emitted when an inbound `text` block carries a
     `citations` field that Gemini's request shape cannot represent.
   - `tool:<server-tool-type>` — emitted for each entry in `tools[]` whose
     `type` is set and not `"custom"` (e.g. `tool:web_search_20250305`,
     `tool:code_execution_20250522`). Indicates that an Anthropic server tool
     was declared but `mapAnthropicToGemini` only forwards `functionDeclarations`
     — the server-tool semantics are not translated.

### Allowlist / denylist

The catch-all forwarder honors two optional top-level keys on
`model-map.json`, both arrays of regex strings matched against `req.url`:

```json
{
  "passthrough_allowlist": ["^/v1/oauth/", "^/v1/messages/batches"],
  "passthrough_denylist":  ["^/v1/audit_logs", "^/v1/admin/"]
}
```

Behavior:

- `passthrough_denylist` is checked first; any regex match returns a
  structured 403 (`{type:"error", error:{type:"forbidden_error", message:"path matches passthrough_denylist"}}`)
  and emits `proxyLog('passthrough_denied', { url, matched })`.
- `passthrough_allowlist`, when non-empty, requires a regex match; otherwise
  the same 403 is returned with message `path does not match passthrough_allowlist`.
- Both lists absent or empty → unrestricted passthrough (current default).

These are advisory escape hatches for hardening multi-tenant or shared
workstations — the gate philosophy remains "answer everything by default."
Combine with the `CLAUDE_PROXY_BIND` startup warning (proxy emits a stderr
WARN at listen time when `ANTHROPIC_API_KEY` is set AND the bind address is
non-loopback) for the full ambient-key safety net.

---

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
- `make test` passes (includes `test/anthropic-api-coverage.test.js` and
  `test/proxy-gateway-protocol.test.js` for the Claude Code gateway contract pins).
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
