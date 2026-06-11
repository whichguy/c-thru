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
| `CLAUDE_PROXY_JOURNAL=1` | Enable per-request JSONL journaling to `~/.claude/journal/YYYY-MM-DD/<capability>.jsonl`. Off by default. Captures full request + response bodies (auth headers scrubbed). Privacy-sensitive — see `docs/journaling.md`. |
| `CLAUDE_PROXY_JOURNAL_DIR` | Override default journal directory |
| `CLAUDE_PROXY_JOURNAL_INCLUDE` | Comma-separated capabilities to journal (default: all) |
| `CLAUDE_PROXY_JOURNAL_EXCLUDE` | Comma-separated capabilities to skip even when journaling is on |
| `CLAUDE_PROXY_JOURNAL_MAX_BYTES` | Per-file size cap before rotation (default 100 MB) |
| `CLAUDE_PROXY_CLASSIFY=1` | Phase A dynamic classifier (observe-only): runs a small classifier on each prompt, surfaces predicted role in `x-c-thru-classified-role` header + journal. See `docs/dynamic-classification-phase-a.md`. |
| `CLAUDE_PROXY_CLASSIFY_MODEL` | Classifier model tag (default `gemma4:e2b`) |
| `CLAUDE_PROXY_CLASSIFY_OLLAMA_URL` | Where to send classifier requests (default `OLLAMA_BASE_URL` or `localhost:11434`) |
| `CLAUDE_PROXY_CLASSIFY_TIMEOUT_MS` | Classifier hard timeout (default 5000) |
| `CLAUDE_LLM_MEMORY_GB` | Override RAM detection for hardware-tier selection (positive integer GB). Malformed values fall through to `os.totalmem()`. |
| `CLAUDE_LLM_MODE` | Override routing mode (5 modes): `best-cloud` \| `best-cloud-oss` \| `best-local-oss` \| `best-cloud-gov` \| `best-local-gov`. `best-cloud`: Anthropic/cloud models, local at 64+ GB. `best-cloud-oss`: OSS cloud via OpenRouter (DeepSeek, Kimi, Qwen). `best-local-oss`: fully local (Phi, Qwen, Devstral). `best-cloud-gov`: USGov compliant cloud (non-Chinese-origin). `best-local-gov`: USGov compliant local (Phi, GPT-OSS). Legacy `CLAUDE_CONNECTIVITY_MODE` still accepted. |
| `GOOGLE_API_KEY` | API key for Google AI Studio Gemini endpoint (`endpoints.gemini_ai`). Sent as `x-goog-api-key`. |
| `GOOGLE_CLOUD_TOKEN` | Bearer token for Vertex AI Gemini endpoint (`endpoints.gemini_vertex`). Refresh with `gcloud auth print-access-token`. |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID, interpolated into `endpoints.gemini_vertex.url` at config load via `${VAR}` substitution. Required to use the `gemini_vertex` endpoint. |
| `GOOGLE_CLOUD_REGION` | GCP region (e.g. `us-central1`), interpolated into `endpoints.gemini_vertex.url` at config load. Required to use the `gemini_vertex` endpoint. |
| `OLLAMA_BASE_URL` | Ollama daemon base URL (default `http://localhost:11434`). Aliased internally as `OLLAMA_URL`. Used by `claude-proxy` for backend requests and by `c-thru` for reachability checks and autostart. |
| `C_THRU_OLLAMA_AUTOSTART` | `1` (default) — start Ollama automatically when unreachable. Set to `0` to disable autostart (useful when Ollama is managed externally or in CI). |
| `C_THRU_SKIP_PREPULL` | Set to `1` to skip bulk pre-pull of active-tier Ollama models on router startup. Intended for CI and scripting. |
| `C_THRU_PLUGIN_PORT` | Fixed port for the plugin-mode proxy (default `10017`). Used when `c-thru-session-start.sh` seeds the first-run config and needs a stable `ANTHROPIC_BASE_URL`. |

## CI / Testing Variables

| Variable | Effect |
|---|---|
| `C_THRU_NO_UPDATE=1` | Skip the best-effort git self-update at startup (CI/scripting). |
| `C_THRU_UPDATE_INTERVAL` | Seconds between self-update fetches (default `3600`). Debounced via `.git/FETCH_HEAD` mtime. |
| `C_THRU_BEHAVIORAL_TESTS=1` | Enable behavioral contract tests (`agent-contract-behavioral.test.js`). Requires a running proxy. |
| `BEHAVIORAL_ONLY` | Comma-separated agent name filter for behavioral test suite (e.g. `auditor,planner`). |
| `C_THRU_JUDGE=1` | Enable cloud-judge semantic validation in behavioral tests. Requires `ANTHROPIC_API_KEY`. Each agent response is evaluated by `judge-evaluator` (cloud tier); VERDICT=FAIL is a hard failure. |
| `C_THRU_LIVE_AGENT_TESTS=1` | Enable live agent contract smoke tests (`agent-contract-live.test.js`). |
