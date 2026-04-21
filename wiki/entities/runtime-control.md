---
name: Runtime Control
type: entity
description: "First-class CLI verbs (c-thru reload/restart) for proxy lifecycle, bulk Ollama pre-pull, and map-model deprecation — added in feat/skills-config-proxy-reload"
tags: [proxy, ollama, runtime, cli, skills, reload, restart]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [ddd426f8]
related: [sighup-config-reload, skill-config-reload-gaps, ollama-http-api-migration, config-swap-invariant]
---

# Runtime Control

First-class CLI verbs for managing the running proxy and Ollama model warm state. Both dispatch before the `ORIG_ARGS` loop so they work even if `validate_model_map_config` would fail on a bad config file.

- **From Session ddd426f8:** `c-thru reload` — reads `~/.claude/proxy.pid`, sends SIGHUP, polls `/ping` for 2s to confirm alive, prints new tier. Exit 1 on stale PID or crash. `c-thru restart [--force]` — SIGTERM → `wait_proxy_listener_gone` → re-spawn on `$CLAUDE_PROXY_PORT`. `--force` escalates to SIGKILL after 5s grace. Both reuse existing helpers (`wait_proxy_listener_gone`, `proxy_ping_json`, `router_pid_looks_like_proxy`).
- **From Session ddd426f8:** Skill equivalents: `/c-thru-config reload` (SIGHUP), `/c-thru-status fix` (apply recommendations + reload + show status), `/c-thru-config route|backend` now support `--reload` flag.
- **From Session ddd426f8:** `CLAUDE_ROUTER_OLLAMA_AUTOSTART` default flipped from `0` → `1`. New `ensure_active_tier_prepulled()` function runs at every router invocation before ORIG_ARGS parsing — collects all local Ollama models for the active hw tier, runs them through `ensure_ollama_running` in background. Stamp file at `$CLAUDE_PROFILE_DIR/.prepull-stamp-<tier>` invalidates when `model-map.json` mtime changes. Set `C_THRU_SKIP_PREPULL=1` to disable (CI/tests).
- **From Session ddd426f8:** `map-model` deprecated — `~/.claude/skills/map-model/SKILL.md` replaced with a redirect that prints a migration table and exits without writing config. All model-map edits now go through `/c-thru-config` → `model-map-edit.js` → `model-map.overrides.json`.
- **From Session ddd426f8:** `model-map-edit.js` now accepts `--reload` as a trailing flag. After a successful write it calls `c-thru reload` via `child_process.spawnSync`. Default (no flag) does not trigger reload — no surprise restarts for existing non-skill callers.

→ See also: [[sighup-config-reload]], [[skill-config-reload-gaps]], [[ollama-http-api-migration]], [[config-swap-invariant]]