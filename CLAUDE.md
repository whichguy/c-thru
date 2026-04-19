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
bash -n tools/claude-router             # bash syntax check
node --check tools/claude-proxy         # node syntax check
node --check tools/model-map-*.js tools/llm-capabilities-mcp.js
node tools/model-map-validate.js config/model-map.json   # validate shipped config
node test/model-map-v12-adapter.test.js                  # adapter regression test
~/.claude/tools/claude-router --list    # runtime smoke-test (requires install)
```

## Directory Layout and Path Invariants

The `tools/` + `config/` two-directory structure is **required**. `claude-router` and `claude-proxy` both compute `ROUTER_REPO_ROOT` as `$(dirname $0)/..` and read `$ROUTER_REPO_ROOT/config/model-map.json`. Do not flatten.

```
tools/
  claude-router           # bash, 2300+ lines — the entrypoint
  claude-proxy            # node, stdlib-only — Anthropic→provider translation layer
  model-map-layered.js    # merges 3-tier config stack; no external deps
  model-map-validate.js   # schema validator; called by router at startup
  model-map-sync.js       # pulls capability data into the map; calls layered.js
  model-map-edit.js       # interactive map editor; calls validate + layered
  llm-capabilities-mcp.js # MCP server exposing list_models + classify_intent tools
  verify-llm-capabilities-mcp.sh  # shell smoke-test for the MCP server
  c-thru-session-start.sh # SessionStart/PostCompact hook — proxy+Ollama health check, silent on happy path
  c-thru-proxy-health.sh  # UserPromptSubmit hook — asyncRewake (exit 2, stderr) on proxy down
  c-thru-map-changed.sh   # FileChanged/PostToolUse hook — validates model-map.json on edit
  c-thru-classify.sh      # UserPromptSubmit hook — sends prompt to /hooks/context (port 9998) for classify_intent context injection
  c-thru-ollama-gc.sh     # GC tool — tracks c-thru-pulled Ollama tags; sweeps unreferenced ones. Subcommands: init|record|sweep|purge
  hw-profile.js             # shared 5-tier hardware detection (tierForGb); used by router and proxy
config/
  model-map.json          # shipped defaults (JSON5 — comments allowed)
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
claude-router (bash)
  ├─ reads 3-tier model-map (project/.claude/ → ~/.claude/ → config/model-map.json)
  ├─ resolves route → backend → env vars
  ├─ for Ollama backends: spawns/reuses claude-proxy (HTTP server on a free port)
  │    claude-proxy translates Anthropic Messages API → Ollama/OpenRouter/LiteLLM
  └─ exec's the real claude binary with modified env (ANTHROPIC_BASE_URL, keys, --model)
```

### model-map.json schema

Top-level keys: `backends`, `routes`, `models` (models is sparse — most resolution is done via backends + routes).
- `backends`: connection metadata (kind, url, auth strategy). `kind` defaults to `anthropic` when absent.
- `routes`: named presets → `{model, backend, env, …}`. `routes.default` is used when no flag is passed.
- `model_overrides` (optional): flat `{"concrete-model": "replacement"}` map applied before route/alias resolution. Example: `{"gemma4:26b": "gemma4:31b"}` redirects all uses of the 26b model. Unconditional — covers primary requests and fallback candidates.
- Model resolution order: `--route` flag → `routes.default` → `--model` flag → Ollama passthrough.

### 3-tier model-map lookup (model-map-layered.js)

1. `$PWD/.claude/model-map.json` — per-project overrides
2. `~/.claude/model-map.json` — user profile (seeded by `install.sh`)
3. `config/model-map.json` — shipped defaults

### llm-capabilities-mcp.js

MCP server (stdio transport). Exposes tools defined in `TOOL_DEFS` (including all `llm_capabilities` entries plus `ask_model` and `list_models`). Called by Claude Code as a local MCP server — registered in `~/.claude.json` by `install.sh`.

## Key Environment Variables

| Variable | Effect |
|---|---|
| `CLAUDE_PROXY_BYPASS=1` | Skip proxy entirely — use transparent Anthropic path |
| `CLAUDE_ROUTER_DEBUG=1` | Print resolved env to stderr |
| `CLAUDE_ROUTER_DEBUG=2` | + proxy port, OLLAMA vars, route keys |
| `CLAUDE_PROXY_DEBUG=1/2` | Proxy-side verbose logs |
| `CLAUDE_PROFILE_DIR` | Override `~/.claude` location |
| `CLAUDE_MODEL_MAP_DEFAULTS_PATH` | Override shipped `config/model-map.json` path |
| `CLAUDE_MODEL_MAP_OVERRIDES_PATH` | Override `~/.claude/model-map.overrides.json` path |
| `CLAUDE_PROXY_HOOKS_PORT` | Fixed port for Phase 2 HTTP hooks listener (default `9998`) |
| `CLAUDE_LLM_MEMORY_GB` | Override RAM detection for hardware-tier selection (positive integer GB). Malformed values fall through to `os.totalmem()`. |

## No External Node Dependencies

`claude-proxy`, `llm-capabilities-mcp.js`, and all `model-map-*.js` helpers use Node.js stdlib only (`http`, `https`, `fs`, `path`, `crypto`, `child_process`). There is no `package.json` and no `node_modules/`. Do not add third-party deps.

## Proxy Observability

`claude-proxy` emits `x-c-thru-resolved-via` on capability responses (model alias requests): `{"capability": "workhorse", "profile": "workhorse", "served_by": "claude-sonnet-4-6"}`. Absent on non-capability requests. Consumed by hooks and statusline without log-parsing.

Per-profile `on_failure` field in `llm_profiles[hw][profile]`: `"cascade"` (default) walks the fallback chain; `"hard_fail"` returns null immediately so the proxy returns a clean error instead of a non-equivalent substitute.

Declared rewrites: (1) request body `model` field, (2) request URL + `Host`, (3) `Authorization` header, (4) SSE `usage` injection, (5) protocol translation (gated on `kind: "openai"`), (6) `x-c-thru-resolved-via` response header, (7) `model_overrides` unconditional name substitution before route graph traversal.

## Proxy Lifecycle

`claude-proxy` is a long-running HTTP server auto-spawned by `claude-router` when the backend needs it. The router coordinates via a `/ping` handshake on a dynamically-selected port. Logs land at `~/.claude/proxy.*.log`. Kill a stuck proxy with `pkill -f claude-proxy`.

## Contract integrity

Before committing changes to `skills/c-thru-plan/SKILL.md` or any `agents/*.md` file, run:
```sh
bash tools/c-thru-contract-check.sh   # exit 0 = clean; exit 1 = contract violations
```
Catches dangling `subagent_type` references, missing prompt keys vs. declared `Input:` lines, and accidental `Skill("review-plan")` invocations. Symlinked by `install.sh` to `~/.claude/tools/c-thru-contract-check`.

## Agentic plan/wave system

Invoke with `/c-thru-plan <intent>`. State in `.c-thru/plans/<slug>/`.
Skills in `skills/`, agents in `agents/`. See `docs/agent-architecture.md`.

### Capability aliases (new — agentic system)

| Alias | Cognitive tier | Agents |
|---|---|---|
| `judge` | 4–5 | planner, auditor, review-plan, final-reviewer, journal-digester |
| `judge-strict` | 4–5, hard_fail | security-reviewer |
| `orchestrator` | 2 | plan-orchestrator, integrator, doc-writer |
| `code-analyst` | 2–3 | test-writer, reviewer-fix |
| `pattern-coder` | 1 | scaffolder |
| `deep-coder` | 3 | implementer |

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
