---
name: README/Installer Alignment
type: entity
description: "Gap between current README.md + install.sh and the actual c-thru code surface (Ollama HTTP migration, hook scoping, env vars, uninstall)"
tags: [docs, installer, alignment, readme, scoping]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-21
sources: [ed761c3c]
related: [ollama-http-api-migration, hook-model-rewriting-removal, declared-rewrites, planner-default-integration]
---

# README/Installer Alignment

Both `README.md` and `install.sh` were written early in c-thru's life and now lag behind the actual code surface. The Ollama HTTP migration (PRs #9-#12) removed the `ollama` CLI dependency, added new env vars, and changed hook behavior — none of which is reflected in docs or installer logic. Tracked at `docs/planning/TODO-readme-installer-alignment.md`.

- **From Session ed761c3c:** Known gaps: (1) README implies `ollama` CLI is required — it isn't; proxy uses HTTP API exclusively. (2) New env vars (`CLAUDE_PROXY_OLLAMA_PULL_TIMEOUT_MS`, `CLAUDE_PROXY_OLLAMA_WARM_TIMEOUT_MS`, `CLAUDE_PROXY_OLLAMA_KEEP_ALIVE`) undocumented. (3) Hook registrations need idempotent settings.json editing (currently manual). (4) Hook scoping question — which hooks should be GLOBAL vs SCOPED to only fire when `ANTHROPIC_BASE_URL` points at the proxy. (5) No uninstall path exists. (6) No Node version check (proxy needs `AbortController` → Node ≥ 15). (7) `install.sh` should have `--dry-run` mode.
- **From Session 2a5c31f5:** `install.sh` used `CLAUDE_DIR` for path resolution while hook scripts and SKILL.md use `CLAUDE_PROFILE_DIR` — diverging when the override is set. Fixed by making all three components use `${CLAUDE_PROFILE_DIR:-$HOME/.claude}` uniformly. Gap (3) partially closed by `install_planner_hint_hook()` which does idempotent settings.json editing with canonical-line detection.

→ See also: [[ollama-http-api-migration]], [[hook-model-rewriting-removal]], [[declared-rewrites]], [[planner-default-integration]]