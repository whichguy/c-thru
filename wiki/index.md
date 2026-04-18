# Wiki Index — c-thru

## Pages

| Page | Summary | Last Updated |
|------|---------|--------------|
| [c-thru-statusline](entities/c-thru-statusline.md) | Stop hook + statusline overlay that surface proxy fallback state to the user (log-tail based, correlation fix, SessionStart label fix planned) | 2026-04-18 |
| [ollama-http-api-migration](entities/ollama-http-api-migration.md) | Migration of proxy Ollama integration from CLI spawns to HTTP API — complete; no CLI spawns remain (ollamaUnloadModel added in PR #13) | 2026-04-18 |
| [logical-role-exclusivity](entities/logical-role-exclusivity.md) | Implemented single-model-per-role GPU management: lazy swap, unload-after-pull, ollamaUnloadModel, roleBindings (PR #13) | 2026-04-18 |
| [declared-rewrites](entities/declared-rewrites.md) | Architectural rule: c-thru only transforms a declared list of fields; everything else passes byte-for-byte (transparent proxy, RFC 9110 §3.7) | 2026-04-18 |
| [load-bearing-invariant](entities/load-bearing-invariant.md) | Core safety guarantee: c-thru never blocks claude from working — worst case no-op via CLAUDE_PROXY_BYPASS=1 | 2026-04-18 |
| [hook-safety-posture](entities/hook-safety-posture.md) | Two-group hook safety: set -euo pipefail (fail-loud) vs set +e + ERR trap (always-exit-0) for Claude Code hooks | 2026-04-18 |
| [sse-buffer-sizing](entities/sse-buffer-sizing.md) | Bounded buffer for SSE frame accumulation in proxy Transform patcher — 512 MiB cap, early destroy on overflow | 2026-04-18 |
| [release-roadmap](entities/release-roadmap.md) | Phased release plan: 1.1a correctness, 1.1b stream lifecycle + observability, 1.2 schema upgrade, v2 local-first gateway | 2026-04-18 |
| [fallback-event-system](entities/fallback-event-system.md) | Proxy ring buffer + log pipeline for fallback chain events (candidate_success, chain_start, liveness) | 2026-04-18 |
| [router-lock-handshake](entities/router-lock-handshake.md) | Flock/mkdir concurrency control between router instances — ensures exactly one proxy spawns (A1 race fix, SIGHUP investigation) | 2026-04-18 |
| [narrow-threat-model](entities/narrow-threat-model.md) | Threat model: single-dev machine, no network adversary — only filesystem disclosure and proxy bugs are genuine threats | 2026-04-18 |
| [kind-anthropic-invariant](entities/kind-anthropic-invariant.md) | Schema rule: all shipped backends use kind: anthropic — no OpenAI-to-Anthropic translation in c-thru today | 2026-04-18 |
| [claude-code-hook-channels](entities/claude-code-hook-channels.md) | Which Claude Code hook channels reach the user (systemMessage, statusline, osascript) and which don't (custom headers, SessionStart stdout) | 2026-04-18 |
| [hook-model-rewriting-removal](entities/hook-model-rewriting-removal.md) | Proxy-only model rewriting: hooks observe/gate only; model-router plugin was live (not dead), removed; CLAUDE.md codified | 2026-04-18 |
| [capability-profile-model-layers](entities/capability-profile-model-layers.md) | 3-layer resolution model: capability (alias) → profile (hw-tier binding) → model (concrete name); fallbacks belong at capability layer; v1.2 schema plan with dual-gate activation | 2026-04-18 |
| [readme-installer-alignment](entities/readme-installer-alignment.md) | Gap between current README.md + install.sh and actual code surface (Ollama HTTP migration, hook scoping, env vars, uninstall) | 2026-04-18 |
| [proxy-health-function-semantics](entities/proxy-health-function-semantics.md) | Two proxy-health functions with overlapping state sets serve different consumers — must not be collapsed (summary vs transition classification) | 2026-04-18 |
| [connectivity-vs-cascade](entities/connectivity-vs-cascade.md) | Two distinct fallback primitives: proactive global swap (connectivity prober) vs reactive per-request cascade; Phase B blocked on choosing which to preserve | 2026-04-18 |
| [schema-v12-dual-gate](entities/schema-v12-dual-gate.md) | v1.2 resolver activates only when BOTH env var AND config schema_version present — env-var alone drifts from validated state | 2026-04-18 |
| [sighup-config-reload](entities/sighup-config-reload.md) | SIGHUP handler for claude-proxy triggers in-process config reload (not re-exec); full restart is pkill + router auto-respawn | 2026-04-18 |
| [config-swap-invariant](entities/config-swap-invariant.md) | Safety guarantee: a bad config on disk never replaces a good live config in reloadConfigFromDisk (validate-before-swap, atomic mtime) | 2026-04-18 |

## About

Maintained by Claude Code. See SCHEMA.md for conventions.
Two-tier system: this project wiki + global knowledge at ~/.claude/wiki/topics/.
Use /wiki-ingest to add sources, /wiki-query to synthesize answers, /wiki-load for JIT context.
