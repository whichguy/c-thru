---
name: Schema v1.2 Dual-Gate Activation
type: entity
description: "v1.2 resolver activates only when BOTH CLAUDE_PROXY_SCHEMA_V12=1 env var AND config.schema_version='1.2' are present — env-var alone drifts from validated state"
tags: [proxy, schema, activation, safety, dual-gate]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-18
sources: [9d601210]
related: [capability-profile-model-layers, config-swap-invariant, load-bearing-invariant]
---

# Schema v1.2 Dual-Gate Activation

The v1.2 capability/profile/model resolver activates only when two independent conditions are both true: the environment variable `CLAUDE_PROXY_SCHEMA_V12=1` is set AND `config.schema_version === "1.2"` is present in the loaded config. A single gate (env var alone) is insufficient because it's a process-level switch that can drift from what the validator has verified — the config file may lack the v1.2 sections entirely. The dual gate ensures the resolver only runs when the config actually contains the data structures it needs.

- **From Session 9d601210:** Asymmetric gate states must produce safe fallback: (a) `CLAUDE_PROXY_SCHEMA_V12=1` with `schema_version` absent — must fall back to legacy resolver with a single stderr warning, no crash; (b) `schema_version: "1.2"` in config with env var unset — must use legacy resolver silently. Both cases must match the legacy baseline exactly. The flag gate lives at the call site, not inside `resolveCapabilityV12` — any new caller must also gate on the env-var + schema_version pair.
- **From Session 9d601210:** PIVOT: this dual-gate mechanism is likely eliminatable since nothing ships on v1.2 yet. A loader-level adapter in `model-map-layered.js` can synthesize v1.2 shape from legacy config on read, making the dual-gate, `schema_version` field, and `CLAUDE_PROXY_SCHEMA_V12` env var unnecessary. The adapter emits a one-line stderr warning when synthesizing. Single resolver, single code path — no flag-gating required. See [[capability-profile-model-layers]] for the full pivot rationale.

→ See also: [[capability-profile-model-layers]], [[config-swap-invariant]], [[load-bearing-invariant]]