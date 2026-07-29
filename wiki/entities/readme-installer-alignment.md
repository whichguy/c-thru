---
name: README/Installer Alignment
type: entity
description: "Primary README/onboarding alignment landed (d5c4482); residual tracker is docs/planning/TODO-readme-installer-alignment.md"
tags: [docs, installer, alignment, readme, scoping]
confidence: high
last_verified: 2026-07-29
created: 2026-04-18
last_updated: 2026-07-29
sources: [ed761c3c, d5c4482]
related: [ollama-http-api-migration, hook-model-rewriting-removal, declared-rewrites, planner-default-integration]
---

# README/Installer Alignment

**Superseded for primary product docs (2026-07-29).** Honest Onboarding landed contributor `docs/getting-started.md`, HEAD-true README install/uninstall honesty (`bash install.sh`), `CLAUDE_PROXY_OLLAMA_KEEP_ALIVE` in `docs/env-vars.md`, and residual tracking at `docs/planning/TODO-readme-installer-alignment.md`.

## Current residual (see planning TODO)

- Optional `install.sh --dry-run`
- Dead `install_skills_cthru()` (no call site)
- Node soft-warn accepted as product policy (not hard-fail)

Do **not** reopen: undocumented KEEP_ALIVE, missing uninstall, or “README may be outdated” as a general claim.

## Historical notes

- **From Session ed761c3c:** Early gaps listed (Ollama CLI implication, env vars, hooks, uninstall, Node check, dry-run). Most closed by later installer design + `d5c4482` docs tranche.
- **From Session 2a5c31f5:** `CLAUDE_DIR` vs `CLAUDE_PROFILE_DIR` divergence fixed; profile-dir canonical.

→ See also: [[ollama-http-api-migration]], [[hook-model-rewriting-removal]], [[declared-rewrites]], [[planner-default-integration]]
