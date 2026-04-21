---
name: Ollama HTTP API Migration
type: entity
description: "Migration of c-thru proxy's Ollama integration from CLI spawns to HTTP API calls (/api/generate, /api/pull, /api/ps)"
tags: [ollama, proxy, http-api, migration, keep-alive]
confidence: high
last_verified: 2026-04-21
created: 2026-04-18
last_updated: 2026-04-21
sources: [b50c3df0, ed761c3c, 386b8e16, ddd426f8, ca03c216]
related: [c-thru-statusline, logical-role-exclusivity, capability-profile-model-layers, ollama-endpoint-divergence, local-model-prompt-research]
---

# Ollama HTTP API Migration

The c-thru proxy is migrating its Ollama integration from CLI spawns (`ollama run`, `ollama pull`) to Ollama's HTTP API (`/api/generate`, `/api/pull`, `/api/ps`). CLI spawns block the Node event loop and lack fine-grained control over model lifecycle; the HTTP API provides `keep_alive` tuning, streaming NDJSON progress, and async-compatible request paths.

- **From Session b50c3df0:** `warmOllamaModel` migrated from `spawn('ollama', ['run', m, ''])` to `POST /api/generate` with `keep_alive: 30m` (configurable via `CLAUDE_PROXY_OLLAMA_KEEP_ALIVE`). This was the first completed slice — fire-and-forget, no request-path dependency. HTTPS transport selection (case-insensitive scheme check) and a 5s named timeout constant (`CLAUDE_PROXY_OLLAMA_TIMEOUT`) were added in review passes.
- **From Session b50c3df0 / PR #12:** `ensureOllamaModelLoaded` has been migrated from `spawnSync('ollama', …)` to async HTTP. New helpers: `ollamaListTags` (`/api/tags`), `ollamaPs` (`/api/ps`), `ollamaPull` (`/api/pull` streaming NDJSON with buffered `\n`-split parser and `AbortController` timeout tagged `ETIMEDOUT`), `ollamaLoad` (`/api/generate` fire-and-forget with `settled`/`settle` guard). `pullInFlight` Map dedups concurrent pulls by `backendUrl+'\0'+model`. 30-min pull ceiling via `CLAUDE_PROXY_OLLAMA_PULL_TIMEOUT_MS`. `ensureOllamaReadyOrSend` now async; sync `doForward` arrow wraps its Ollama branch in an async IIFE with a 500-on-rejection fallback (no silent swallow). Caveat: `options.num_ctx` on `/api/generate` does not persist to subsequent `/api/chat` calls — follow-up if observed in production.
- **From Session b50c3df0:** Cross-platform pitfall: the Stop hook originally used BSD-only `date -j` for ISO timestamp parsing; replaced with `node -e "Date.parse()"` for Linux/macOS portability. The `install.sh` node probe also needed safe argv-pass escaping to avoid shell expansion of `~`.
- **From Session ed761c3c:** Quality review found `ollamaLoad` could double-settle: `req.setTimeout` + `res.setTimeout` + `req.on('error')` + `res.on('end')` all could fire resolve/reject independently. Fix: unified `settled`/`settle()` single-shot guard routing all 4 terminators through one shot. Also, `pullInFlight` map key changed from simple string concat to `backendUrl+'\0'+model` to prevent collision (e.g., `host+a` + `model` vs `host` + `a+model`). Both landed in PR #12 alongside the main async migration.
- **From Session 386b8e16:** `TODO-ollama-service-lifecycle` closed — `warmOllamaModel` and all helpers now use HTTP throughout. New addition: `ollamaUnloadModel` (`keep_alive: 0`) added for logical-role exclusivity (PR #13), confirming the HTTP API migration is complete. No CLI spawns remain in the proxy.
- **From Session ddd426f8:** `CLAUDE_ROUTER_OLLAMA_AUTOSTART` default flipped from `0` → `1` — Ollama auto-starts on first router invocation. New `ensure_active_tier_prepulled()` in the bash router proactively pulls all active-tier Ollama models at startup (backgrounded, stamp-guarded by `model-map.json` mtime). This is the router-side complement to the proxy-side HTTP pull: the router calls `ensure_ollama_running` per model which triggers the proxy's HTTP `/api/pull` path. `C_THRU_SKIP_PREPULL=1` disables for CI/tests.

- **From Session ca03c216:** Version-fix re-pull invariant: Ollama version upgrades that fix model-specific bugs (penalty sampling, tool format) require `ollama pull <model>` to take effect. Without re-pulling, the old model state persists — the fix is in the model metadata/weights, not just the runner. This caused incorrect "silently ignored forever" claims that were later corrected when re-pull was performed.
- **From Session ca03c216:** The three Ollama API endpoints (`/api/chat`, `/api/generate`, `/v1/chat/completions`) have fundamentally different behavior for thinking mode, format constraints, and streaming — they are NOT interchangeable. This divergence is a proxy routing concern; see [[ollama-endpoint-divergence]].

→ See also: [[c-thru-statusline]], [[logical-role-exclusivity]], [[declared-rewrites]], [[release-roadmap]], [[fallback-event-system]], [[hook-model-rewriting-removal]], [[capability-profile-model-layers]], [[runtime-control]], [[local-model-prompt-techniques]]