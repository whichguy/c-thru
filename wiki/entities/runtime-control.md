---
title: Runtime Control — reload, restart, bulk pre-pull
tags: [proxy, ollama, runtime, cli, skills]
---

# Runtime Control

Added in feat/skills-config-proxy-reload. Provides first-class CLI verbs for managing the running proxy and Ollama model warm state.

## CLI commands

| Command | Effect |
|---|---|
| `c-thru reload` | Sends SIGHUP to running proxy (reads `~/.claude/proxy.pid`), polls `/ping` for 2s to confirm alive, prints new tier. Exit 1 on stale PID or crash. |
| `c-thru restart [--force]` | SIGTERM → `wait_proxy_listener_gone` → re-spawn on `$CLAUDE_PROXY_PORT`. `--force` escalates to SIGKILL after 5s grace. |

Both dispatch before the `ORIG_ARGS` loop so they work even if `validate_model_map_config` would fail on a bad config file.

## Skill equivalents

- `/c-thru-config reload` — SIGHUP via skill (existing subcommand)
- `/c-thru-status fix` — apply recommended mappings + reload + show status
- `/c-thru-config mode|remap|route|backend` — all support `--reload` to auto-call `c-thru reload` after a successful write

## Ollama autostart default change

`CLAUDE_ROUTER_OLLAMA_AUTOSTART` default flipped from `0` → `1`. Ollama is now started automatically on first use. Opt out: `CLAUDE_ROUTER_OLLAMA_AUTOSTART=0`.

## Bulk pre-pull

`ensure_active_tier_prepulled()` runs at every router invocation (before ORIG_ARGS parsing). Collects all local Ollama models for the active hw tier via `collect_active_profile_local_ollama_models`, runs them through `ensure_ollama_running` in background.

Stamp file: `$CLAUDE_PROFILE_DIR/.prepull-stamp-<tier>` — invalidated when `model-map.json` mtime changes. Set `C_THRU_SKIP_PREPULL=1` to disable.

## /map-model deprecation

`~/.claude/skills/map-model/SKILL.md` replaced with a redirect that prints a migration table and exits without writing config. Use `/c-thru-config` for all model-map edits.

## model-map-edit.js --reload flag

`model-map-edit.js` now accepts `--reload` as a trailing flag. After a successful write it calls `c-thru reload` via `spawnSync`. Skills pass `--reload` to get automatic proxy reload; pass `--no-reload` (or omit) to skip.

## Related

- [[proxy-lifecycle]] — proxy spawn/shutdown lifecycle
- [[sighup-config-reload]] — SIGHUP handler in claude-proxy
- [[skill-config-reload-gaps]] — gaps this PR addressed
