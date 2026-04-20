---
name: Logical Role Exclusivity
type: entity
description: "Design concept for mapping logical worker roles (heavy, light, code) to single loaded Ollama models, with swap-on-mismatch using keep_alive:0"
tags: [ollama, model-lifecycle, swap, exclusivity, gpu-memory]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-18
sources: [b50c3df0, 386b8e16]
related: [ollama-http-api-migration, fallback-event-system, capability-profile-model-layers]
---

# Logical Role Exclusivity

A design pattern where each "logical role" (e.g. heavy-worker, light-worker, code-worker) maps to exactly one Ollama model loaded in GPU memory at a time. When a request targets a role whose current loaded model doesn't match, the proxy unloads the current model (`keep_alive: 0`) and loads the requested one. This prevents OOM from multiple models competing for GPU VRAM.

- **From Session b50c3df0:** User requested this as a TODO; recorded at `docs/planning/TODO-logical-role-exclusivity.md`. The swap mechanism depends on the Ollama HTTP API migration — specifically `/api/ps` to query loaded models and `keep_alive: 0` to explicitly unload. The async `ensureOllamaModelLoaded` migration and the `ollamaPs` helper landed in PR #12; remaining gap is using `/api/ps` for *role-tracking* (beyond the current "is model X loaded" check) and wiring swap-on-mismatch into the request path.
- **From Session b50c3df0:** Open design questions remain: crash recovery (what if the model that should be loaded isn't after an Ollama restart), eager-vs-lazy swap (unload immediately or wait for next request), and rollback when a new model fails to load (fall back to previous or error out).
- **From Session 386b8e16:** Implementation landed in PR #13. All open design questions resolved: (1) **Lazy swap** — unload only on next request for that role, not on config edit. (2) **Unload timing** — after `ollamaPull` succeeds, before `ollamaLoad` warm. Rationale: unloading `M_old` before confirming `M_new` is pullable risks a VRAM hole during long pulls. (3) **No rollback on `M_new` load failure** — `M_old` is on disk and Ollama can reload it; the proxy's fallback chain handles recovery, not explicit rollback. (4) **Crash recovery** — trust in-memory `roleBindings` map; on proxy restart it's empty, and the first request per role calls `/api/ps` to see what's loaded, warming without unload (conservative but safe). (5) **Scope** — only `LLM_PROFILE_ALIASES` (classifier, explorer, reviewer, workhorse, coder, general-default); route aliases chain into these anyway. (6) **Race** — serialized per-role via `roleSwapLocks: Map<role, Promise>` chain. New functions: `ollamaUnloadModel` (`keep_alive: 0`), `enforceRoleExclusivity` (compare-then-swap), `roleBindings` and `roleSwapLocks` maps. `resolveBackend` now computes and returns `logicalRole`; `ensureOllamaModelLoaded` and `ensureOllamaReadyOrSend` accept it as a param; all call sites thread it through.
- **From Session 386b8e16:** The role-exclusivity code sits at the right layer for the 3-layer model (capability → profile → model) — it tracks by capability alias (`LLM_PROFILE_ALIASES`), not concrete model names. This means it won't need rework if `fallback_strategies` is re-keyed from concrete model to capability alias. See [[capability-profile-model-layers]].

→ See also: [[ollama-http-api-migration]], [[fallback-event-system]], [[release-roadmap]], [[capability-profile-model-layers]]