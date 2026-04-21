---
name: Capability-Profile-Model Layers
type: entity
description: "3-layer model resolution: capability (alias) → profile (hardware-tier binding) → model (concrete name). Fallbacks belong at the capability layer, not the model layer."
tags: [architecture, model-map, fallback, layers, schema]
confidence: high
last_verified: 2026-04-21
last_updated: 2026-04-21
created: 2026-04-18
sources: [386b8e16, 9d601210, 64f2589b]
related: [logical-role-exclusivity, declared-rewrites, fallback-event-system, ollama-http-api-migration]
---

# Capability-Profile-Model Layers

The model resolution architecture has three distinct layers. **Capability** (logical role alias like `workhorse`, `classifier`, `coder`) maps to a **Profile** (hardware-tier binding like `64gb.workhorse.connected_model` = `qwen3:35b`) which resolves to a concrete **Model** name (`qwen3:35b`, `gemma4:26b-a4b`). The key insight: fallbacks are equivalence alternatives within a capability slot, not within a model name — so `fallback_strategies` should be keyed by capability alias, not by concrete model name.

- **From Session 386b8e16:** Current `fallback_strategies` schema is keyed by concrete model (`glm-5.1:cloud → gemma4:26b-a4b`), which is a layer mismatch. Under the 3-layer model, fallbacks say "if the model serving this capability slot fails, use these equivalents" — they belong at the capability/profile alias level. The logical-role-exclusivity code already tracks by `LLM_PROFILE_ALIASES` keys, not concrete model names, so it won't need rework if fallback_strategies is re-keyed. This is a pending schema revision captured in `docs/planning/TODO-readme-installer-alignment.md` and `docs/planning/TODO-header-regex-fallback.md`.
- **From Session 386b8e16:** The three config layers map to code: `LLM_PROFILE_ALIASES` (capability), `llm_profiles[hw][alias]` (profile), and `model_routes`/backend resolution (model). Route aliases chain into profile aliases, so exclusivity and fallback logic land correctly at the capability layer.
- **From Session 9d601210:** v1.2 schema plan formalized: new top-level keys `schema_version: "1.2"`, `tool_capability_to_profile`, `profile_to_model`, and `models[].equivalents` array. `on_failure` per-profile (values: `cascade` | `hard_fail`). Activation is **dual-gated**: requires both `CLAUDE_PROXY_SCHEMA_V12=1` env var AND `config.schema_version === "1.2"` — env-var alone drifts from validated state. Phased rollout: Phase A (non-breaking, flag-gated), Phase B (flip default, blocked on connectivity-mode design decision), Phase C (remove legacy, 30 days after B). Phase A preserves byte-identical legacy behavior; rollback is unsetting the env var.
- **From Session 9d601210:** Critical subtlety for role-exclusivity: `resolveCapabilityV12` must inject `logicalRole` from the *profile name* (e.g. `heavy-worker`), NOT from `resolveBackend`'s return value — `resolveBackend` receives a concrete model name and would return `null` for `logicalRole`, silently breaking GPU memory management. This means `LLM_PROFILE_ALIASES` must be extended to include v1.2 profile names before v1.2 code paths activate.
- **From Session 9d601210:** `walkEquivalentsChain(equivalents, failureClass, visited)` replaces `fallback_strategies[model].event[class]` lookup on the v1.2 path. The `visited` set is seeded with the preferred model to prevent loops. On the legacy path, a visited-set guard is added to `resolveFallbackModel` as defense-in-depth. The two never fire together on the same request.
- **From Session 9d601210:** Review-plan FULL evaluation: Gate 1 clear (approach soundness PASS, existing code examined PASS). 6 Gate 2 findings resolved via plan edits: Q-G22 (commit Outputs/Pre-check markers), N8 (SIGHUP × v12 resolver: snapshot CONFIG at entry), N9 (env var docs), N34 (statusline/Stop-hook consumer lockstep), Q-C19 (Phase B reminder idempotency), Q-E2 (spurious — matches CLAUDE.md POST_IMPLEMENT).
- **From Session 9d601210:** Major design pivot: since nothing ships on v1.2 yet, the generational machinery is eliminatable. Instead of dual-gate (`CLAUDE_PROXY_SCHEMA_V12` + `schema_version`), phased A/B/C rollout, and migration script, use a **loader-level adapter**: when `model-map-layered.js` reads a tier with `fallback_strategies` but no `tool_capability_to_profile`, it synthesizes the new shape in-memory before returning. Legacy user overrides still work — transformed on read, never written back. Shipped config goes in new shape only. Removes: schema_version field, env gate, dual-resolver, migration script, deprecation warnings, Phase B/C reminder mechanism. Plan collapses from ~550 lines to ~250. Single resolver, single code path. Residual risk: legacy override that doesn't map cleanly to per-model `equivalents` — mitigated by one-line stderr warning on synthesis.

- **From Session 64f2589b:** Comprehensive model-map rewrite grounded in `ollama list` audit: 6 config tags replaced with actually-installed models. `gpt-oss:20b` (3.6B active MoE, o3-mini class) added as reviewer/orchestrator/deep-coder; `qwen3.5:35b-a3b-coding-nvfp4` (3B active MoE, code-specialized) added as coder on 48gb+; `qwen3.6:35b` replaces `qwen3.5:27b`/`qwen3.5:122b` in disconnect slots. Design principle: MoE models with 3-4B active params serve both speed-first and capability-first roles. See [[model-tag-audit-gap]] and [[moe-speed-capability-dual]].
- **From Session feat/hardware-profile-defaults (2026-04-18):** Loader-level adapter shipped. `maybeSynthesizeV12Keys` in `model-map-layered.js:loadLayeredConfig` synthesizes `tool_capability_to_profile` and `models[].equivalents` when legacy `fallback_strategies` present and `tool_capability_to_profile` absent. Module-scope `_v12WarnedOnce` guard ensures the stderr warning fires at most once per process. Legacy proxy code continues reading `fallback_strategies` unmodified — adapter is purely additive. Shipped `config/model-map.json` migrated to v1.2 (fallback_strategies removed, v1.2 keys added). Proxy detection aligned: `detectMemoryProfile` now delegates to `tools/hw-profile.js:tierForGb` for full 5-tier support instead of the previous 2-tier collapse. Hardware-tier banner added to `claude-router --list`. Three-file install layout (`model-map.system.json` / `model-map.overrides.json` / `model-map.json`) landed in `install.sh` with bootstrap migration and SIGHUP re-sync. 16-test fixture suite at `test/model-map-v12-adapter.test.js`.

## Connectivity decision

**Resolved (2026-04-20, feat/llm-mode-multi-provider):** The `reactive-only` branch was chosen. `llm_connectivity_mode` (binary `connected`/`disconnect`) is replaced by `llm_mode` (initially 4 values: `connected` | `semi-offload` | `cloud-judge-only` | `offline`; extended to 6 in feat/best-quality-modes — see addendum below). Per-request cascade on cloud failures (`classifyError` → `tryFallbackChain`) is retained and extended (401 + 400-credit-balance gaps filled). No proactive liveness prober, no global auto-flip. Mode is set statically via config/env or via `/map-model mode <value>` and applies per-request via `resolveProfileModel(entry, mode)`.

`llm_mode` resolution precedence: `CLAUDE_LLM_MODE` env → `CLAUDE_CONNECTIVITY_MODE` (legacy) → `CONFIG.llm_mode` → `CONFIG.llm_connectivity_mode` (legacy) → `'connected'`.

Profile entries may add a sparse `modes` sub-map: `modes[mode]` overrides the selected model for that mode only. Capabilities with no `modes` entry fall back to `disconnect_model` for `semi-offload`/`cloud-judge-only`/`offline`, or `connected_model` for `connected` and unknown.

See also: [[connectivity-vs-cascade]] (now closed by this decision).

**Extended (2026-04-21, feat/best-quality-modes):** Two new modes added to the 4-value enum, making it 6-value: `connected` | `semi-offload` | `cloud-judge-only` | `offline` | `cloud-best-quality` | `local-best-quality`.

Fallthrough rule for new modes when `modes[mode]` absent:
| Mode | Fallthrough |
|---|---|
| `cloud-best-quality` | `entry.cloud_best_model ?? entry.connected_model` |
| `local-best-quality` | `entry.local_best_model ?? entry.disconnect_model` |

Profile entries gain two optional convenience fields: `cloud_best_model` (string) and `local_best_model` (string). These are additive — omitting them leaves existing behavior intact.

The open TODO at lines 17–19 (fallbacks belong at capability layer) is now addressed: top-level `fallback_chains[tier][capability]` provides an ordered-by-quality fallback list at the capability level, superseding per-model `fallback_strategies` synthesis for covered `(tier, capability)` pairs. See [[best-quality-modes]] for schema detail and [[fallback-event-system]] for coexistence rules.

→ See also: [[logical-role-exclusivity]], [[declared-rewrites]], [[fallback-event-system]], [[best-quality-modes]], [[ollama-http-api-migration]], [[config-swap-invariant]], [[sighup-config-reload]], [[connectivity-vs-cascade]], [[model-map-test-pattern]], [[skill-config-reload-gaps]], [[llm-mode-resolution]]