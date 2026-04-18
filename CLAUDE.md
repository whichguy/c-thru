# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Wiki
WIKI: /wiki-load <search> or browse wiki/index.md before answering project-domain questions. /wiki-query for synthesis.

## What This Repo Is

**c-thru** is the router/proxy layer that lets Claude Code talk to alternative model providers (Ollama, OpenRouter, Bedrock, Vertex, LiteLLM) without changing the vendor CLI. It was extracted from `claude-craft` as a standalone public repo.

## Install and Verify

```sh
./install.sh                            # symlinks tools into ~/.claude/tools/, seeds model-map
bash -n tools/claude-router             # bash syntax check
node --check tools/claude-proxy         # node syntax check
node --check tools/model-map-*.js tools/llm-capabilities-mcp.js
node tools/model-map-validate.js config/model-map.json   # validate shipped config
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
config/
  model-map.json          # shipped defaults (JSON5 — comments allowed)
```

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
- Model resolution order: `--route` flag → `routes.default` → `--model` flag → Ollama passthrough.

### 3-tier model-map lookup (model-map-layered.js)

1. `$PWD/.claude/model-map.json` — per-project overrides
2. `~/.claude/model-map.json` — user profile (seeded by `install.sh`)
3. `config/model-map.json` — shipped defaults

### llm-capabilities-mcp.js

MCP server (stdio transport). Exposes two tools: `list_models` and `classify_intent`. Called by Claude Code as a local MCP server — registered in `~/.claude.json` by `install.sh`.

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

## No External Node Dependencies

`claude-proxy`, `llm-capabilities-mcp.js`, and all `model-map-*.js` helpers use Node.js stdlib only (`http`, `https`, `fs`, `path`, `crypto`, `child_process`). There is no `package.json` and no `node_modules/`. Do not add third-party deps.

## Proxy Lifecycle

`claude-proxy` is a long-running HTTP server auto-spawned by `claude-router` when the backend needs it. The router coordinates via a `/ping` handshake on a dynamically-selected port. Logs land at `~/.claude/proxy.*.log`. Kill a stuck proxy with `pkill -f claude-proxy`.
