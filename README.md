# c-thru

**Transparent, hardware-aware LLM routing for Claude Code.**

`c-thru` is a proxy and routing layer that sits between Claude Code and your LLM backends. Use local models (Ollama), open-source cloud providers (OpenRouter, DeepSeek, Kimi), or Google Gemini — all within an unmodified Claude Code session, with automatic hardware-tier selection and fallback.

---

## Quick Start

### Plugin install (recommended)

```
/plugin marketplace add whichguy/claude-craft
/plugin install c-thru@claude-craft
```

The plugin is self-contained — no git clone or `install.sh` required. The SessionStart hook seeds your model-map config, starts the proxy, and registers `ANTHROPIC_BASE_URL`. **Restart Claude Code once** to activate routing.

### CLI install

```bash
git clone https://github.com/whichguy/c-thru.git
cd c-thru
./install.sh
```

The installer symlinks `tools/` into `~/.claude/tools/` and seeds your default model maps.

### Verify

```bash
bash -n tools/c-thru                              # bash syntax check
node --check tools/claude-proxy                   # node syntax check
node tools/model-map-validate.js config/model-map.json
~/.claude/tools/c-thru list                       # runtime smoke-test
make test-fast                                    # proxy + model-map test suite (~2 min)
make test                                         # full suite including smoke tests
```

### Configure backends

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENROUTER_API_KEY="sk-or-..."
export GOOGLE_API_KEY="..."          # Gemini AI Studio
```

Local Ollama is used automatically when reachable (`http://localhost:11434`).

---

## What c-thru Does

Claude Code is tied to cloud-hosted Anthropic models. `c-thru` breaks that constraint:

- **Hardware-aware routing** — detects your system RAM and selects appropriately-sized models per tier (16 GB → 128 GB+)
- **Agent fleet** — 12 pipeline agents + 8 utility agents, each bound to a capability alias resolved to a concrete model at request time
- **Protocol translation** — Anthropic Messages API → Ollama `/v1/messages` (Ollama 0.4+), preserving tool use, multi-turn conversations, and thinking blocks. Full Anthropic↔Gemini translation for Google backends.
- **Fallback chains** — transparent retry against a fallback backend on 5xx/429/network errors; cycle detection resets on SIGHUP config reload
- **Hybrid routing** — your planner runs on Claude Sonnet (cloud) while your coder runs on a local Qwen3.6 in the same session

---

## Architecture

### Request flow

```
c-thru (bash)
  ├─ selects active model-map (CLAUDE_MODEL_MAP_PATH → project/.claude/ → ~/.claude/model-map.json)
  ├─ resolves route → backend → env vars
  ├─ for cloud backends: exec's claude directly (transparent path, no proxy)
  └─ for local/proxy backends: spawns claude-proxy (HTTP server on a free port)
       ├─ resolves capability alias → llm_profiles[capability][mode][tier] → concrete model
       ├─ rewrites: model field, URL, auth headers, model_overrides, @sigil stripping
       ├─ translates protocol (Anthropic→Gemini where needed)
       └─ forwards to backend; injects x-c-thru-resolved-via response header
```

### Two-component design

**`tools/c-thru`** (bash, 2300+ lines) — the entrypoint. Selects config, resolves routes, manages Ollama lifecycle, injects agent fleet + MCP server, exec's claude.

**`tools/claude-proxy`** (Node.js, stdlib only) — long-running HTTP server. Handles capability resolution, model rewriting, auth, fallback chains, SIGHUP config reload, and protocol translation.

### Directory layout

```
tools/
  c-thru                  bash entrypoint
  claude-proxy             Node.js proxy server (zero external deps)
  model-map-layered.js     3-tier config merge
  model-map-validate.js    schema validator
  hw-profile.js            5-tier hardware detection (tierForGb)
  llm-capabilities-mcp.js  MCP server: list_models + classify_intent
config/
  model-map.json           shipped defaults
  recommended-mappings.json  community recommendations (lowest precedence)
test/
  run-all.sh               full test suite runner
  *.test.js / *.test.sh    individual suites
```

---

## Agent Fleet

All 20 agents declare `model: <agent-name>` in their frontmatter. The proxy resolves `agent-name → agent_to_capability → llm_profiles[capability][mode][tier] → concrete model` at request time. No agent file is modified when you change model assignments.

### 12 pipeline agents (planner → coder → tester → reviewer flow)

| Agent | Role | Cloud (best-cloud) | Local 64gb (best-local-oss) |
|---|---|---|---|
| `planner` | High-stakes planning | claude-sonnet-4-6 | qwen3.6:35b |
| `planner-hard` | Hardest planning, always best available | claude-opus-4-7 | qwen3.6:35b |
| `explore` | Fast read-only search | gemini-pro-latest | qwen3.6:35b-a3b-coding-nvfp4 |
| `coder` | Primary coding | gemini-pro | qwen3.6:35b-a3b-coding-nvfp4 |
| `coder-fallback` | Backup coder, different training distribution | gemini-pro-latest | qwen3-coder-next:latest |
| `tester` | Test generation | gemini-pro | qwen3.6:35b-a3b-coding-nvfp4 |
| `docs` | Documentation writing | gemma4:26b | qwen3.6:35b |
| `code-reviewer` | Routine code review | claude-sonnet-4-6 | qwen3.6:35b |
| `reviewer-security` | Security review (`hard_fail` on error) | claude-opus-4-7 | qwen3.6:35b |
| `debugger-hypothesis` | Parallel hypothesis testing | gemini-pro | qwen3.6:35b |
| `debugger-investigate` | Deep investigation | gemini-pro | qwen3.6:35b-a3b-coding-nvfp4 |
| `debugger-hard` | Hard debugging, always best available | claude-opus-4-7 | qwen3.6:35b |

### 8 utility agents

| Agent | Role |
|---|---|
| `vision` | Image/screenshot analysis |
| `pdf` | PDF reading and extraction |
| `writer` | Long-form prose |
| `edge` | Minimal-footprint tasks |
| `generalist` | General-purpose |
| `fast-generalist` | Fast/cheap background work |
| `fast-scout` | Latency-optimized search (phi4-mini across all tiers) |
| `long-context` | Large context window tasks |

### Pipeline orchestration

Each pipeline agent ends its response with an `UNBLOCKED_TASKS` block containing `Task()` calls for the next agent(s). Typical flow:

```
planner → coder → tester → code-reviewer
coder/tester failure → debugger-hypothesis → debugger-investigate → debugger-hard
```

---

## Routing Modes

Set with `--mode <name>`, `CLAUDE_LLM_MODE`, or `llm_mode` in model-map.json.

| Mode | Description |
|---|---|
| `best-cloud` | Anthropic/Gemini cloud models; local fallback at 64gb+ (default) |
| `best-cloud-oss` | OSS cloud via OpenRouter (DeepSeek, Kimi, Qwen) |
| `best-local-oss` | Fully local (Phi, Qwen, Devstral) |
| `best-cloud-gov` | US-Gov compliant cloud (non-Chinese-origin) |
| `best-local-gov` | US-Gov compliant local (Phi, GPT-OSS) |

**Aliases:** `--local-only`, `--offline`, `--fastest`, `--smallest`, `--best-opensource-local` → `best-local-oss`. `--best-opensource-cloud`, `--best-opensource` → `best-cloud-oss`.

---

## Hardware Tiers

Auto-detected from `os.totalmem()` at proxy startup. Override with `--profile <tier>` or `CLAUDE_LLM_PROFILE`.

| Tier | RAM | Supervisor model | Fast-code model |
|---|---|---|---|
| `16gb` | < 24 GB | phi4-reasoning:plus | gemma4:e4b |
| `32gb` | 24–40 GB | qwen3.6:27b (17 GB, multimodal) | devstral-small-2:24b |
| `48gb` | 40–56 GB | qwen3.6:27b | devstral-small-2:24b |
| `64gb` | 56–96 GB | qwen3.6:35b (24 GB, multimodal) | qwen3.6:35b-a3b-coding-nvfp4 |
| `128gb` | 96 GB+ | qwen3.6:35b-a3b-q8_0 (39 GB, multimodal) | qwen3.6:35b-a3b-coding-nvfp4 |

**Two local model lanes:**
- **Supervisor lane** (Q4/Q8, multimodal): planning, review, reasoning, vision, pdf. Preserves Text+Image capability.
- **Fast-code lane** (NVFP4, text-only, MLX-optimized): coder, tester, explore, debugger-investigate. Higher throughput, no vision.

---

## Config Layering

Three-tier merge, highest precedence first:

1. `CLAUDE_MODEL_MAP_PATH` — explicit override path
2. `$PWD/.claude/model-map.json` — project-local graph (selected as its own DAG, not merged)
3. `~/.claude/model-map.json` — profile graph (`model-map.system.json` + `model-map.overrides.json`)

User customizations go in `~/.claude/model-map.overrides.json` — never overwritten on upgrade.

---

## model-map.json Schema

Top-level keys:

| Key | Description |
|---|---|
| `endpoints` | Connection metadata: `format`, `url`, `auth`, `fallback_to`. Legacy `backends` alias accepted. |
| `model_routes` | Route resolution: string `"endpoint-id"`, v2 alias `{"endpoint": "...", "name": "..."}`, or mode-conditional object |
| `routes` | Named presets → `{model, backend, env, …}`. `routes.default` used when no flag is passed |
| `llm_profiles` | Per-capability × per-mode × per-tier routing graph |
| `agent_to_capability` | Maps agent names → capability aliases (identity for all shipped agents) |
| `model_overrides` | Unconditional `{"concrete-model": "replacement"}` applied before route graph traversal |
| `llm_capabilities` | Intent definitions for dynamic classifier |
| `capability_sampling_defaults` | Per-capability temperature/top_p/top_k defaults |
| `model_extra_params` | Extra params injected per model (e.g. `preserve_thinking: true` for Qwen3.6) |
| `picker_alias_endpoints` | Endpoint IDs whose routes get `claude-via-<key>` aliases in `/v1/models` |
| `deprecated_models` | Tags that trigger `x-c-thru-deprecated-model` header; set to `false` to un-deprecate |

**`auth` field forms:**

| Form | Behavior |
|---|---|
| `"none"` | Strips all auth — prevents ambient API keys from leaking to local backends |
| (absent) | Passthrough — forwards client's Authorization/x-api-key verbatim |
| `"auth_env": "KEY_NAME"` | Injects `Authorization: Bearer $KEY_NAME` |
| `{"header": "...", "scheme": "...", "env": "KEY_NAME"}` | Custom header/scheme |

---

## Proxy Reliability

### Fallback chains + cycle detection

`on_failure: "cascade"` (default) walks the fallback chain on 5xx/429/network errors. `on_failure: "hard_fail"` returns a clean error immediately (used by `reviewer-security`).

Cycle detection uses a per-request visited set. On SIGHUP config reload, the module-level `CONFIG_VERSION` counter increments — `tryFallback()` detects the version bump and resets the visited set, allowing the new config's fallback graph to be traversed cleanly.

### Config watcher re-arm

`armConfigWatcher` uses `fs.watchFile` (1007ms poll interval). When a SIGHUP reload resolves a new `CONFIG_PATH` (e.g. a project-local config appears), the watcher re-arms on the new path. The handle stores the **filename string** so `fs.unwatchFile` receives what it requires; the error path logs `configWatcherFailed` and continues rather than crashing the proxy.

### SIGHUP safety

`reloadConfigFromDisk` catches read errors (EACCES, ENOENT) and keeps the previous live config rather than crashing. Logs `config reload failed` to stderr.

---

## Proxy Observability

**`x-c-thru-resolved-via`** — on every capability response:
```json
{"capability": "coder", "profile": "coder", "served_by": "qwen3.6:35b-a3b-coding-nvfp4",
 "tier": "64gb", "mode": "best-local-oss", "local_terminal_appended": false}
```

**Gemini thinking headers:**
- `x-c-thru-thinking-auto-enabled` — proxy auto-enabled thinking on Gemini 3 Pro
- `x-c-thru-thinking-level` — `minimal|low|medium|high` (Gemini 3+ `thinkingLevel`)
- `x-c-thru-thinking-budget-added` — `maxOutputTokens` expansion added by proxy
- `x-c-thru-thinking-tokens` — `thoughtsTokenCount` from upstream

See `docs/headers.md` for the full `x-c-thru-*` reference.

---

## CLI Reference

### Router flags (`c-thru`)

| Flag | Sets | Effect |
|---|---|---|
| `--mode <m>` | `CLAUDE_LLM_MODE` | Routing mode |
| `--profile <t>` | `CLAUDE_LLM_PROFILE` | Force hardware tier |
| `--memory-gb <n>` | `CLAUDE_LLM_MEMORY_GB` | Override RAM detection |
| `--route <name>` | — | Use named route from model-map |
| `--model <model>` | — | Override model for this invocation |
| `--thinking` | `C_THRU_THINKING=1` | Enable extended thinking |
| `--journal` | `CLAUDE_PROXY_JOURNAL=1` | Enable per-request journaling |
| `--bypass-proxy` | `CLAUDE_PROXY_BYPASS=1` | Skip proxy entirely |
| `--no-update` | `C_THRU_NO_UPDATE=1` | Skip git self-update |
| `--proxy-debug [N]` | `CLAUDE_PROXY_DEBUG=N` | Proxy verbose logs (1 or 2) |
| `--router-debug [N]` | `C_THRU_DEBUG=N` | Router verbose logs (1 or 2) |

### Proxy flags (`claude-proxy`)

| Flag | Effect |
|---|---|
| `--config <path>` | Override config path |
| `--profile <tier>` | Force hardware tier |
| `--port <n>` | Bind to fixed port |
| `--mode <m>` | Set routing mode |

### Subcommands

| Command | Effect |
|---|---|
| `c-thru list` | Active profile, routes, Ollama models |
| `c-thru reload` | SIGHUP proxy, wait for `/ping`, print new tier |
| `c-thru restart [--force]` | Stop + re-spawn proxy |
| `c-thru explain --capability X --mode M [--tier T]` | Print resolution chain without a real request |
| `c-thru stats` | Per-agent/model call count, tokens, last-call timestamp |
| `c-thru stats clear` | Reset session usage stats |
| `c-thru check-deps [--fix]` | Audit system deps; `--fix` runs `brew install` |

### Claude Code skills

| Skill | Effect |
|---|---|
| `/cplan <intent>` | Wave-based agentic planner |
| `/c-thru-status [fix]` | Show status; `fix` applies recommended mappings + reloads |
| `/c-thru-config reload` | Hot-reload proxy from a Claude session |
| `/c-thru-config planning [on/off]` | Toggle `EnterPlanMode` advisory hint |

---

## Key Environment Variables

| Variable | Effect |
|---|---|
| `CLAUDE_LLM_MODE` | Routing mode (5 values, see above) |
| `CLAUDE_LLM_PROFILE` | Force hardware tier |
| `CLAUDE_LLM_MEMORY_GB` | Override RAM detection (positive integer GB) |
| `CLAUDE_PROXY_BYPASS=1` | Skip proxy entirely |
| `C_THRU_DEBUG=1/2` | Router verbose logs |
| `CLAUDE_PROXY_DEBUG=1/2` | Proxy verbose logs |
| `CLAUDE_PROFILE_DIR` | Override `~/.claude` location |
| `CLAUDE_MODEL_MAP_PATH` | Explicit config override |
| `CLAUDE_MODEL_MAP_DEFAULTS_PATH` | Override shipped `config/model-map.json` |
| `CLAUDE_MODEL_MAP_OVERRIDES_PATH` | Override `~/.claude/model-map.overrides.json` |
| `CLAUDE_PROXY_JOURNAL=1` | Enable per-request JSONL journaling to `~/.claude/journal/` |
| `CLAUDE_PROXY_JOURNAL_DIR` | Override journal directory |
| `CLAUDE_PROXY_JOURNAL_MAX_BYTES` | Per-file size cap before rotation (default 100 MB) |
| `CLAUDE_PROXY_JOURNAL_INCLUDE` | Comma-separated capabilities to journal |
| `CLAUDE_PROXY_JOURNAL_EXCLUDE` | Comma-separated capabilities to skip |
| `CLAUDE_PROXY_CLASSIFY=1` | Phase A dynamic classifier (observe-only) |
| `CLAUDE_PROXY_CLASSIFY_MODEL` | Classifier model tag (default `gemma4:e2b`) |
| `CLAUDE_PROXY_CLASSIFY_TIMEOUT_MS` | Classifier hard timeout (default 5000) |
| `C_THRU_NO_UPDATE=1` | Skip git self-update (CI/scripting) |
| `C_THRU_UPDATE_INTERVAL` | Seconds between self-update fetches (default 3600) |
| `C_THRU_SKIP_PREPULL=1` | Skip bulk pre-pull of local models |
| `C_THRU_OLLAMA_AUTOSTART=1` | Auto-start Ollama if unreachable (default: on) |
| `C_THRU_THINKING=1` | Enable extended thinking |
| `GOOGLE_API_KEY` | Gemini AI Studio key (`x-goog-api-key`) |
| `GOOGLE_CLOUD_TOKEN` | Vertex AI bearer token (refresh with `gcloud auth print-access-token`) |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID (interpolated into vertex endpoint URL) |
| `GOOGLE_CLOUD_REGION` | GCP region (interpolated into vertex endpoint URL) |

---

## Thinking & Reasoning Models

**Anthropic models** — extended thinking off by default (`/no_thinking` injected). Enable with `c-thru --thinking` or `C_THRU_THINKING=1`.

**Qwen3.6 (local):**
- `preserve_thinking: true` auto-injected by proxy for all `qwen3.6` models on local backends
- Agentic coding lane (coder/tester/explore): temp=1.0, top_p=0.95, top_k=20
- Reasoning lane (planner/reviewer/etc.): temp=0.6
- Caller-supplied temperature always wins

**Gemini 3 Pro** — thinking auto-enabled by proxy via `thinkingLevel` enum. Opt out with `thinking:{type:'disabled'}`.

**Known local model quirks:**
- Qwen3: `/no_think` tag unreliable in Ollama — use non-thinking instruct variant instead
- Qwen3: thinking + tools = empty output; disable thinking when passing tool definitions
- DeepSeek-R1: temperature=0 skips reasoning; keep ≥ 0.5

---

## Proxy Lifecycle

`claude-proxy` is auto-spawned by `c-thru` when a backend needs it. The router coordinates via a `/ping` handshake. Logs: `~/.claude/proxy.*.log`.

```bash
c-thru reload          # SIGHUP + wait for /ping
c-thru restart         # SIGTERM + re-spawn
pkill -f claude-proxy  # kill stuck proxy
```

**Ollama boundary:** `claude-proxy` only connects to Ollama — never spawns or kills it. `c-thru` (bash) manages Ollama reachability. When `c-thru` exits, the proxy exits with it; Ollama persists independently.

---

## Further Reading

- [docs/agent-architecture.md](docs/agent-architecture.md) — wave lifecycle, STATUS contracts, escalation chain
- [docs/connectivity-modes.md](docs/connectivity-modes.md) — full mode reference with internal variants
- [docs/headers.md](docs/headers.md) — complete `x-c-thru-*` response header reference
- [docs/journaling.md](docs/journaling.md) — per-request JSONL schema and storage layout
- [docs/hardware-profile-matrix.md](docs/hardware-profile-matrix.md) — full tier × capability model table
- [docs/model-map.md](docs/model-map.md) — config customization guide
- [docs/dynamic-classification-phase-a.md](docs/dynamic-classification-phase-a.md) — Phase A observe-only classifier

---

## License

MIT
