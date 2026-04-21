---
name: Best-Quality Modes
type: entity
description: "cloud-best-quality and local-best-quality llm_mode values — schema of cloud_best_model/local_best_model/fallback_chains, quality/speed score semantics, 5% tolerance tiebreaker, spike outcome"
tags: [proxy, llm-mode, fallback, config-schema, quality]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
last_updated: 2026-04-21
sources: [408250c4]
related: [capability-profile-model-layers, fallback-event-system, declared-rewrites, moe-speed-capability-dual, llm-mode-resolution]
---

# Best-Quality Modes

Two new `llm_mode` values added alongside the original four (`connected`, `semi-offload`, `cloud-judge-only`, `offline`):

- **`cloud-best-quality`** — use the best cloud model for each capability, ignoring speed.
- **`local-best-quality`** — use the best local model for each capability regardless of inference speed.

## Mode Resolution

`resolveProfileModel(entry, mode)` in `tools/model-map-resolve.js`:

| Mode | Fallthrough when `modes[mode]` absent |
|---|---|
| `cloud-best-quality` | `entry.cloud_best_model ?? entry.connected_model` |
| `local-best-quality` | `entry.local_best_model ?? entry.disconnect_model` |

The existing `modes[]` override map takes precedence for any mode, including the two new ones.

## Profile Entry Fields

Two new **optional** fields on `llm_profiles[tier][capability]` entries:

- `cloud_best_model` — the capability's preferred cloud model (e.g. `claude-opus-4-6` for `judge`).
- `local_best_model` — the capability's top-quality local model regardless of speed (e.g. `qwen3.6:35b` for `judge`).

These are additive — omitting both preserves existing behavior for every mode.

## `fallback_chains` Schema

Top-level key `fallback_chains` keyed by `(tier, capability)`:

```json
{
  "fallback_chains": {
    "64gb": {
      "judge": [
        { "model": "claude-opus-4-6",  "quality_score": 100, "speed_score": 50 },
        { "model": "qwen3.6:35b",      "quality_score": 80,  "speed_score": 60 },
        { "model": "gpt-oss:20b",      "quality_score": 75,  "speed_score": 90 }
      ]
    }
  }
}
```

- `model` — required non-empty string, candidate model name.
- `quality_score` — optional number 0–100, author-assigned quality rank.
- `speed_score` — optional number 0–100, inference speed estimate (higher = faster).

Capability-layer chains **win over** synthesized legacy `models[].equivalents` for matching `(tier, capability)` pairs (enforced in `model-map-layered.js:maybeSynthesizeV12Keys`).

`fallback_chains` lives at the top level (not nested under `llm_profiles[tier][capability]`) for three architectural reasons: (1) matches the shape of the existing `fallback_strategies` key it supersedes, preserving reader intuition; (2) keeps `llm_profiles` entries purely declarative of *which model to pick*, with *what to do on failure* at a parallel level — separation of primary and fallback concerns; (3) the layered merge (`model-map-layered.js`) already composes top-level keys cleanly; nesting under profiles would force a second merge path for overrides.

## Quality-Tolerance Tiebreaker

Active only when mode is `cloud-best-quality` or `local-best-quality` and at least one candidate has `quality_score`.

Algorithm (`applyQualityTolerance` in `tools/claude-proxy`):
1. Compute `threshold = topScore * (1 - tolerancePct / 100)`.
2. Split candidates into in-band (`quality_score >= threshold`) and out-of-band.
3. Within the in-band, sort by `speed_score` descending.
4. Concatenate: in-band (speed-sorted) + out-of-band (original quality rank).

Default tolerance: `quality_tolerance_pct: 5` (top-level config field, validated 0..100).
Hardcoded fallback constant: `DEFAULT_QUALITY_TOLERANCE_PCT = 5` in `tools/claude-proxy`.

**Example:** chain `[A=95, B=93, C=80]` with 5% tolerance and speeds `[A=50, B=70, C=95]`:
- Threshold = 95 × 0.95 = 90.25
- In-band: A, B. Out-of-band: C.
- Speed sort in-band: B(70) > A(50)
- Result: B → A → C
- So if A is the primary and fails: first fallback is B (in-band, fastest), not C.

## Local-Terminal Guard

Applies to **all** modes in both fallback paths:

1. **Pre-flight path** (`resolveFallbackModel` in `tools/claude-proxy`) — fires when the primary model is known dead via cooldown or health state before the request is sent.
2. **Active in-flight path** (`buildFallbackCandidatesFromChain` in `tools/claude-proxy`) — fires when the primary request fails during transmission (classified error or network failure). The guard is applied after filtering out the failed primary from the chain candidates.

In both paths: if the last remaining candidate routes to a non-local backend, `disconnect_model` from the capability's profile entry is appended as a terminal candidate. All `disconnect_model` values in the shipped config are verified to be `ollama_local` backends (no `:cloud` suffix, no `anthropic` kind) — see §12 of `test/llm-mode-resolution-matrix.test.js`.

`x-c-thru-resolved-via` header and `fallback.candidate_success` log both emit `local_terminal_appended: true` when the appended terminal serves the request.

## Seeded Capabilities (Spike Outcome)

Quality ordering derived from `wiki/entities/moe-speed-capability-dual.md`, `qwen-series-selection.md`, and `gpt-oss-model.md`. No wiki-stated ordering inversions found.

| Model | Quality | Speed | Notes |
|---|---|---|---|
| `claude-opus-4-6` | 100 | 50 | Top cloud, judge/judge-strict |
| `claude-sonnet-4-6` | 88 | 70 | Cloud general, orchestrator/planner |
| `qwen3-coder:30b` | 85 | 65 | 128gb deep-coder local best |
| `qwen3.5:35b-a3b-coding-nvfp4` | 82 | 85 | MoE, code-specialized, fast |
| `qwen3.6:35b` | 80 | 60 | Agentic coding, local judge/orch |
| `gpt-oss:20b` | 75 | 90 | o3-mini MoE, fast chain fallback |
| `gemma4:31b` | 70 | 50 | 128gb workhorse dense |
| `gemma4:26b` / `gemma4:26b-mxfp8` | 65 | 55–60 | 48gb/64gb workhorse local |
| `qwen3.5:9b` | 55 | 95 | Small dense, coder last-resort |
| `qwen3:1.7b` | 20 | 100 | Tiny, commit-message-generator |

Chains seeded for: `judge`, `orchestrator`, `deep-coder`, `local-planner`, `coder`, `workhorse`, `default` at 48gb/64gb/128gb.

`default` chain (48gb): `glm-5.1:cloud` (q=72, s=80) → `gpt-oss:20b` (q=75, s=90) → `gemma4:e4b` (local terminal).
`default` chain (64gb/128gb): `glm-5.1:cloud` (q=72, s=80) → `gpt-oss:20b` (q=75, s=90) → `gemma4:26b` (local terminal).

## Set Mode via Skill

```
/c-thru-config mode cloud-best-quality [--reload]
/c-thru-config mode local-best-quality [--reload]
```

Set per-capability best models:
```
/c-thru-config set-cloud-best-model judge claude-opus-4-6 [--tier 64gb] [--reload]
/c-thru-config set-local-best-model judge qwen3.6:35b [--tier 64gb] [--reload]
```

→ See also: [[capability-profile-model-layers]], [[fallback-event-system]], [[declared-rewrites]], [[moe-speed-capability-dual]]
