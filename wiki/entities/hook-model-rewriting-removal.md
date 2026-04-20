---
name: Hook Model Rewriting Removal
type: entity
description: "Rule: model-field rewriting is the proxy's job; hooks may observe or gate but must not rewrite model (proxy-only, single source of truth)"
tags: [hooks, proxy, model-rewriting, architecture, scope]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-18
sources: [ed761c3c, 386b8e16]
related: [declared-rewrites, hook-safety-posture, ollama-http-api-migration]
---

# Hook Model Rewriting Removal

Model-field rewriting (logical alias → concrete model, route aliasing, fallback remap) is the c-thru proxy's exclusive responsibility per the declared-rewrites principle. Claude Code hooks may observe (log, inject context) or gate (refuse to proceed) but must not modify `tool_input.model` or `body.model`. A second rewriting path creates a silent source of drift from `config/model-map.json`.

- **From Session ed761c3c:** User observed `proxy.log` advancing even when c-thru wasn't routing the session, which prompted an audit of all hooks for model-rewriting behavior. Finding: only `claude-craft/plugins/model-router/handlers/model-router.sh` performed model rewriting (PreToolUse hook reading `model-map.json` and rewriting `tool_input.model` via route-alias chain up to 32 hops), and it was **unregistered** — never fired. The proxy already owns the identical surface via `resolveLogicalAlias()`, `resolveRouteModel()`, `resolveBackend()`, and `resolveFallbackModel()`. Plan: delete the dead plugin and record the proxy-only rule in `CLAUDE.md`.
- **From Session ed761c3c:** Adjacent issue: `c-thru-proxy-health.sh` and `c-thru-classify.sh` fire on every `UserPromptSubmit` globally, regardless of whether the session is routed through c-thru. This causes proxy.log noise and unnecessary HTTP hits on non-c-thru sessions. Needed guard: exit 0 early unless `$ANTHROPIC_BASE_URL` points at the proxy. Captured in `docs/planning/TODO-user-hook-model-rewriting.md`.
- **From Session 386b8e16:** The plan's "unregistered" finding was wrong — the model-router plugin was live via a symlink at `~/.claude/plugins/model-router → claude-craft/plugins/model-router`. It fired on every `PreToolUse/Agent` call (log confirmed, all with `rewritten=0`). After deleting the source from claude-craft, the symlink became dangling; it was removed. The original proxy-log noise the user noticed was caused by this plugin, not by the health/classify hooks (which already have `ANTHROPIC_BASE_URL` guards). Both `TODO-user-hook-model-rewriting` and `TODO-ollama-service-lifecycle` are now closed — the hooks self-gate and `warmOllamaModel` uses HTTP throughout. CLAUDE.md updated with a "Model rewriting: proxy-only" section codifying the single-writer rule.

→ See also: [[declared-rewrites]], [[hook-safety-posture]], [[ollama-http-api-migration]], [[readme-installer-alignment]]