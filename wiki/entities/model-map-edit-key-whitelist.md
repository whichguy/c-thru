---
name: Model-Map Edit Key Whitelist
type: entity
description: "applyUpdates() in model-map-edit.js only processes a fixed set of known config keys; unknown keys in the edit spec are silently dropped without warning"
tags: [model-map, config, edit, whitelist, gotcha]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [ddd426f8, 2a5c31f5, ca03c216, a82cecbf]
related: [config-swap-invariant, skill-config-reload-gaps, planner-default-integration, capability-profile-model-layers, self-recusal-chain]
---

# Model-Map Edit Key Whitelist

`model-map-edit.js`'s `applyUpdates(config, spec)` processes only a fixed set of known top-level keys from the edit spec. Any key not in this set is **silently dropped** — no error, no warning. This is a non-obvious constraint that catches implementers adding new config keys.

- **From Session ddd426f8:** Known keys processed by `applyUpdates`: `routes` (via `applyRouteUpdates`), `fallback_strategies` (via `applyFallbackUpdates`), `llm_profiles` (via `applyLlmProfilesUpdates`), `default_model`, `active_profile`, `llm_mode`, `self_update`, `backends`, `model_routes`. Keys like `planner_hint`, `fallback_chains`, `tool_capability_to_profile`, `quality_tolerance_pct` are NOT processed. Discovered during review-plan of the planner-default-integration plan: the original plan assumed `model-map-edit.js` could write `planner_hint` to overrides, but `applyUpdates` would silently drop it. The fix: `c-thru-config planning` uses direct `jq` write to `model-map.overrides.json` instead.
- **From Session ddd426f8:** Impact on new config keys: any new top-level key added to `config/model-map.json` must either (a) be added to the `applyUpdates` whitelist, or (b) be written via direct `jq` / file manipulation outside of `model-map-edit.js`. Option (b) creates a parallel write path that bypasses the layered schema validation; option (a) is preferred but requires a code change to `model-map-edit.js` for each new key.
- **From Session 2a5c31f5:** `planner_hint` confirmed as whitelist gap: `c-thru-config planning on/off` writes directly to `~/.claude/model-map.overrides.json` via jq tmp+mv (same pattern as `install.sh:register_hooks()`). The hook's opt-out probe reads it the same way. This direct-write pattern is stable but noted for a future `~/.claude/c-thru-prefs.json` migration that would consolidate UX preferences out of model-map overrides.
- **From Session ca03c216:** The `/update-model-research` skill's Phase 5 surfaces "model-map parameter default candidates" — per-model recommended API options (temperature, top_p, mirostat, etc.) ready for `config/model-map.json`. This would require a new top-level key (e.g., `per_model_defaults` or `options_defaults`) that must be added to the `applyUpdates` whitelist, or the skill would need to use direct `jq` writes (same pattern as `planner_hint`). Not yet implemented — see local-model-prompt-techniques.

- **From Session a82cecbf:** `PROFILE_KEYS` in `model-map-validate.js` is a parallel whitelist to `applyUpdates`: it lists the allowed capability aliases in `llm_profiles[tier]`. When adding new aliases (e.g. `deep-coder-cloud`, `code-analyst-cloud` for Wave-2), both the `llm_profiles` entries AND `PROFILE_KEYS` must be updated. The resolver is dynamic — new aliases in `llm_profiles[tier]` are recognized automatically — but the validator's hardcoded `PROFILE_KEYS` array is not. Discovered during Wave-2 config implementation: validation failed because the new aliases weren't in the allowlist.

→ See also: [[config-swap-invariant]], [[skill-config-reload-gaps]], [[planner-default-integration]], [[capability-profile-model-layers]], [[local-model-prompt-techniques]], [[self-recusal-chain]]