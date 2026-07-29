# Residual: installer / lifecycle (post README alignment)

**Status:** user-facing README / onboarding alignment treated as current (Honest Onboarding docs tranche).  
**This file tracks residual installer and lifecycle items only** — not a claim that the product README is outdated.

## Resolved (do not reopen as “README drift”)

- Ephemeral fleet hooks + MCP inject on the CLI path; durable global fleet-hook re-wiring is not the primary design
- Non-destructive model-map system / overrides seeding
- Plugin hook inventory (including PostToolUse for map-changed) documented via plugin bundle + CLAUDE ephemeral surfaces
- `uninstall.sh` exists (supports `--dry-run`); user-facing docs invoke via `bash uninstall.sh`
- Ollama **wire** path is HTTP (`/v1/messages`); optional Ollama **CLI** remains for local model prep / lifecycle convenience, not as a required proxy runtime dependency for Messages translation
- Env names `CLAUDE_PROXY_OLLAMA_PULL_TIMEOUT_MS` / `…_WARM_TIMEOUT_MS` are **gone** from code (do not re-document)

## Open residuals

| Item | Priority | Notes |
|------|----------|-------|
| Document `CLAUDE_PROXY_OLLAMA_KEEP_ALIVE` | P1 | Default `60m` in proxy; land in `docs/env-vars.md` with docs tranche |
| User-facing uninstall docs | P0 | Code done; document `bash uninstall.sh [--dry-run]` in README / getting-started |
| `install.sh` executable bit vs `bash install.sh` | P0 | Product chose **docs use `bash install.sh`** (no mode flip in docs tranche) |
| `install.sh --dry-run` | P3 | Optional; uninstall already has dry-run |
| Node missing/old: warn vs hard-fail | P3 | Product UX decision; installer currently warns |
| Delete dead `install_skills_cthru()` | P2 | Separate code commit; docs already note no call site |

## Non-goals for residual cleanup

- Restoring a deleted `.githooks/` tree without a separate product decision
- Reintroducing durable fleet hooks into profile settings as the default install path
- Documenting unlanded launcher flags/routes ahead of their code commits
