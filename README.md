# c-thru

**Transparent, Hardware-Aware LLM Routing for Claude Code.**

`c-thru` is a high-performance proxy and routing layer that sits between Claude Code and your LLM backends. It allows you to leverage local models (via Ollama), alternative cloud providers (OpenRouter), and official Anthropic endpoints—all within a single, unmodified Claude Code session. It also supports Google Gemini backends via a full Anthropic-to-Gemini translation layer.

---

## 🚀 Quick Start

### 1. Install
```bash
git clone https://github.com/whichguy/c-thru.git
cd c-thru
./install.sh
```
*The installer symlinks tools to `~/.claude/tools/` and sets up your default model maps.*

### 2. Configure Backends
Ensure [Ollama](https://ollama.com) is running locally for offline support. For cloud access, set your API keys:
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENROUTER_API_KEY="sk-or-..."
```

### 3. Launch
Simply prepend `c-thru` to your usual Claude commands:
```bash
c-thru                 # Standard mode (cloud primary, local fallback)
c-thru --offline  # Force all agents to run on local hardware
```

---

## 🧠 What c-thru Accomplishes

Claude Code is a powerful agentic tool, but it is traditionally tied to cloud-hosted Anthropic models. `c-thru` breaks this limitation by providing:

- **Protocol Translation**: Seamlessly converts the Anthropic Messages API to Ollama's `/v1/messages` adapter (Ollama 0.4+), preserving tool use, multi-modal inputs, and thinking blocks. Also supports Google Gemini backends via automatic Anthropic↔Gemini translation.
- **Hardware-Aware Routing**: Automatically detects your system RAM and selects models optimized for your hardware (e.g., routing a Qwen3.6 35B model on a 128GB Mac vs. a Phi-4-Mini on a 16GB machine).
- **Hybrid Intelligence**: Allows different "agents" in a single session to run on different models. Your **Planner** can run on Claude Sonnet 4 (cloud) while your **Implementer** runs on a local Qwen3.6 (local).
- **Seamless Continuity**: If your internet drops, `c-thru` detects the failure and instantly re-routes requests to local alternatives without crashing your session.

---

## 🛠 How It Works

`c-thru` operates as a two-stage system:

### 1. The Router (`tools/c-thru`)
A lightweight Bash wrapper that intercepts the `claude` execution. It:
- Resolves the current **Hardware Tier** (16GB to 128GB+).
- Checks **Connectivity Status** (Connected vs. Offline).
- Injects a specialized "Agent Fleet" into the session.
- Configures environment variables (like `ANTHROPIC_BASE_URL`) to point to the local proxy.

### 2. The Proxy (`tools/claude-proxy`)
A zero-dependency Node.js server (stdlib only) that manages the actual request flow:
- **Dual-Mode Auth**: Prioritizes client-provided Bearer tokens, falling back to configured x-api-keys or x-goog-api-key for Gemini.
- **Strategic Cooldowns**: Temporarily routes around failed backends.
- **Network Watcher**: On macOS, it monitors WiFi status via `scutil`. When you reconnect to the internet, it **immediately clears all cooldowns**, making cloud models available again instantly.
- **High Fidelity**: Forwards requests verbatim where possible, ensuring cutting-edge features like "thinking blocks" roundtrip correctly to local models.

---

## 🔧 Proxy Architecture

### Auth Schema

The `auth` field on endpoints supports several forms:

| Form | Example | Behavior |
|---|---|---|
| `"none"` | `"auth": "none"` | Strips all auth headers — useful for local Ollama where an ambient API key must not leak |
| (absent) | — | Passthrough — forwards the client's Authorization/x-api-key verbatim |
| `"auth_env"` | `"auth_env": "OPENROUTER_API_KEY"` | Injects `Authorization: Bearer $OPENROUTER_API_KEY` |
| Full object | `{"header": "x-goog-api-key", "env": "GEMINI_API_KEY"}` | Custom header and env var; scheme defaults to `"Bearer"` when header is `"Authorization"`, empty otherwise |

### Declared Rewrites

The proxy applies up to 8 rewrites to each outbound request:

1. **Request body `model` field** — resolved per route/capability
2. **Request URL + `Host`** — rewritten to target endpoint
3. **Auth headers** — injected or stripped per endpoint `auth` config
4. **SSE `usage` injection** — added to server-sent events stream
5. **Protocol translation** — Anthropic↔Gemini (implemented); Anthropic↔OpenAI (501 stub)
6. **`x-c-thru-resolved-via` response header** — resolution chain metadata
7. **`model_overrides`** — unconditional name substitution before route graph traversal
8. **`@<backend>` sigil stripping** — stripped from model name before forwarding so the provider only sees the base model name

### Observability

Each capability response includes a `x-c-thru-resolved-via` header with JSON describing the resolution chain:
`{"capability": "workhorse", "profile": "workhorse", "served_by": "claude-sonnet-4-6", "tier": "64gb", "mode": "connected", "local_terminal_appended": false}`

Per-profile `on_failure` field controls fallback behavior: `"cascade"` (default) walks the fallback chain; `"hard_fail"` returns null immediately, sending a clean error instead of a non-equivalent substitute.

**Gemini thinking observability** (when routed to a Gemini endpoint):
- `x-c-thru-thinking-auto-enabled: 1` — proxy auto-enabled thinking on Gemini 3 Pro (matches `gemini-3*-pro*`, `gemini-pro-latest`, `gemini-pro`); opt out with `thinking:{type:'disabled'}`.
- `x-c-thru-thinking-level: <minimal|low|medium|high>` — Gemini 3+ uses `thinkingLevel` (replaces legacy `thinkingBudget`). Anthropic's `budget_tokens` is mapped to the closest level the target model supports.
- `x-c-thru-thinking-budget-added: <N>` — proxy expanded `maxOutputTokens` by N because Gemini 3 counts thinking against the same pool as visible tokens.
- `x-c-thru-thinking-tokens: <N>` — upstream `thoughtsTokenCount` (non-streaming). Streaming surfaces it as `message_delta.usage.thinking_output_tokens`.
- `output_tokens` matches Anthropic semantics: includes thinking tokens.

**`/model` picker exposure**: aliases `claude-via-gemini-pro` and `claude-via-gemini-flash` make Gemini selectable from Claude Code's runtime `/model` picker (which only displays `claude-*` IDs).

### Lifecycle & Constraints

- **`claude-proxy`** is a long-running HTTP server spawned by `c-thru`. Logs land at `~/.claude/proxy.*.log`. Reload config via SIGHUP (`c-thru reload`) or restart with `c-thru restart`. Kill a stuck proxy with `pkill -f claude-proxy`.
- **Zero external Node dependencies** — the proxy and all helpers use stdlib only (`http`, `https`, `fs`, `path`, `crypto`, `child_process`). No `package.json` or `node_modules/`.
- **Ollama lifecycle boundary** — the proxy connects to Ollama at `OLLAMA_BASE_URL` (default `http://localhost:11434`) but never spawns or kills it. Ollama persists independently. `c-thru` (bash) manages Ollama reachability (auto-start if unreachable); when `c-thru` exits, the proxy exits with it but Ollama continues running.
- **`llm-capabilities-mcp.js`** is an MCP server (stdio transport) injected ephemerally via `--settings` at startup. Exposes `list_models` and `classify_intent` tools to Claude Code.
- **Filesystem footprint** — `install.sh` only writes to `~/.claude/` and your shell rc file. See `CLAUDE.md` for the full file manifest.

---

## 💡 Key Use Cases

### 📶 Robust Offline Development
Develop and debug code on a plane, in a coffee shop with bad WiFi, or in secure environments. `c-thru --offline` ensures your entire agentic workflow remains functional using only your local GPU/CPU.

### 💰 Cost Optimization
Offload token-heavy tasks (like initial codebase indexing or large-scale refactors) to local models while reserving expensive cloud tokens for final reasoning, planning, and architectural judgment.

### 🔒 Enhanced Privacy
Route sensitive internal code to local-only agents (`agentic-coder`, `security-reviewer`) while using cloud models for general queries or public library documentation.

### ⚡ Performance Tuning
Use "Fast" variants of agents (e.g., `fast-coder`, `edge`) that run small, highly-quantized models for trivial transformations, significantly reducing the "waiting for LLM" time in your inner loop.

---

## 📖 Further Reading

- [Connectivity Modes](docs/connectivity-modes.md) — 5 CLI-selectable routing modes (with 9 internal variants), explaining every situation.
- [Agent Architecture](docs/agent-architecture.md) — Meet the fleet of 12 pipeline + 8 utility agents.
- [Model Map Reference](docs/model-map.md) — How to customize your routing graph.
- [Hardware Profile Matrix](docs/hardware-profile-matrix.md) — Full per-tier × per-capability model table.
- [Journaling](docs/journaling.md) — Per-request JSONL journaling schema and storage layout.
- [Dynamic Classification (Phase A)](docs/dynamic-classification-phase-a.md) — Observe-only prompt classifier.
- [Dynamic Classification Design](docs/dynamic-classification-design.md) — Classifier architecture and design.
- [Local Model Prompt Techniques](docs/local-model-prompt-techniques.md) — Prompt best practices for local models.
- [Benchmark Reference](docs/benchmark-reference.md) — Benchmark methodology and results.
- [Capacity Audit (128GB)](docs/capacity-audit-128gb.md) — 128GB tier analysis.
- [Prompt Strategies](docs/prompt-strategies.md) — Prompt strategy guidance.
- [Test Coverage Audit](docs/test-coverage-audit.md) — Test coverage audit.
- [UX Audit](docs/ux-audit.md) — UX audit findings.
- [Phase D Audit](docs/phase-d-audit-memo.md) — Phase D audit.
- [Model Map Research](docs/model-map-research-2026-04-25.md) — Model map research history.
- [Research Process](docs/research-process.md) — Research methodology.
- [Model Tournament Results](docs/tournament_2026-04-25.md) — Model tournament results.

---

## 🔧 Advanced Usage

### Router Flags

| Flag | Effect |
|---|---|
| `--route <name>` | Use a named route from model-map.json |
| `--model <model>` | Override model for this invocation |
| `--mode <m>` | Set routing mode: `best-cloud`, `best-cloud-oss`, `best-local-oss`, `best-cloud-gov`, `best-local-gov` |
| `--profile <tier>` | Force hardware tier (16gb, 32gb, 48gb, 64gb, 128gb) |
| `--memory-gb <n>` | Override RAM detection |
| `--thinking` | Enable extended thinking on Anthropic models |
| `--journal` | Enable per-request request/response journaling |
| `--bypass-proxy` | Skip proxy entirely (transparent Anthropic path) |
| `--no-agents` | Skip agent injection |
| `--no-update` | Skip git self-update |
| `--proxy-debug [N]` | Proxy verbose logs (default 1, accepts 1 or 2) |
| `--router-debug [N]` | Router verbose logs (default 1, accepts 1 or 2) |
| `--debug` | Enable both router and proxy debug logs (combined flag) |

### Mode Aliases

`--local-only`, `--offline`, `--fastest`, `--smallest`, `--best-opensource-local` all resolve to `best-local-oss`. `--best-cloud` sets `best-cloud`. `--best-opensource-cloud` and `--best-opensource` set `best-cloud-oss`.

### Thinking & Reasoning Models

**Anthropic models** (claude-opus-\*, claude-sonnet-\*):
- Default: extended thinking OFF (`/no_thinking` injected into system prompt)
- Enable: `c-thru --thinking` or `C_THRU_THINKING=1`
- When `--thinking` is enabled, judge/planner capabilities are routed to cloud thinking-capable models

**Local reasoning models** — always reason internally, no flag required:
- **DeepSeek-R1** (7b/14b/32b): temperature 0.6, top_p 0.95 (official); no system prompt
- **Qwen3 thinking variants**: temperature 0.6 (coding) / 1.0 (open); top_k 20
- **phi4-reasoning**: temperature 0.6–0.8; num_ctx 16384–32768

**Known quirks:**
- Qwen3: `/no_think` tag unreliable in Ollama — use non-thinking instruct variant instead
- Qwen3: thinking + tools = empty output; disable thinking when passing tool definitions
- Qwen3: empty `<thinking>` response tags emitted even in no-think mode — strip at consumer
- DeepSeek-R1: temperature=0 skips reasoning entirely; keep >= 0.5
- DeepSeek-R1: add `\n\nThinking\n` as assistant prefix to force reasoning engagement
- All reasoning models: `presence_penalty` preferred over `repeat_penalty` for Qwen3

### CLI Subcommands

| Command | Effect |
|---|---|
| `c-thru list` | Show active hw profile, routes, and local Ollama models |
| `c-thru reload` | Hot-reload proxy config (SIGHUP) |
| `c-thru restart` | Stop and re-spawn proxy |
| `c-thru explain --capability X --mode M` | Print resolution chain without sending a request |
| `c-thru check-deps [--fix]` | Audit system dependencies; `--fix` installs via brew |
| `c-thru stats` | Print session usage tables (calls, tokens, avg latency per agent/model) |
| `c-thru stats clear` | Reset session usage stats |

### Key Environment Variables

| Variable | Effect |
|---|---|
| `CLAUDE_PROXY_BYPASS=1` | Skip proxy entirely |
| `C_THRU_OLLAMA_AUTOSTART=1` | Auto-start Ollama if unreachable (default: on) |
| `CLAUDE_PROXY_JOURNAL=1` | Enable per-request journaling to `~/.claude/journal/` |
| `CLAUDE_PROXY_JOURNAL_DIR` | Override default journal directory |
| `CLAUDE_PROXY_JOURNAL_MAX_BYTES=104857600` | Per-file journal size cap before rotation (default: 100MB) |
| `CLAUDE_PROXY_JOURNAL_INCLUDE` | Comma-separated capabilities to journal |
| `CLAUDE_PROXY_JOURNAL_EXCLUDE` | Comma-separated capabilities to skip |
| `CLAUDE_PROXY_CLASSIFY=1` | Run small classifier on prompts (Phase A: observe-only) |
| `CLAUDE_PROXY_CLASSIFY_MODEL` | Classifier model tag (default `gemma4:e2b`) |
| `CLAUDE_PROXY_CLASSIFY_OLLAMA_URL` | Where to send classifier requests |
| `CLAUDE_PROXY_CLASSIFY_TIMEOUT_MS` | Classifier hard timeout (default 5000) |
| `C_THRU_NO_UPDATE=1` | Skip git self-update |
| `C_THRU_UPDATE_INTERVAL` | Seconds between self-update fetches (default 3600) |
| `C_THRU_SKIP_PREPULL=1` | Skip bulk pre-pull of local models (CI/tests) |
| `C_THRU_THINKING=1` | Enable extended thinking |
| `CLAUDE_PROXY_DEBUG=1` | Proxy verbose logging |
| `CLAUDE_LLM_MODE` | Override routing mode |
| `CLAUDE_LLM_PROFILE` | Force hardware tier |
| `CLAUDE_LLM_MEMORY_GB` | Override RAM detection for hardware-tier selection |
| `CLAUDE_PROFILE_DIR` | Override `~/.claude` location |
| `CLAUDE_MODEL_MAP_DEFAULTS_PATH` | Override shipped `config/model-map.json` path |
| `CLAUDE_MODEL_MAP_OVERRIDES_PATH` | Override `~/.claude/model-map.overrides.json` path |
| `OLLAMA_NUM_PARALLEL` | Number of models Ollama keeps loaded in parallel (default 4) |
| `NO_COLOR=1` | Disable colored output |
| `GOOGLE_API_KEY` | Gemini AI Studio key. If unset on a Gemini route, c-thru opens the [AI Studio key page](https://aistudio.google.com/app/api-keys), prompts on the TTY, and persists `export GOOGLE_API_KEY` to your shell rc file (`.zshrc` / `.bashrc`). Non-TTY runs print the URL and exit non-zero. |
| `GOOGLE_CLOUD_TOKEN` | Vertex AI bearer token. Refresh with `gcloud auth print-access-token`; not auto-bootstrapped (token is short-lived). |

### Claude Code Skills

| Skill | Effect |
|---|---|
| `/cplan <intent>` | Wave-based agentic planner |
| `/c-thru-status fix` | Apply recommended mappings, reload proxy, show status |
| `/c-thru-config planning on/off` | Toggle EnterPlanMode advisory hint |

---

## 📐 Model Map Configuration

### Supported Backend Formats

| `format` | Description |
|---|---|
| `anthropic` (default) | Direct Anthropic Messages API |
| `ollama-legacy` | Anthropic→Ollama `/api/chat` translation (legacy, pre-0.4) |
| `gemini` | Full Anthropic↔Gemini REST translation with streaming |
| `openai` | Passthrough (501 stub — not yet implemented) |

### Key model-map.json Fields

| Field | Description |
|---|---|
| `endpoints` | Connection metadata (format, url, auth, prep_policy) — see auth schema in the Proxy Architecture section |
| `llm_capabilities` | Intent definitions for dynamic classification |
| `llm_profiles` | Per-tier, per-capability routing graph — the core model selection table |
| `agent_to_capability` | Maps agent names to capability aliases for 2-hop resolution |
| `tool_capability_to_profile` | Maps Claude Code tool names to capability profiles |
| `capability_sampling_defaults` | Per-capability temperature/top_p/top_k |
| `model_extra_params` | Extra params injected per model (e.g., `preserve_thinking: true`) |
| `model_overrides` | Unconditional model name substitution (flat map) |
| `model_routes` | Route resolution rules (string targets or endpoint+name objects) |
| `routes` | Named presets including `routes.default` |
| `ollama_defaults` | Ollama pull timeout and behavior |
| `llm_mode` | Default connectivity mode for this config layer |
| `llm_active_profile` | Hardware profile selection mode (`"auto"`) |
| `models` | Model definitions with equivalents array |
| `quality_tolerance_pct` | Quality tolerance percentage for fallback decisions |

### Model Map Layering

1. `CLAUDE_MODEL_MAP_PATH` — explicit override path
2. `$PWD/.claude/model-map.json` — project-local graph
3. `~/.claude/model-map.json` — profile graph (layered from system + overrides)

Project-local is not merged on top of the profile graph.

---

## License
MIT
