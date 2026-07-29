# Residual: installer / lifecycle (post README alignment)

**Status:** user-facing README / onboarding alignment is current (Honest Onboarding docs tranche `d5c4482`, plus residual secondary-doc pass).  
**This file tracks residual installer and lifecycle items only** — not a claim that the product README is outdated.

## Resolved (do not reopen as “README drift”)

- Ephemeral fleet hooks + MCP inject on the CLI path; durable global fleet-hook re-wiring is not the primary design
- Non-destructive model-map system / overrides seeding
- Plugin hook inventory (including PostToolUse for map-changed) documented via plugin bundle + CLAUDE ephemeral surfaces
- `uninstall.sh` exists (supports `--dry-run`); user-facing docs use `bash uninstall.sh` (README, getting-started, functionality-map)
- Install invocation honesty: docs use `bash install.sh` (install is tracked non-executable; no chmod+x in docs tranche)
- `CLAUDE_PROXY_OLLAMA_KEEP_ALIVE` documented in `docs/env-vars.md` (default `60m`)
- Ollama **wire** path is HTTP (`/v1/messages`); optional Ollama **CLI** remains for local model prep / lifecycle convenience
- Env names `CLAUDE_PROXY_OLLAMA_PULL_TIMEOUT_MS` / `…_WARM_TIMEOUT_MS` are **gone** from code (do not re-document)
- Derived-artifact drift gate is suite Validators (`gen-routing-doc.js --check` in `make test` / `run-all.sh`), not a required `.githooks/pre-commit`
- **Node missing/old policy:** soft-warn is accepted (installer continues after warning; does not hard-fail). Closing as product decision unless a later installer redesign lands.
- Wiki entity `wiki/entities/readme-installer-alignment.md` superseded to point at residual TODO (2026-07-29)

## Open residuals

| Item | Priority | Notes |
|------|----------|-------|
| `install.sh --dry-run` | P3 | Optional feature; uninstall already has dry-run. Leave unless requested. |
| Delete dead `install_skills_cthru()` | P2 | No call site; separate code commit. Docs note in `docs/orphan-disposition.md`. |
| Makefile + `test/run-all.sh` gate comments | P2 | Primary docs/derived-artifacts already say suite Validators; Makefile/`run-all.sh` comment nits deferred — those files have large unrelated WIP in the shared tree. |

## Non-goals for residual cleanup

- Restoring a deleted `.githooks/` tree without a separate product decision
- Reintroducing durable fleet hooks into profile settings as the default install path
- Documenting unlanded launcher flags/routes ahead of their code commits
- chmod+x on `install.sh` (docs path is `bash install.sh`)
