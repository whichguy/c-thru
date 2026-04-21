---
name: LLM Mode Resolution
type: entity
description: "6-value llm_mode enum and resolveProfileModel() resolution semantics — modes[] sub-map, cloud-best-quality/local-best-quality convenience fields, test matrix mirror-drift guard"
tags: [architecture, model-map, modes, resolution, fallback, proxy]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [408250c4]
related: [capability-profile-model-layers, connectivity-vs-cascade, fallback-event-system, best-quality-modes]
---

# LLM Mode Resolution

Each profile entry in `llm_profiles[hw][capability]` may include an optional `modes` sub-map that overrides the resolved model for specific `llm_mode` values. The `resolveProfileModel(entry, mode)` function in `tools/model-map-resolve.js` defines the full resolution precedence:

1. `entry.modes[mode]` if present (sparse override wins)
2. Mode-based defaults:

| Mode | Default when `modes[mode]` absent |
|---|---|
| `offline` | `disconnect_model` |
| `semi-offload` | `disconnect_model` |
| `cloud-judge-only` | `disconnect_model` |
| `connected` | `connected_model` |
| `cloud-best-quality` | `cloud_best_model ?? connected_model` |
| `local-best-quality` | `local_best_model ?? disconnect_model` |

`resolveProfileModel` returns `null` when `entry` is null or undefined (null-guard added 2026-04-21 to match the existing test stub behaviour).

Test matrix at `test/llm-mode-resolution-matrix.test.js` (17 sections, 226 assertions) validates all (hw-tier × mode × capability) triples against the shipped config. Section 18 is a mirror-drift guard: it imports the real resolver and compares its output with the test stub for key inputs, asserting they remain identical — preventing the test stub from silently diverging when the resolver changes.

- **From Session 408250c4:** `llm_mode` started as a 4-value enum: `connected` | `semi-offload` | `cloud-judge-only` | `offline`. Replaces legacy `llm_connectivity_mode` (binary `connected`/`disconnect`). Resolution precedence: `CLAUDE_LLM_MODE` env → `CLAUDE_CONNECTIVITY_MODE` (legacy alias) → `CONFIG.llm_mode` → `CONFIG.llm_connectivity_mode` (legacy) → `'connected'`. The legacy value `'disconnect'` maps to `'offline'`.
- **From Session 408250c4:** `modes[]` is sparse — only capabilities that need mode-specific overrides (judge, judge-strict, orchestrator, local-planner on 48gb/64gb/128gb tiers) have entries. Capabilities without a `modes` key fall through to `disconnect_model` for `semi-offload`/`cloud-judge-only`/`offline`, or `connected_model` for `connected`. This means low-ram tiers (16gb, 32gb) degrade gracefully — they have no cloud models, so `semi-offload` stays local.
- **From Session feat/best-quality-modes (2026-04-21):** Enum extended to 6 values by adding `cloud-best-quality` and `local-best-quality`. Two new optional convenience fields on profile entries: `cloud_best_model` (falls through to `connected_model` when absent) and `local_best_model` (falls through to `disconnect_model`). `quality_tolerance_pct` implemented as a top-level config field (default 5%) — the pre-flight fallback (`resolveFallbackModel`) and active-path fallback (`buildFallbackCandidatesFromChain`) both apply the quality-tolerance tiebreaker in best-quality modes. See [[best-quality-modes]] for full schema and worked examples.

→ See also: [[capability-profile-model-layers]], [[connectivity-vs-cascade]], [[fallback-event-system]], [[best-quality-modes]], [[model-map-test-pattern]]