---
name: Fallback Event System
type: entity
description: "Proxy's in-memory ring buffer + log-based event pipeline for recording and consuming fallback chain events (candidate_success, chain_start, liveness)"
tags: [proxy, fallback, events, ring-buffer, logging]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-18
sources: [b50c3df0]
related: [c-thru-statusline, ollama-http-api-migration, logical-role-exclusivity, capability-profile-model-layers]
---

# Fallback Event System

The c-thru proxy records fallback chain events in two parallel channels: an in-memory ring buffer (for programmatic consumers) and `~/.claude/proxy.log` (for shell-based consumers like hooks and statusline). The `fallback_strategies` config schema uses an `event` key to define chain definitions; the proxy, config validator, and router were aligned on this key name in a dedicated commit (90c3d7e).

- **From Session b50c3df0:** `fallbackEvents` is an in-memory ring buffer in the proxy (`tools/claude-proxy`) populated by `recordFallbackEvent` at `[fallback.candidate_success]`. It stores recent fallback events for the `/hooks/context` extension and the opt-in `osascript` notification channel. The ring buffer is volatile — it resets on proxy restart (acknowledged design tradeoff, not a bug).
- **From Session b50c3df0:** `fallback_strategies` in `config/model-map.json` uses an `event` key (not `events` or `strategy`) to define each fallback chain. A commit (90c3df0) aligned config, validator, and router on this key after discovering they had drifted. The chain wires `glm→gemma4:26b-a4b` as the primary fallback path.
- **From Session b50c3df0:** Correlation bug: `terminal_model` (the intended/primary model) was originally only logged in `chain_start`, but the Stop hook reads `candidate_success` lines. If `chain_start` was too old or missing, correlation broke. Fix: proxy now logs `terminal_model` directly into the `candidate_success` event so consumers read both fields from a single line (PR #7).

→ See also: [[c-thru-statusline]], [[ollama-http-api-migration]], [[logical-role-exclusivity]], [[capability-profile-model-layers]]