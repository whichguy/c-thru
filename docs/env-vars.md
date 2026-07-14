# Environment Variables

Environment variables that affect c-thru routing, proxy behavior, and Ollama integration.

| Variable | Effect |
|---|---|
| `CLAUDE_PROXY_BYPASS=1` | Skip proxy entirely — use transparent Anthropic path |
| `C_THRU_DEBUG=1` | Print resolved env to stderr |
| `C_THRU_DEBUG=2` | + proxy port, OLLAMA vars, route keys |
| `CLAUDE_PROXY_DEBUG=1/2` | Proxy-side verbose logs |
| `CLAUDE_PROFILE_DIR` | Override `~/.claude` location |
| `CLAUDE_MODEL_MAP_DEFAULTS_PATH` | Override shipped `config/model-map.json` path |
| `CLAUDE_MODEL_MAP_OVERRIDES_PATH` | Override `~/.claude/model-map.overrides.json` path |
| `CLAUDE_PROXY_LOG_FILE` | Override ops log path (default `~/.claude/proxy.log`). Structured request/error events append here. |
| `CLAUDE_PROXY_LOG_MAX_BYTES` | Size threshold for ops-log rotation into `proxy.log.old` (default `10485760` = 10 MiB). Previous `.old` is replaced. |
| `CLAUDE_PROXY_LOG_MAX_AGE_DAYS` | Drop ops-log lines older than this many days (default **14**). Also deletes `proxy.log.old` when its mtime is older than the max age. Enforced on proxy startup and about hourly on the write path. |
| `CLAUDE_PROXY_LOG_AGE_PRUNE_INTERVAL_MS` | Min interval between age-prune rewrites on the hot path (default `3600000` = 1 hour). Startup always force-prunes. |
| `CLAUDE_PROXY_JOURNAL=1` | Enable per-request JSONL journaling to `~/.claude/journal/YYYY-MM-DD/<capability>.jsonl`. Off by default. Captures full request + response bodies (auth headers scrubbed). Privacy-sensitive — see `docs/journaling.md`. |
| `CLAUDE_PROXY_JOURNAL_DIR` | Override default journal directory |
| `CLAUDE_PROXY_JOURNAL_INCLUDE` | Comma-separated capabilities to journal (default: all) |
| `CLAUDE_PROXY_JOURNAL_EXCLUDE` | Comma-separated capabilities to skip even when journaling is on |
| `CLAUDE_PROXY_JOURNAL_MAX_BYTES` | Per-file size cap before rotation (default 100 MB) |
| `CLAUDE_PROXY_RECENT_MAX` | Cap on the in-memory recent-requests ring served by `GET /c-thru/recent` and the dashboard (default `256`, `0` disables). Per-instance, never persisted — restart empties it. |
| `CLAUDE_LLM_MEMORY_GB` | Override RAM detection for hardware-tier selection (positive integer GB). Malformed values fall through to `os.totalmem()`. |
| `CLAUDE_LLM_MODE` | Override routing mode (5 modes): `best-cloud` \| `best-cloud-oss` \| `best-local-oss` \| `best-cloud-gov` \| `best-local-gov`. `best-cloud`: Anthropic/cloud models, local at 64+ GB. `best-cloud-oss`: OSS cloud via OpenRouter (DeepSeek, Kimi, Qwen). `best-local-oss`: fully local (Phi, Qwen, Devstral). `best-cloud-gov`: USGov compliant cloud (non-Chinese-origin). `best-local-gov`: USGov compliant local (Phi, GPT-OSS). Legacy `CLAUDE_CONNECTIVITY_MODE` still accepted. |
| `GOOGLE_API_KEY` | API key for Google AI Studio Gemini endpoint (`endpoints.gemini_ai`). Sent as `x-goog-api-key`. |
| `XAI_API_KEY` | API key for xAI Grok (`endpoints.xai`, models `grok` / `grok-4.5`). Sent as `Authorization: Bearer`. Never forwards the client's Anthropic credentials to `api.x.ai`. Required for the `grok` brand agent and for any capability cell that resolves to `grok-4.5` (e.g. `generalist`/`writer` under `best-cloud-gov` at 32gb+). **Not** required for the separate Grok Build CLI path when `grok login` has populated `~/.grok/auth.json` (see Grok surfaces in `docs/agent-architecture.md`). |
| `C_THRU_LIVE_XAI=1` | When set with `XAI_API_KEY`, enables `test/proxy-xai-live.test.js` (C1–C5: non-stream, stream, tools multi-turn, identity, proxy `model:grok`). **Deprecation canary** for xAI’s Anthropic Messages compatibility surface — not part of hermetic `make test`. Run periodically: `C_THRU_LIVE_XAI=1 node test/proxy-xai-live.test.js`. |
| `CLAUDE_PROXY_PING_INTERVAL_MS` | Cadence for proxy-injected `event: ping` SSE frames on translate streams (default `15000`). Keeps intermediate hops alive during long generations. |

### Claude Code client vars (gateway / c-thru)

These are read by the **Claude Code binary**, not by `claude-proxy`. They matter when
`c-thru` sets `ANTHROPIC_BASE_URL` to the local proxy (a non-first-party host). Full
list: [Claude Code env-vars](https://code.claude.com/docs/en/env-vars). Gateway contract:
[llm-gateway-protocol](https://code.claude.com/docs/en/llm-gateway-protocol).

| Variable | Effect when using c-thru |
|---|---|
| `ANTHROPIC_BASE_URL` | Set by `c-thru` to the proxy (often with `/s/<session-id>` prefix). Routes all Messages traffic through the proxy. |
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | Credential Claude Code sends to the proxy; proxy rewrites outbound auth per endpoint (`applyOutboundAuth`). |
| `ENABLE_TOOL_SEARCH=true` | Re-enables MCP tool search. Off by default on non-first-party base URLs. Safe with c-thru: Anthropic passthrough does not strip `tool_reference` blocks (pinned in `test/proxy-gateway-protocol.test.js`). |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` | Opt-in: Claude Code GETs the proxy’s `/v1/models` and adds matching IDs to `/model`. Only IDs starting with `claude` or `anthropic` are kept — use `claude-via-*` aliases (default endpoints: `gemini_ai`, `gemini_vertex`, `xai`). |
| `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1` | Opt-in fine-grained tool streaming (off by default on custom base URL). |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` | Stops sending `thinking: {type:"adaptive"}` — useful if a non-Anthropic upstream 400s on adaptive. |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | Suppresses pre-release body fields/betas that some non-Anthropic upstreams reject. |
| `API_FORCE_IDLE_TIMEOUT` | Client-side stream idle abort (default active on gateways, ~5 min). Aligns roughly with proxy `STREAM_STALL_HARDFAIL_MS`. |
| `API_TIMEOUT_MS` | Overall API request timeout (default 10 min). |
| `GOOGLE_CLOUD_TOKEN` | Bearer token for Vertex AI Gemini endpoint (`endpoints.gemini_vertex`). Refresh with `gcloud auth print-access-token`. |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID, interpolated into `endpoints.gemini_vertex.url` at config load via `${VAR}` substitution. Required to use the `gemini_vertex` endpoint. |
| `GOOGLE_CLOUD_REGION` | GCP region (e.g. `us-central1`), interpolated into `endpoints.gemini_vertex.url` at config load. Required to use the `gemini_vertex` endpoint. |
| `OLLAMA_BASE_URL` | Ollama daemon base URL (default `http://localhost:11434`). Aliased internally as `OLLAMA_URL`. Used by `claude-proxy` for backend requests and by `c-thru` for reachability checks and autostart. |
| `C_THRU_OLLAMA_AUTOSTART` | `1` (default) — start Ollama automatically when unreachable. Set to `0` to disable autostart (useful when Ollama is managed externally or in CI). |
| `C_THRU_SKIP_PREPULL` | Set to `1` to skip bulk pre-pull of active-tier Ollama models on router startup. Intended for CI and scripting. |
| `C_THRU_PLUGIN_PORT` | Fixed port for the plugin-mode proxy (default `10017`). Used when `c-thru-session-start.sh` seeds the first-run config and needs a stable `ANTHROPIC_BASE_URL`. |
| `C_THRU_PLAN_PAGE=0` | Disable the PostToolUse/ExitPlanMode plan-visibility hook entirely. |
| `C_THRU_PLAN_AUTOOPEN=0` | Continue spooling approved plans but never auto-open the local dashboard browser page. |
| `C_THRU_PLAN_SPOOL` | Override the plan event/snapshot/narrative spool directory (primarily useful for isolated tests). |

## Ops log location and retention

Canonical path: **`~/.claude/proxy.log`** (override with `CLAUDE_PROXY_LOG_FILE`). Session dirs often symlink `proxy.log` → that file. Retention: **no line older than 14 days** (configurable via `CLAUDE_PROXY_LOG_MAX_AGE_DAYS`), plus size rotate at 10 MiB into `proxy.log.old` (`CLAUDE_PROXY_LOG_MAX_BYTES`).

## xAI / brand-agent forensics (proxy.log)

When the anthropic-forward path hits a non-2xx upstream (including **400**, which does not enter the fallback chain), the proxy emits `anthropic.upstream.error` with `message`, truncated `body_preview`, `agent`, `tools_in`, and `xai` flags. Midstream SSE failures log `anthropic.upstream.midstream_error` with `client_cancelled` (true = our disconnect teardown) plus the same forensics fields. Inspect:

```sh
rg 'anthropic\.upstream\.(error|midstream_error)|xai\.sanitize' ~/.claude/proxy.log | tail
```

## CI / Testing Variables

| Variable | Effect |
|---|---|
| `C_THRU_NO_UPDATE=1` | Skip the best-effort git self-update at startup (CI/scripting). |
| `C_THRU_NO_STATUSLINE=1` | Do not inject the default `statusLine` when the user has none (ephemeral launch only). Custom user statusLines are never overridden. |
| `C_THRU_STATUSLINE_OVERLAY=0` | Default bar only (`model \| cwd`); skip `/c-thru/recent` stats, fallback badge, and dash hint. |
| `C_THRU_STATUSLINE_DASH=0` | Hide the plain-text `dash :PORT/c-thru/dashboard` hint on the default statusline. |
| `C_THRU_UPDATE_INTERVAL` | Seconds between self-update fetches (default `3600`). Debounced via `.git/FETCH_HEAD` mtime. |
| `C_THRU_UPDATE_GRACE` | Seconds the self-update fetch may run before being killed (default `1`). Tests raise it so a loaded machine can't kill the fetch before its diverged advisory is written. |
| `C_THRU_BEHAVIORAL_TESTS=1` | Enable behavioral contract tests (`agent-contract-behavioral.test.js`). Requires a running proxy. |
| `BEHAVIORAL_ONLY` | Comma-separated agent name filter for behavioral test suite (e.g. `auditor,planner`). |
| `C_THRU_JUDGE=1` | Enable cloud-judge semantic validation in behavioral tests. Requires `ANTHROPIC_API_KEY`. Each agent response is evaluated by `judge-evaluator` (cloud tier); VERDICT=FAIL is a hard failure. |
| `C_THRU_LIVE_AGENT_TESTS=1` | Enable live agent contract smoke tests (`agent-contract-live.test.js`). |
