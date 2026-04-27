---
name: Rebuild-Not-Patch Derived Files
type: entity
description: "Architectural rule: when cleaning a derived/cached file always re-sync from canonical sources rather than surgically deleting individual keys — guarantees byte-identical state to a fresh install"
tags: [architecture, patterns, derived-files]
confidence: high
last_verified: 2026-04-26
created: 2026-04-26
last_updated: 2026-04-26
sources: [57bc02a, 7dc6376, 956d469]
related: [declared-rewrites, detect-config-drift-pattern, detect-clean-twin-flag-convention]
---

# Rebuild-Not-Patch Derived Files

## The rule

When cleaning a derived or cached file, **re-sync from canonical sources** rather than surgically deleting individual keys.

A "derived file" is one that is computed from authoritative inputs (e.g. `model-map.system.json` + `model-map.overrides.json` → `~/.claude/model-map.json`). It should be reproducible at any time from those inputs alone.

## Why patch-in-place is dangerous

Patching (delete key A, delete key B, …) leaves the file in a state that diverges from what a fresh install would produce:

- Keys added by a newer system update are not present.
- Key ordering or formatting may differ.
- A second pollution event between two patch runs leaves a window of inconsistency.
- Over time, a patched file accumulates subtle differences that make debugging harder ("why does my profile have this key?").

## The guarantee that rebuild provides

If the rebuild function is the same code path used during install, the resulting file is byte-identical to what a fresh install would produce. No residual state. No accumulated drift. The invariant is strong: the derived file is always exactly `f(canonical_sources)`.

## Demonstration in --clean-pollution

The `--clean-pollution` path in `tools/model-map-config.js` deliberately calls `maybeSyncLayeredProfileModelMap()` — the same full-rebuild function used at startup — rather than iterating over detected polluted keys and deleting them one by one. This was an intentional design choice recorded during the session that introduced the feature (commit `57bc02a`).

```
--clean-pollution path:
  1. Detect leaked keys (for reporting)
  2. Call maybeSyncLayeredProfileModelMap()   ← full rebuild from system + overrides
  3. Verify: re-run detect, expect zero leaks
```

The verify step at the end is important: it confirms the rebuild did not itself introduce drift (e.g. a bug in the sync function).

## Corollary: when is patch-in-place acceptable?

Only when both conditions hold:

1. A full rebuild is demonstrably too expensive (e.g. requires a network call or compilation step that takes tens of seconds).
2. The patch is provably complete — the set of things that need changing is fully enumerable and the patch covers all of them.

In practice, neither condition applies to the config files in c-thru. All derived config files are small JSON objects rebuilt from local disk reads in milliseconds. Default to rebuild.

## Scope of the rule

The rule applies to any file in the system that:

- Is computed from two or more inputs (layered merge, templating, code generation).
- Lives in a user-owned location (e.g. `~/.claude/`).
- Could accumulate drift if patched by multiple tools over time.

Current instances: `~/.claude/model-map.json`, any future compiled agent manifest, `~/.claude/settings.json` merge output.

→ See also: [[declared-rewrites]], [[detect-config-drift-pattern]], [[detect-clean-twin-flag-convention]]
