# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Wiki
WIKI: /wiki-load <search> or browse wiki/index.md before answering project-domain questions. /wiki-query for synthesis.

## Model rewriting: proxy-only

Model-field rewriting (logical → concrete, route aliasing, fallback
remap) is the proxy's responsibility — see `wiki/entities/declared-rewrites.md`.
Claude Code hooks may observe (log, inject context) or gate (refuse to
proceed) but must not modify `tool_input.model` or `body.model`. A second
rewriting path creates a silent source of drift from `config/model-map.json`.

## What This Repo Is

**c-thru** is the router/proxy layer that lets Claude Code talk to alternative model providers (Ollama, OpenRouter, Bedrock, Vertex, LiteLLM) without changing the vendor CLI. It was extracted from `claude-craft` as a standalone public repo.

## Install and Verify

```sh
./install.sh                            # symlinks tools into ~/.claude/tools/, seeds model-map
bash -n tools/c-thru             # bash syntax check
node --check tools/claude-proxy         # node syntax check
node --check tools/model-map-*.js tools/llm-capabilities-mcp.js
node tools/model-map-validate.js config/model-map.json   # validate shipped config
node test/model-map-v12-adapter.test.js                  # adapter regression test
~/.claude/tools/c-thru list      # runtime smoke-test (requires install; --list also accepted)
```

## Directory Layout and Path Invariants

The `tools/` + `config/` two-directory structure is **required**. `c-thru` and `claude-proxy` both compute `ROUTER_REPO_ROOT` as `$(dirname $0)/..` and read `$ROUTER_REPO_ROOT/config/model-map.json`. Do not flatten.

```
tools/
  c-thru                 # bash, 2300+ lines — the entrypoint
  claude-proxy            # node, stdlib-only — Anthropic→provider translation layer
  model-map-layered.js    # merges 3-tier config stack; no external deps
  model-map-validate.js   # schema validator; called by router at startup
  model-map-sync.js       # pulls capability data into the map; calls layered.js
  model-map-edit.js       # interactive map editor; calls validate + layered
  llm-capabilities-mcp.js # MCP server exposing list_models + classify_intent tools
  verify-llm-capabilities-mcp.sh  # shell smoke-test for the MCP server
  verify-lmstudio-ollama-compat.sh # spike: run when LM Studio available to confirm kind:"ollama" vs kind:"openai"
  c-thru-session-start.sh # SessionStart/PostCompact hook — proxy+Ollama health check, silent on happy path
  c-thru-proxy-health.sh  # UserPromptSubmit hook — asyncRewake (exit 2, stderr) on proxy down
  c-thru-map-changed.sh   # FileChanged/PostToolUse hook — validates model-map.json on edit
  c-thru-classify.sh      # UserPromptSubmit hook — sends prompt to /hooks/context on the proxy for classify_intent context injection
  c-thru-ollama-gc.sh     # GC tool — tracks c-thru-pulled Ollama tags; sweeps unreferenced ones. Subcommands: init|record|sweep|purge
  c-thru-self-update.sh   # startup self-update: best-effort git ff-merge with 1s grace; opt-out via C_THRU_NO_UPDATE=1
  hw-profile.js             # shared 5-tier hardware detection (tierForGb); used by router and proxy
  model-map-apply-recommendations.js  # merges config/recommended-mappings.json as lowest-precedence tier
config/
  model-map.json          # shipped defaults (standard JSON — no comments; parsed with JSON.parse)
  recommended-mappings.json  # community capability→model recommendations per hw tier (lowest precedence)
test/
  model-map-v12-adapter.test.js  # adapter fixture test; run with: node test/model-map-v12-adapter.test.js
```

### User Profile Files (`~/.claude/`)

| File | Owner | Lifecycle |
|---|---|---|
| `model-map.system.json` | `install.sh` | Overwritten on every install — verbatim copy of `config/model-map.json`. Never edit manually. |
| `model-map.overrides.json` | user | Created empty `{}` on first install. Never touched on upgrade. Edit here to customize over system defaults. |
| `model-map.json` | derived | Effective merged result (system + overrides). Rewritten by router/proxy on startup. |

## Architecture

### Request flow

```
c-thru (bash)
  ├─ selects active model-map (override path → project/.claude/ → ~/.claude/model-map.json)
  ├─ resolves route → backend → env vars
  ├─ for Ollama backends: spawns/reuses claude-proxy (HTTP server on a free port)
  │    claude-proxy default: pass-through to Ollama's /v1/messages adapter
  │    claude-proxy legacy:  Anthropic → Ollama /api/chat translation
  │    (other backends — Anthropic, OpenRouter — always pass-through to /v1/messages)
  └─ exec's the real claude binary with ephemeral session injection:
       - ANTHROPIC_BASE_URL=http://127.0.0.1:<proxy_port>
       - ANTHROPIC_AUTH_TOKEN="ollama" (for local/spoofed backends)
       - --settings <temp_json> (injects hooks & llm-capabilities MCP)
       - --agents <json> (injects all agents from agents/*.md)
       - --append-system-prompt "..." (injects fleet awareness)
```

### Ollama backend wire format

For backends with `kind: "ollama"`, the proxy POSTs to `<backend.url>/v1/messages` (Ollama's Anthropic-format adapter, available since Ollama 0.4) with the client's body forwarded **verbatim** except for the resolved `model` field. `tool_use`, `tool_result`, and `thinking` content blocks roundtrip natively — no flattening, no translation. Authorization is hardcoded to `Bearer ollama` and `x-api-key` is stripped, so an ambient real Anthropic key in the client environment can never leak to a local backend.

**Legacy escape hatch.** Backends without `/v1/messages` (Ollama < 0.4, LM Studio's Ollama-compat shim) opt into the older Anthropic→`/api/chat` translation path with `legacy_ollama_chat: true` on the backend entry. The legacy path still runs `flattenMessagesForOllama`, which strips non-text content blocks — multi-turn tool conversations don't roundtrip cleanly through it. Use only when `/v1/messages` is genuinely unavailable.

```json
{
  "backends": {
    "ollama_local":  { "kind": "ollama", "url": "http://localhost:11434" },
    "lm_studio":     { "kind": "ollama", "url": "http://localhost:1234", "legacy_ollama_chat": true }
  }
}
```

### model-map.json schema

Top-level keys: `backends`, `routes`, `models` (models is sparse — most resolution is done via backends + routes).
- `backends`: connection metadata (kind, url, auth strategy). `kind` defaults to `anthropic` when absent. For `kind: "ollama"`, set `legacy_ollama_chat: true` to opt into the older `/api/chat` translation path (LM Studio compatibility).
- `routes`: named presets → `{model, backend, env, …}`. `routes.default` is used when no flag is passed.
- `model_overrides` (optional): flat `{"concrete-model": "replacement"}` map applied before route/alias resolution. Example: `{"gemma4:26b": "gemma4:31b"}` redirects all uses of the 26b model. Unconditional — covers primary requests and fallback candidates.
- Model resolution order: `--route` flag → `routes.default` → `--model` flag → Ollama passthrough.

### model-map selection and layering

1. `CLAUDE_MODEL_MAP_PATH` — explicit override path
2. `$PWD/.claude/model-map.json` — selected project graph
3. `~/.claude/model-map.json` — selected profile graph

Only the profile graph is layered: `model-map.system.json` + `model-map.overrides.json` are synced into `~/.claude/model-map.json`. Project-local `model-map.json` is selected by precedence and traversed as its own DAG; it is not merged on top of the profile graph.

### llm-capabilities-mcp.js

MCP server (stdio transport). Exposes tools defined in `TOOL_DEFS` (including all `llm_capabilities` entries plus `ask_model` and `list_models`). Called by Claude Code as a local MCP server — injected ephemerally via `--settings` by `c-thru` at startup.

### Bash sharp edges for contributors

**`exec` silently skips all EXIT traps.** In bash, `exec <cmd>` replaces the current shell process and never fires the `trap ... EXIT` handler. Any path that `exec`s into the real `claude` binary must ensure proxy cleanup is complete beforehand, or that no proxy was spawned yet. The guard in `c-thru` (`if [[ -z "${ROUTER_STARTED_PROXY_PID:-}" ]]`) enforces this: `exec` is only used on the transparent (no-proxy) path. On the routing path (proxy running), the pattern is `foreground child + exit $?` so the EXIT trap fires and kills the proxy. Do not add new `exec` calls in `c-thru` without verifying no proxy PID is live.

**`isolation: "worktree"` agents branch from the last pushed commit, not local HEAD.**
When dispatching parallel agents with `isolation: "worktree"` (via the Agent tool), each
worktree is created from `origin/main` HEAD — NOT from your local unpushed commits. Any
work in local commits that hasn't been pushed will be invisible to the agents. Always run
`git push` before dispatching worktree agents. If a worktree agent produces stale output
or ignores recent changes, check `git log origin/main..HEAD` — any commits listed there
were not available to the agent.

## Proxy CLI Flags

`claude-proxy` accepts these flags in addition to env vars:

| Flag | Effect |
|---|---|
| `--config <path>` | Override config path (sets `CLAUDE_MODEL_MAP_PATH`). `/ping` reports `config_source: "override"`. |
| `--profile <tier>` | Force hardware tier (sets `CLAUDE_LLM_PROFILE`). `/ping` reports `active_tier`. |
| `--port <n>` | Bind to fixed port (suppresses `READY <port>` stdout line). |
| `--mode <m>` | Set connectivity / routing mode (sets `CLAUDE_LLM_MODE`). |

## c-thru Router Flags (env-var equivalents)

`tools/c-thru` accepts these flags; each is stripped before forwarding to the real claude binary and exports the equivalent env var. Flag wins over env var.

| Flag | Sets env | Effect |
|---|---|---|
| `--mode <m>` | `CLAUDE_LLM_MODE` | Connectivity / routing mode (15 values; see docs/connectivity-modes.md) |
| `--profile <t>` | `CLAUDE_LLM_PROFILE` | Force hardware tier |
| `--memory-gb <n>` | `CLAUDE_LLM_MEMORY_GB` | Override RAM detection |
| `--bypass-proxy` | `CLAUDE_PROXY_BYPASS=1` | Skip proxy entirely |
| `--journal` | `CLAUDE_PROXY_JOURNAL=1` | Enable per-request journaling |
| `--proxy-debug [N]` | `CLAUDE_PROXY_DEBUG=N` | Proxy verbose logs (default 1, accepts 1\|2) |
| `--router-debug [N]` | `C_THRU_DEBUG=N` | c-thru script verbose logs |
| `--no-update` | `C_THRU_NO_UPDATE=1` | Skip git self-update |

## Key Environment Variables

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
| `CLAUDE_LLM_MODE` | Override connectivity / routing mode (16 modes): `connected` | `offline` | `local-only` | `semi-offload` | `cloud-judge-only` | `cloud-thinking` | `local-review` | `cloud-best-quality` | `local-best-quality` | `cloud-only` | `claude-only` | `opensource-only` | `fastest-possible` | `smallest-possible` | `best-opensource` | `best-opensource-cloud`. See `docs/connectivity-modes.md` for full reference. Replaces `CLAUDE_CONNECTIVITY_MODE` (legacy alias still accepted). |

| `C_THRU_NO_UPDATE=1` | Skip the best-effort git self-update at startup (CI/scripting). Also settable via `/map-model update off` (writes `self_update: false` to model-map.overrides.json). |
| `C_THRU_UPDATE_INTERVAL` | Seconds between self-update fetches (default `3600`). Debounced via `.git/FETCH_HEAD` mtime. |
| `C_THRU_BEHAVIORAL_TESTS=1` | Enable behavioral contract tests (`agent-contract-behavioral.test.js`). Requires a running proxy. |
| `BEHAVIORAL_ONLY` | Comma-separated agent name filter for behavioral test suite (e.g. `auditor,planner`). |
| `C_THRU_JUDGE=1` | Enable cloud-judge semantic validation in behavioral tests. Requires `ANTHROPIC_API_KEY`. Each agent response is evaluated by `judge-evaluator` (cloud tier); VERDICT=FAIL is a hard failure. |
| `C_THRU_LIVE_AGENT_TESTS=1` | Enable live agent contract smoke tests (`agent-contract-live.test.js`). |

## No External Node Dependencies

`claude-proxy`, `llm-capabilities-mcp.js`, and all `model-map-*.js` helpers use Node.js stdlib only (`http`, `https`, `fs`, `path`, `crypto`, `child_process`). There is no `package.json` and no `node_modules/`. Do not add third-party deps.

## Proxy Observability

`claude-proxy` emits `x-c-thru-resolved-via` on capability responses (model alias requests): `{"capability": "workhorse", "profile": "workhorse", "served_by": "claude-sonnet-4-6", "tier": "64gb", "mode": "connected", "local_terminal_appended": false}`. Absent on non-capability requests. Consumed by hooks and statusline without log-parsing.

Per-profile `on_failure` field in `llm_profiles[hw][profile]`: `"cascade"` (default) walks the fallback chain; `"hard_fail"` returns null immediately so the proxy returns a clean error instead of a non-equivalent substitute.

Declared rewrites: (1) request body `model` field, (2) request URL + `Host`, (3) `Authorization` header, (4) SSE `usage` injection, (5) protocol translation (gated on `kind: "openai"`), (6) `x-c-thru-resolved-via` response header, (7) `model_overrides` unconditional name substitution before route graph traversal, (8) `@<backend>` sigil stripping — suffix stripped before forwarding so the provider only sees the base model name.

## Proxy Lifecycle

`claude-proxy` is a long-running HTTP server auto-spawned by `c-thru` when the backend needs it. The router coordinates via a `/ping` handshake on a dynamically-selected port. Logs land at `~/.claude/proxy.*.log`. Kill a stuck proxy with `pkill -f claude-proxy`.

## Runtime Control

| Command | Effect |
|---|---|
| `c-thru reload` | Sends SIGHUP to the running proxy, derives the actual listening port from `lsof`, waits up to 2s for `/ping` to confirm it's alive, prints new tier. Exits non-zero if proxy is not running or crashes. |
| `c-thru restart` | SIGTERM + waits for listener to vanish, then re-spawns (port inherited from `CLAUDE_PROXY_PORT` env or auto-assigned). `--force` escalates to SIGKILL after timeout. |
| `c-thru list` | Show active hw profile, configured routes, and local Ollama models. (Renamed from `--list`; both forms still accepted.) |
| `c-thru explain --capability X --mode M [--tier T]` | Print resolution chain for a hypothetical request without sending one. Useful for "why did it pick that?" debugging. Pure JS — no proxy spawn. Also accepts `--agent <name>` to resolve through `agent_to_capability` first. |
| `c-thru check-deps [--fix]` | Audit system dependencies (node, jq, curl, ollama, etc.); `--fix` runs `brew install` for missing optional tools on macOS. |
| `/c-thru-config reload` | Skill equivalent of `c-thru reload` — usable from a Claude session. |
| `/c-thru-status fix` | Apply recommended mappings, reload proxy, show current status. |
| `/c-thru-config planning [...]` | Toggle the `EnterPlanMode` advisory hint suggesting `/c-thru-plan`. On by default; fires in all Claude Code sessions on the machine. Natural-language args — e.g. "turn off", "disable", "what's the status". Opt-out env: `C_THRU_PLANNER_HINT=0`. |
| `/cplan <intent>` | 4-letter shortcut for `/c-thru-plan <intent>` — wave-based agentic planner. |

**Ollama defaults (changed):** `C_THRU_OLLAMA_AUTOSTART` now defaults to `1` — Ollama is started automatically when unreachable. Opt out with `C_THRU_OLLAMA_AUTOSTART=0`.

**Bulk pre-pull:** On each router invocation, `ensure_active_tier_prepulled()` runs all active-tier local Ollama models through `ensure_ollama_running` in the background. Guarded by a stamp file at `$CLAUDE_PROFILE_DIR/.prepull-stamp-<tier>` invalidated on `model-map.json` mtime change. Set `C_THRU_SKIP_PREPULL=1` to disable (CI/tests).

**Ollama / proxy lifecycle boundary:** Ollama is an independent daemon; `claude-proxy` is a child of `c-thru`. The boundary:
1. `claude-proxy` never spawns or kills Ollama runners — it only connects to `OLLAMA_BASE_URL` (default `http://localhost:11434`), trusting external management.
2. `c-thru` (bash) is responsible for Ollama reachability: when `C_THRU_OLLAMA_AUTOSTART=1` (default) and Ollama is unreachable, `c-thru` runs `nohup ollama serve` in a detached subprocess, then retries once.
3. When `c-thru` exits, the proxy child process exits with it. Ollama persists — it was detached (`nohup`) and is not a child of the proxy.
4. Prefer running Ollama as a persistent system daemon (macOS app or `launchctl`). The `AUTOSTART` path is a convenience fallback, not a primary lifecycle mechanism.

**Filesystem footprint (self-contained audit):** `install.sh` writes only to `~/.claude/` and the shell rc file. Files written:
- `~/.claude/tools/` — symlinks to `tools/` in the repo (never copies)
- `~/.claude/commands/c-thru-status.md`, `commands/cplan.md` — vendor slash-command content, reinstalled on every run
- `~/.claude/skills/c-thru/` — symlink to `skills/c-thru-plan/` in the repo
- `~/.claude/model-map.system.json` — verbatim copy of `config/model-map.json`; overwritten on every install
- `~/.claude/model-map.overrides.json` — created empty `{}` on first install; never overwritten on upgrade
- `~/.claude/model-map.json` — derived merge; regenerated by the proxy and `--shell-env` on each run
- `~/.claude/settings.json` — cleaned on install (old persistent hooks removed); no new persistent hooks written (hooks are ephemeral per-session)
Runtime-only (not written by install): `.prepull-stamp-<tier>` (bulk pre-pull debounce, invalidated on model-map change), `proxy.*.log`, `proxy.pid`. `c-thru-self-update.sh` writes `.c-thru-update.log` inside the repo root only.

**`/map-model` is deprecated.** Use `/c-thru-config` for all model-map edits. `/map-model` now prints a migration table and exits without writing config.

## Contract integrity

Before committing changes to `skills/c-thru-plan/SKILL.md` or any `agents/*.md` file, run:
```sh
bash tools/c-thru-contract-check.sh   # exit 0 = clean; exit 1 = contract violations
```
Catches dangling `subagent_type` references, missing prompt keys vs. declared `Input:` lines, and accidental `Skill("review-plan")` invocations. Symlinked by `install.sh` to `~/.claude/tools/c-thru-contract-check`.

## Agentic plan/wave system

Invoke with `/c-thru-plan <intent>`. State in `${TMPDIR:-/tmp}/c-thru/<repo>/<slug>/`. Completed plans archived to `~/.claude/c-thru-archive/`.
Skills in `skills/`, agents in `agents/`. See `docs/agent-architecture.md`.

### Capability aliases

Wave-system internal agents route through shared capability tiers. User-facing role agents
each have a self-named capability that mirrors the same tier — making `agent_to_capability`
a 1:1 map for all user-facing agents (agent name == capability key).

**Shared capability tiers (wave-internal agents):**

| Alias | Cognitive tier | Wave-system agents |
|---|---|---|
| `judge` | 4–5 | planner, auditor, review-plan, final-reviewer, journal-digester, evaluator, supervisor, supervisor-debug, uplift-decider |
| `judge-strict` | 4–5, hard_fail | security-reviewer |
| `orchestrator` | 2 | plan-orchestrator, integrator, doc-writer |
| `local-planner` | 2–3 local | planner-local (dep_update signal only) |
| `code-analyst` | 2–3 | test-writer, wave-reviewer, wave-synthesizer, converger |
| `test-writer-heavy` | 4 heavy | test-writer-heavy |
| `pattern-coder` | 1 | scaffolder, discovery-advisor, learnings-consolidator |
| `deep-coder` | 3 | implementer |
| `implementer-heavy` | 4 heavy | implementer-heavy |
| `commit-message-generator` | 1 local | (deterministic pre-processor — clean-wave path) |

**User-facing role agents (self-named capabilities — agent name == capability key):**

| Agent / Capability | Cognitive tier | Backing capability (models copied from) |
|---|---|---|
| `judge` | 4–5 | — (canonical) |
| `large-general` | 4–5 | judge |
| `planner` | 4–5 | judge |
| `deep-code-debugger` | 3 (reasoning) | reasoner |
| `fast-code-debugger` | 2 (fast-debug) | fast-code-debugger |
| `reasoner` | 3 (reasoning) | — (canonical) |
| `orchestrator` | 2 | — (canonical) |
| `long-context` | 2 | orchestrator |
| `context-manager` | 2 | orchestrator |
| `agentic-coder` | 3 | — (canonical) |
| `implementer-heavy` | 4 heavy | — (canonical, was deep-coder-cloud) |
| `fast-coder` | 3 cloud / local | — (canonical) |
| `refactor` | 3 | deep-coder |
| `deep-coder-precise` | 3 (mxfp8/BF16) | — (canonical) |
| `coder` | 2 | — (canonical) |
| `reviewer` | 2 (review) | — (canonical) |
| `code-analyst-light` | 1–2 (light) | — (canonical) |
| `test-writer-heavy` | 4 heavy | — (canonical, was code-analyst-cloud) |
| `generalist` | 2 (general) | workhorse |
| `vision` | 2 (general) | workhorse |
| `image-analyst` | 2 (general) | workhorse |
| `pdf` | 2 (general) | workhorse |
| `fast-generalist` | 1 (fast) | classifier |
| `edge` | 1 | pattern-coder |
| `writer` | 2–4 (prose) | writer |
| `explorer` | 1 (discovery) | — (canonical) |
| `fast-scout` | 1 (latency-optimised) | — (canonical) |

**Internal capability tier definitions (not directly agent-named):**

| Alias | Purpose |
|---|---|
| `workhorse` | Backing tier for generalist/vision/pdf |
| `classifier` | Backing tier for fast-generalist |
| `default` | Fallback for unresolved requests |

### agent_to_capability resolution

Agent files declare `model: <agent-name>`. The proxy resolves via 2-hop graph:
`agent-name → agent_to_capability → capability-alias → llm_profiles[hw] → concrete model`.

The `agent_to_capability` map lives in `config/model-map.json` (top-level key).
`resolveCapabilityAlias()` in `claude-proxy` performs the traversal at request time —
no data is duplicated into `llm_profiles`.

### Adding/rebinding

- Rebind one agent to a different tier: change one line in `agent_to_capability`.
- Swap a tier's backing model: change one line in `llm_profiles[<hw>][<alias>]`.
- Agent files are never modified for either operation.

### Model tags

New Ollama tags used by agentic aliases: `devstral-small:2`, `qwen3.6:35b`,
`qwen3.5:122b`, `qwen3.5:27b`, `qwen3.5:9b`, `qwen3.5:1.7b`.
Run `ollama list` to confirm presence before first use.

### Worker CONFIDENCE field (Wave-1)

All worker agents (implementer, wave-reviewer, test-writer, scaffolder) return `CONFIDENCE: high|medium|low` in their STATUS block, derived from the §12.1 rubric embedded in each agent prompt. Absent CONFIDENCE is treated as `medium` (graceful degradation). The orchestrator logs calibration tuples to `$wave_dir/cascade/<item>.jsonl` joining worker confidence with `verify.json` test outcomes. See `docs/agent-architecture.md` for STATUS contract and calibration formula.
