# Wiki Index — c-thru

## Pages

| Page | Summary | Last Updated |
|------|---------|--------------|
| [c-thru-statusline](entities/c-thru-statusline.md) | Stop hook + statusline overlay that surface proxy fallback state to the user (log-tail based, correlation fix, SessionStart label fix planned) | 2026-04-18 |
| [ollama-http-api-migration](entities/ollama-http-api-migration.md) | Migration of proxy Ollama integration from CLI spawns to HTTP API — complete; dual-layer auto-pull (c-thru + proxy), autostart now default-on | 2026-04-21 |
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
| [capability-profile-model-layers](entities/capability-profile-model-layers.md) | 3-layer resolution model: capability (alias) → profile (hw-tier binding) → model (concrete name); fallbacks belong at capability layer; v1.2 schema plan with dual-gate activation | 2026-04-21 |
| [readme-installer-alignment](entities/readme-installer-alignment.md) | Gap between current README.md + install.sh and actual code surface (Ollama HTTP migration, hook scoping, env vars, uninstall, stale claude-router symlink) | 2026-04-21 |
| [proxy-health-function-semantics](entities/proxy-health-function-semantics.md) | Two proxy-health functions with overlapping state sets serve different consumers — must not be collapsed (summary vs transition classification) | 2026-04-18 |
| [connectivity-vs-cascade](entities/connectivity-vs-cascade.md) | Two distinct fallback primitives: proactive global swap (connectivity prober) vs reactive per-request cascade; Phase B blocked on choosing which to preserve | 2026-04-18 |
| [schema-v12-dual-gate](entities/schema-v12-dual-gate.md) | v1.2 resolver activates only when BOTH env var AND config schema_version present — env-var alone drifts from validated state | 2026-04-18 |
| [sighup-config-reload](entities/sighup-config-reload.md) | SIGHUP handler for claude-proxy triggers in-process config reload (not re-exec); full restart is pkill + router auto-respawn; c-thru reload CLI added | 2026-04-21 |
| [config-swap-invariant](entities/config-swap-invariant.md) | Safety guarantee: a bad config on disk never replaces a good live config in reloadConfigFromDisk (validate-before-swap, atomic mtime); c-thru reload verifies via /ping | 2026-04-21 |
| [review-plan-banner-alignment](entities/review-plan-banner-alignment.md) | Tier banner/scorecard width mismatch and emoji column-width bugs in review-plan SKILL.md (LLM pseudocode, hand-typed literals, pad formula) | 2026-04-20 |
| [model-tag-audit-gap](entities/model-tag-audit-gap.md) | Config model-map tags referencing Ollama models not installed locally — proxy falls back or fails silently unless tags match pulled models | 2026-04-21 |
| [gpt-oss-model](entities/gpt-oss-model.md) | OpenAI's first open-weight model (Apache 2.0, 21B/3.6B active MoE, o3-mini class) — ideal for reviewer/orchestrator/deep-coder slots | 2026-04-21 |
| [moe-speed-capability-dual](entities/moe-speed-capability-dual.md) | MoE models with 3-4B active params deliver both fast inference and high capability, eliminating the traditional speed-vs-quality tradeoff for role assignments | 2026-04-21 |
| [model-map-test-pattern](entities/model-map-test-pattern.md) | Test files referencing shipped config model names must be updated on tag changes; fixture-based tests using synthetic data are immune | 2026-04-20 |
| [qwen-series-selection](entities/qwen-series-selection.md) | Qwen3.5 vs qwen3.6 role fit — qwen3.6:35b for agentic coding, nvfp4 coding variant for coder, consolidation replacing 27b+122b | 2026-04-21 |
| [skill-config-reload-gaps](entities/skill-config-reload-gaps.md) | 9 gaps in c-thru skill surface for managing proxy config state and lifecycle — 7 resolved by ddd426f8, 2 remaining | 2026-04-21 |
| [runtime-control](entities/runtime-control.md) | First-class CLI verbs (c-thru reload/restart) for proxy lifecycle, bulk Ollama pre-pull, map-model deprecation, --reload unification | 2026-04-21 |
| [planner-signals-design](entities/planner-signals-design.md) | Trigger-based planning decomposition (when, not who/what) vs BMAD persona-relay vs SDD artifact-pipeline; constitution file rejected | 2026-04-21 |
| [uplift-cascade-pattern](entities/uplift-cascade-pattern.md) | Three-tier local→verify→decider cascade (accept|uplift|restart) with anchoring prevention; generalized across implementer/reviewer/test-writer/planner | 2026-04-21 |
| [agent-prompt-construction](entities/agent-prompt-construction.md) | 10 foundational principles for c-thru agent prompts — tiered token budgets, forcing functions, failure-mode modeling, scope elimination, calibration | 2026-04-21 |
| [best-quality-modes](entities/best-quality-modes.md) | cloud-best-quality and local-best-quality llm_mode values — cloud_best_model/local_best_model fields, fallback_chains schema, 5% tolerance tiebreaker, quality scores per tier | 2026-04-21 |
| [llm-mode-resolution](entities/llm-mode-resolution.md) | 6-value llm_mode enum, resolveProfileModel() semantics, cloud/local best-quality fallthrough, mirror-drift guard test | 2026-04-21 |
| [cascade-scope-contraction](entities/cascade-scope-contraction.md) | Decision to scope uplift-cascade Wave 1 to CONFIDENCE field + logging hook with kill-switch gate | 2026-04-21 |
| [planner-default-integration](entities/planner-default-integration.md) | Planner default integration for c-thru-plan hooks | 2026-04-21 |

## About

Maintained by Claude Code. See SCHEMA.md for conventions.
Two-tier system: this project wiki + global knowledge at ~/.claude/wiki/topics/.
Use /wiki-ingest to add sources, /wiki-query to synthesize answers, /wiki-load for JIT context.
