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

`default` chain (48gb): `gpt-oss:20b` (q=75, s=90) → `glm-5.1:cloud` (q=72, s=80) → `gemma4:e4b` (local terminal).
`default` chain (64gb/128gb): `gpt-oss:20b` (q=75, s=90) → `glm-5.1:cloud` (q=72, s=80) → `gemma4:26b` (local terminal).

Chains are quality-sorted descending so both active-path (order-preserving) and pre-flight (tiebreaker-aware) give consistent results. When the primary (`glm-5.1:cloud`) fails, `gpt-oss:20b` is tried first — correct, since it has higher quality.

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

- **From Session c6237d83:** Critical post-merge finding: active-path fallback was dead. The dispatch gate (line 2479) only entered `handleRequestWithFallback` when `fallback_strategies[terminalModel]` existed — empty in shipped config, so every capability request took the direct `forwardAnthropic` path, returning 502 on 429/5xx with no recovery. Three-site fix: (1) dispatch gate also routes through when `fallback_chains[hw][capKey]` exists, (2) early-return guard inside `handleRequestWithFallback` skips `doForward` when a chain exists, (3) active error handlers consult `fallback_chains` when `fallback_strategies` yields nothing.
- **From Session c6237d83:** Validator gap: `fallback_chains[].model` strings were not verified against `model_routes`. Typos like `claude-opux-4-6` would silently route to the Ollama default backend. Fixed by threading `model_routes` into `validateFallbackChains` (direct key + `re:` pattern match). `@backend` sigils exempted — the sigil IS the routing.
- **From Session c6237d83:** `applyQualityTolerance` with all-null `quality_score`: preserves original chain order (no re-sorting). Partially null: null-score candidates sort after scored ones. Tested in §16 of `test/llm-mode-resolution-matrix.test.js`.
- **From Session c6237d83:** Quality-sorting invariant: config `fallback_chains` must be quality-sorted descending. Active-path traversal is order-preserving (no re-sorting), while pre-flight applies the tiebreaker — both must produce consistent results. 7 inversions fixed in shipped config (e.g. `gpt-oss:20b` promoted above `glm-5.1:cloud` in `default` chains; `qwen3.6:35b` promoted above `gpt-oss:20b` in `deep-coder` 48gb/64gb). Test §19 validates shipped chains are quality-sorted; any future inversion is a test failure.
- **From Session c6237d83:** Ollama warm-up regression: when `hasCapChain` routes through `handleRequestWithFallback`, the inline primary HTTP path bypassed `ensureOllamaReadyOrSend` that the old direct `forwardOllama` path included. Fix: fire-and-forget `warmOllamaModel` before `up.write(bodyStr)`, gated on `backend.kind === 'ollama'`, matching what `attemptCandidate` already does for fallback candidates. General rule: new dispatch paths must inherit all side effects of the paths they replace.
- **From Session c6237d83:** Network-error handler tiebreaker asymmetry: the `up.on('error')` handler (ECONNREFUSED, timeout, stream destroy) called `buildFallbackCandidatesFromChain` with zero args, defaulting to `isBestQualityMode=false`. The classified-error handler (429/5xx) correctly passed `_isBqMode/_tolerancePct`. Both now pass the same args — a network failure in `cloud-best-quality` mode correctly speed-sorts within the tolerance band. Behavioral test §9 anchors this: `C(q=86, s=99)` is promoted above `B(q=87, s=30)` when both are in the 5% band.
- **From Session c6237d83:** Pre-flight structural parity fixes in `resolveFallbackModel`: (1) primary-model filtering — was building candidates from the full chain without removing the current primary; on proxy restart with empty cooldowns, the primary could be returned as its own fallback (wasted request to degraded backend). Now filters `primaryResolved` before tiebreaker. (2) Empty-set guard — early `return null` fired before the local-terminal guard when filtering left an empty set; now mirrors `buildFallbackCandidatesFromChain` by running the guard unconditionally. Test §20 verifies shipped config never hits the empty-set path; §10 tests the degenerate single-entry chain.

→ See also: [[capability-profile-model-layers]], [[fallback-event-system]], [[declared-rewrites]], [[moe-speed-capability-dual]], [[connectivity-vs-cascade]], [[uplift-cascade-pattern]]
