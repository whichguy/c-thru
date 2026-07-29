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
| `OPENAI_API_KEY` | API key for OpenAI Responses endpoint (`call_style: "openai"`). Sent as `Authorization: Bearer`. Missing or invalid key transparently falls back to the configured global default model rather than failing loudly, matching every other backend. |
| `C_THRU_LIVE_OPENAI=1` | With `OPENAI_API_KEY`, enables `test/proxy-openai-live-shapes.test.js` (non-stream, stream, proxy-side count estimate, and one tool call). Not part of hermetic `make test`. |
| `XAI_API_KEY` | Metered API key for xAI Responses (`endpoints.xai`; models such as `grok` / `grok-4.5`). Sent as `Authorization: Bearer`; client Anthropic credentials and raw Claude correlation headers are never forwarded to `api.x.ai`. Required for the `grok` brand leaf and any capability cell that resolves to `grok-4.5`. **Not** required for the separate Grok Build CLI path when CLI login has populated local Grok auth; that login cannot be reused as an API credential. |
| `C_THRU_LAUNCH_DEFAULT_MODEL` | Set automatically by `c-thru --model <X>` / `cthru agents --model <X>` when spawning the proxy (seed). Live value is **in-memory only** inside claude-proxy; keep-alive reuse updates via `POST /c-thru/launch-default`. Used as **`routes.default` last-resort** and **`generalist` capability** target. Not written to config or stamp files. |
| `C_THRU_LIVE_XAI=1` | When set with `XAI_API_KEY`, enables `test/proxy-xai-live.test.js` (direct Responses non-stream/SSE/tool continuation and proxy xAI identity checks). Not part of hermetic `make test`. |
| `CLAUDE_PROXY_PING_INTERVAL_MS` | Cadence for proxy-injected `event: ping` SSE frames on translate streams (default `15000`). Keeps intermediate hops alive during long generations. |
| `CLAUDE_PROXY_RESPONSES_TIMEOUT_MS` | Socket-inactivity timeout for OpenAI-compatible Responses upstreams, including xAI (default `3300000` = 55 minutes). Activity rearms it; it is not an absolute generation or test duration. The default reserves five minutes for teardown inside the one-hour outer ceiling; model-backed tests remain hard-capped by `C_THRU_MODEL_TEST_TIMEOUT_MS`. |
| `RESPONSES_REASONING_CACHE_MAX_ENTRIES` | Maximum opaque encrypted-reasoning continuations retained per proxy process (default `1000`, hard maximum `10000`). Invalid, zero, negative, or oversized values use the safe default. |
| `RESPONSES_REASONING_CACHE_TTL_MS` | Lifetime of an opaque Responses reasoning continuation (default `3600000` = 1 hour, hard maximum 24 hours). |
| `RESPONSES_REASONING_CACHE_MAX_ITEM_BYTES` | Maximum serialized size of one cached reasoning continuation (default 1 MiB, hard maximum 8 MiB). Oversized items fall back to stateless tool continuation. |
| `RESPONSES_REASONING_CACHE_MAX_BYTES` | Aggregate process-local encrypted-reasoning cache ceiling (default 64 MiB, hard maximum 256 MiB). Oldest entries are evicted first when either this or the entry-count bound is reached. |

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
| `CLAUDE_PROXY_OLLAMA_KEEP_ALIVE` | How long Ollama should keep a loaded model resident (default `60m`). Passed as `keep_alive` on Ollama generate/chat requests from the proxy. |
| `C_THRU_SKIP_PREPULL` | Set to `1` to skip bulk pre-pull of active-tier Ollama models on router startup. Intended for CI and scripting. |
| `C_THRU_PLUGIN_PORT` | Fixed port for the plugin-mode proxy (default `10017`). Used when `c-thru-session-start.sh` seeds the first-run config and needs a stable `ANTHROPIC_BASE_URL`. |
| `C_THRU_PLAN_PAGE=0` | Disable the PostToolUse/ExitPlanMode plan-visibility hook entirely. |
| `C_THRU_PLAN_AUTOOPEN=0` | Continue spooling approved plans but never auto-open the local dashboard browser page. |
| `C_THRU_PLAN_SPOOL` | Override the plan event/snapshot/narrative spool directory (primarily useful for isolated tests). |
| `C_THRU_KEEP_PROXY=1` | Leave `claude-proxy` running on EXIT (brand `cthru agents` defaults this so agent-view workers keep their gateway). Opt out: `C_THRU_KEEP_PROXY=0`. |
| `C_THRU_BRAND_REUSE_GATEWAY_PROXY=0` | Disable reusing the durable gateway’s live proxy port on brand `agents` open (default **reuse** when `/ping` answers). Without reuse every open gets a new dynamic port and thrash-recycles live brand jobs. |
| `C_THRU_NO_RESURRECT=1` | Disable same-port proxy ensure (SessionStart / UPS health / StopFailure). |
| `C_THRU_NO_SESSION_REVIVE=1` | Skip brand-agent session revive (`c-thru-revive-agent-sessions.sh`) on `cthru agents`. |
| `C_THRU_REVIVE_ALL=1` | Also revive jobs in terminal states (`done`/`stopped`/`failed`). Default: only `working`/`blocked`. |
| `C_THRU_REVIVE_MAX` | Cap `claude respawn` calls per revive run (default `20`). |
| `C_THRU_REVIVE_DRY_RUN=1` | Log revive candidates without patching state or respawning. |
| `C_THRU_AGENT_GATEWAY_DIR` | Override staged gateway profile dir (default `~/.claude/c-thru-agent-gateway`). Shared across brand jobs; `settings.env.ANTHROPIC_BASE_URL` is always **unscoped** (`http://127.0.0.1:<port>`, never `/s/<id>`). |
| `C_THRU_REVIVE_SKIP_AGENTS_JSON=1` | Skip the budgeted `claude agents --json` live probe (tests / slow CLI). |
| `C_THRU_CC_DAEMON_DIR` | Override daemon root for rv-sock live detect (default: scan `/tmp/cc-daemon-*`). |

Brand-agent gateway auth: `settings.apiKeyHelper` points at `c-thru-gateway-auth-helper` (install symlink under `~/.claude/tools/`). Claude runs it per request so attach/resume does not depend on a frozen `ANTHROPIC_AUTH_TOKEN=ollama`. The helper never prints placeholders; it prefers process env OAuth, then keychain/`Claude Code-credentials`, then a prior real token in gateway settings.

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
| `C_THRU_NO_MARKETPLACE_UPDATE=1` | Skip the best-effort third-party CLI marketplace/plugin refresh (CI/scripting). |
| `C_THRU_NO_STATUSLINE=1` | Do not inject the default `statusLine` when the user has none (ephemeral launch only). Custom user statusLines are never overridden. |
| `C_THRU_STATUSLINE_OVERLAY=0` | Default bar only (`model \| cwd`); skip `/c-thru/recent` stats, fallback badge, and dash hint. |
| `C_THRU_STATUSLINE_DASH=0` | Hide the plain-text `dash :PORT/c-thru/dashboard` hint on the default statusline. |
| `C_THRU_UPDATE_INTERVAL` | Seconds between self-update fetches (default `3600`). Debounced via `.git/FETCH_HEAD` mtime. |
| `C_THRU_MARKETPLACE_UPDATE_INTERVAL` | Seconds between third-party CLI marketplace/plugin refreshes (default `21600`). Debounced via the durable `.c-thru-marketplace-update-stamp` mtime. |
| `C_THRU_UPDATE_GRACE` | Seconds the self-update fetch may run before being killed (default `1`). Tests raise it so a loaded machine can't kill the fetch before its diverged advisory is written. |
| `C_THRU_BEHAVIORAL_TESTS=1` | Enable behavioral contract tests (`agent-contract-behavioral.test.js`), which own a managed proxy and require multiple role-specific evidence signals per response. |
| `BEHAVIORAL_ONLY` | Comma-separated agent name or case-ID filter for the behavioral suite (e.g. `planner,coder-clamp-function`). |
| `C_THRU_LIVE_AGENT_TESTS=1` | Enable live agent contract smoke tests (`agent-contract-live.test.js`). |
| `C_THRU_TEST_TIMEOUT_SECONDS` | Hard wall-clock budget for an aggregate test command and each supervised child suite, in whole seconds. Defaults to and may not exceed `3600`; a valid inherited supervisor deadline can shorten but never extend it. TERM/KILL applies only to the invocation's owned process group. Scheduled jobs use `3300` within a separate 70-minute job lifecycle, leaving 15 minutes for setup, cleanup, and upload without lengthening any test command. |
| `C_THRU_TEST_LOCK_ROOT` | Test-only override for the full-run exclusivity lock root. By default, full runs share the stable private `$HOME/.claude/c-thru-run-locks` root, independent of per-run `TMPDIR`; the runner creates that root as `0700`. An override must name an existing, owner-owned, non-symlink directory with mode `0700`. The fixed `c-thru-run-all.lock` leaf retains stale-PID recovery and is removed on exit without touching sibling paths. |
| `C_THRU_TEST_FAILURE_LOG_DIR` | Optional exact destination directory for raw failing-suite output. It must be a non-existing, direct `c-thru-runall-*` child of an owner-controlled or sticky resolved `TMPDIR`; `run-all.sh` creates it exclusively as `0700`, exports and prints the accepted path, and publishes collision-safe `0600` log files without replacing pre-existing files or following symlinks. When omitted, a unique private directory is allocated with `mktemp`. Scheduled CI uploads only the exact per-run directory on failure, only for private repositories, and retains it for one day; public repositories leave it on the ephemeral runner. These logs are unsanitized diagnostic data: artifact upload crosses from private filesystem modes into the repository's Actions-artifact access boundary. |
| `C_THRU_TEST_EVIDENCE_PATH` | Absolute destination for the aggregate's versioned, sanitized JSON evidence. The runner writes it atomically and incrementally so partial state survives timeout; if omitted, it allocates a private `0700` temporary directory. Concurrent runs must use distinct paths. |
| `C_THRU_LIVE_SHARD=provider\|agent` | Run only the selected live registry and suppress ordinary deterministic suites. `make test-live-shard SHARD=provider\|agent` sets this for scheduled CI; invalid values fail before any suite starts. |
| `C_THRU_MODEL_TEST_TIMEOUT_MS` | Shared model-operation watchdog in milliseconds. Defaults to and may not exceed `3600000` (one hour) in model-backed tests. |
| `C_THRU_OFFLOAD_TIMEOUT` | Per-prompt timeout for `agent-offload-coverage.js`, in whole seconds. Defaults to the shared model timeout and may not exceed `3600` (one hour). |
| `C_THRU_OFFLOAD_ARTIFACTS=1` | Select exactly the six generated PNG/PDF/50K+-context offload fixtures. Prefer `make test-live-artifacts`, which also pins the intended `best-cloud`/`32gb` multimodal route and applies the 3,300-second test-command cap. `C_THRU_OFFLOAD_ONLY` can narrow but cannot cross between the normal and artifact lanes. |
| `C_THRU_OFFLOAD_EVIDENCE_PATH` | Absolute destination for the sanitized `c-thru.agent-offload` schema v2 scorecard. It contains a run UUID, fixture IDs, expected/selected agents, classifications, route-proof booleans, requested/effective mode and profile, stable parent route/model/backend identity, sanitized per-fixture dispatch observations, and hashes—not prompts, raw model output, transcripts, credentials, or tokens. An enabled campaign allocates and prints a private `0700` temporary destination when omitted. |
| `C_THRU_OFFLOAD_GATE=1` | Explicit compatibility opt-in that makes one offload campaign's quality threshold process-blocking. Integrity and route-proof failures always block. Scheduled CI intentionally leaves single-run quality advisory; use pooled evidence for promotion decisions. |
| `C_THRU_STRICT_LIVE_PROVIDERS=1` | Require every explicitly requested live-provider or live-agent suite to report a machine-readable terminal outcome. Missing credentials, quota/billing blocks, mandatory skips, missing outcome markers, and integrity failures make the aggregate fail instead of appearing green. Both `make test-live-shard` and `make test-live-all` enable this. |
