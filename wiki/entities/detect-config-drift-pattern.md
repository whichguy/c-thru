---
name: Detect-Config-Drift Pattern
type: entity
description: "Reusable utility pattern for finding keys in a derived/merged file that did not originate from any canonical source — basis for --detect-pollution and check-config-drift"
tags: [architecture, drift-detection, config-management, patterns]
confidence: high
last_verified: 2026-04-26
created: 2026-04-26
last_updated: 2026-04-26
sources: [57bc02a, 7dc6376, db915b7]
related: [detect-clean-twin-flag-convention, rebuild-not-patch-derived-files, hook-safety-posture]
---

# Detect-Config-Drift Pattern

## Core idea

"Anything in a derived file that is not reproducible from its canonical sources is drift."

A derived file is one that is computed from one or more authoritative inputs rather than edited directly. In c-thru this includes:

- `~/.claude/model-map.json` — merged from `model-map.system.json` + `model-map.overrides.json`
- `~/.claude/settings.json` — merged from system settings + local project settings
- Any agent manifest or compiled config that is re-generated on install/reload

Drift occurs when a key lands in the derived file via some out-of-band path (direct edit, a tool that patched instead of rebuilding, a stale merge) and then persists undetected.

## Utility signature

```js
detectConfigDrift(canonicalSources, derivedObject)
// returns { leaks: [{ path: string, value: unknown }] }
```

- `canonicalSources`: array of objects (e.g. `[systemMap, overridesMap]`) whose union defines the valid key space.
- `derivedObject`: the live merged result to audit.
- Returns every key path present in `derivedObject` that cannot be traced back to any canonical source.

The caller decides what to do with `leaks`: warn, exit non-zero under `--strict`, or invoke the clean path.

## Current instances

| Tool | Detect flag | Clean flag | Notes |
|------|-------------|------------|-------|
| `tools/model-map-config.js` | `--detect-pollution` | `--clean-pollution` | Full implementation with `--strict` for CI; clean path calls `maybeSyncLayeredProfileModelMap()` (rebuild, not patch) |
| `tools/c-thru` | `check-config-drift` subcommand | — | Drift report only; delegates fix to model-map-config.js |

The `--detect-pollution` / `--clean-pollution` pair was introduced in commit `57bc02a` and widened in `7dc6376` after the pollution detection surface was found to be narrower than the real key space.

## How to apply when adding a new derived file

1. Identify the canonical sources (the inputs that would recreate the derived file on a fresh install).
2. Implement a `detectConfigDrift(sources, derived)` call that returns `leaks`.
3. Wire it into `--detect-X` (dry-run, prints leaks, exits 0 unless `--strict`).
4. Wire the clean path into `--clean-X` as a full rebuild from canonical sources — not a surgical delete (see [[rebuild-not-patch-derived-files]]).
5. Optionally register the check in the `SessionStart` hook so drift surfaces at startup rather than silently accumulating.

## Why this matters

Without a drift detector, out-of-band edits to derived files survive upgrades indefinitely. The proxy reads the derived `~/.claude/model-map.json`; a polluted entry there can silently redirect all traffic for a capability alias to the wrong model, with no error — just wrong behavior.

→ See also: [[detect-clean-twin-flag-convention]], [[rebuild-not-patch-derived-files]], [[hook-safety-posture]]
