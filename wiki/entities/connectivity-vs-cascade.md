---
name: Connectivity Mode vs Cascade
type: entity
description: "Two distinct fallback primitives: proactive global swap (connectivity liveness prober) vs reactive per-request cascade. Phase B blocked on choosing which semantics to preserve under v1.2 schema."
tags: [architecture, fallback, connectivity, cascade, design-decision]
confidence: medium
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-18
sources: [9d601210]
related: [capability-profile-model-layers, fallback-event-system, config-swap-invariant]
---

# Connectivity Mode vs Cascade

There are two fundamentally different fallback primitives in c-thru. **Connectivity-mode** (`CLAUDE_CONNECTIVITY_MODE`) is a proactive global swap: a liveness prober detects network changes and rotates `connected_model` / `disconnect_model` across all requests. **Cascade** is a reactive per-request fallback: when one model fails mid-request, the next equivalent in the chain is tried. These are different triggers with different semantics — collapsing them into env-var rotation alone (`preferred_model_env`) loses the proactive swap.

- **From Session 9d601210:** Phase B of the v1.2 schema migration is explicitly blocked on deciding whether to (a) keep the liveness prober and wire it to write `FLAGSHIP` / profile env-vars, or (b) drop proactive switching in favor of cascade-on-failure only. The decision must be documented in `wiki/entities/capability-profile-model-layers.md` under a `## Connectivity decision` section before Phase B merges. A connectivity-mode spike (instrumenting the prober to measure real flip frequency) must ship as its own PR before the Phase B decision PR.

→ See also: [[capability-profile-model-layers]], [[fallback-event-system]], [[config-swap-invariant]]