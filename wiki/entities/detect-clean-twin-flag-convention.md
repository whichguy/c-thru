---
name: Detect-Clean Twin-Flag Convention
type: entity
description: "CLI convention: every destructive cleanup tool exposes --detect-X (dry-run audit) and --clean-X (idempotent apply) as a pair, with optional --strict for CI"
tags: [cli-conventions, patterns, safety]
confidence: high
last_verified: 2026-04-26
created: 2026-04-26
last_updated: 2026-04-26
sources: [57bc02a, 7dc6376, db915b7]
related: [detect-config-drift-pattern, rebuild-not-patch-derived-files]
---

# Detect-Clean Twin-Flag Convention

## Pattern

Every destructive helper in `tools/` that modifies user-owned files or removes resources should expose two paired flags:

| Flag | Semantics |
|------|-----------|
| `--detect-X` | Read-only audit. Reports what *would* be changed. Exits 0 (pass) unless `--strict` is also set. Safe to run in CI pre-flight. |
| `--clean-X` | Applies the correction. Idempotent — running it twice produces the same result as running it once. Does not prompt for confirmation. |

The optional `--strict` flag promotes `--detect-X` from informational to gate: exits non-zero if any drift is found, allowing CI to fail on pollution without running the clean path automatically.

## Rationale

Destructive operations are irreversible or expensive to undo (pruning Ollama models, removing profile keys). A dry-run path lets developers audit what the tool would do without committing, and lets CI detect drift without applying changes in an uncontrolled environment.

## Current status

| Tool | `--detect-X` | `--clean-X` | `--strict` | Notes |
|------|-------------|------------|-----------|-------|
| `tools/model-map-config.js` | `--detect-pollution` | `--clean-pollution` | Yes | Full implementation; clean path is a full rebuild, not a patch |
| `tools/c-thru-ollama-gc.sh` | Missing | `sweep` (destructive) | No | Gap: only the destructive path exists; `--detect-sweep` not yet implemented |

The `c-thru-ollama-gc.sh sweep` gap is a known risk: running `sweep` without first understanding what will be pruned can permanently remove pulled Ollama models. A `--detect-sweep` path should be added before `sweep` is promoted to any automated invocation.

## How to apply when adding a new cleanup tool

1. Write `--detect-X` first. It is always read-only: collect the set of things that would be changed and print them. Return exit 0.
2. Add `--strict` to `--detect-X` so CI pipelines can gate on drift without applying changes.
3. Write `--clean-X` second. Prefer a full rebuild over a surgical patch (see [[rebuild-not-patch-derived-files]]).
4. Document both flags in `c-thru --help` output and in the tool's own `--help`.

## Example: model-map-config.js

```sh
# dry-run: show what would be removed
node tools/model-map-config.js --detect-pollution

# gate in CI (exits 1 if any drift found)
node tools/model-map-config.js --detect-pollution --strict

# apply: rebuild derived map from canonical sources
node tools/model-map-config.js --clean-pollution
```

→ See also: [[detect-config-drift-pattern]], [[rebuild-not-patch-derived-files]]
