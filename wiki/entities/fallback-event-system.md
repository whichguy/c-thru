---
name: Fallback Event System
type: entity
description: "Proxy's in-memory ring buffer + log-based event pipeline for recording and consuming fallback chain events (candidate_success, chain_start, liveness)"
tags: [proxy, fallback, events, ring-buffer, logging]
confidence: high
last_verified: 2026-04-21
created: 2026-04-18
last_updated: 2026-04-21
sources: [b50c3df0]
related: [c-thru-statusline, ollama-http-api-migration, logical-role-exclusivity, capability-profile-model-layers]
---

# Fallback Event System

The c-thru proxy records fallback chain events in two parallel channels: an in-memory ring buffer (for programmatic consumers) and `~/.claude/proxy.log` (for shell-based consumers like hooks and statusline). The `fallback_strategies` config schema uses an `event` key to define chain definitions; the proxy, config validator, and router were aligned on this key name in a dedicated commit (90c3d7e).

- **From Session b50c3df0:** `fallbackEvents` is an in-memory ring buffer in the proxy (`tools/claude-proxy`) populated by `recordFallbackEvent` at `[fallback.candidate_success]`. It stores recent fallback events for the `/hooks/context` extension and the opt-in `osascript` notification channel. The ring buffer is volatile — it resets on proxy restart (acknowledged design tradeoff, not a bug).
- **From Session b50c3df0:** `fallback_strategies` in `config/model-map.json` uses an `event` key (not `events` or `strategy`) to define each fallback chain. A commit (90c3df0) aligned config, validator, and router on this key after discovering they had drifted. The chain wires `glm→gemma4:26b-a4b` as the primary fallback path.
- **From Session b50c3df0:** Correlation bug: `terminal_model` (the intended/primary model) was originally only logged in `chain_start`, but the Stop hook reads `candidate_success` lines. If `chain_start` was too old or missing, correlation broke. Fix: proxy now logs `terminal_model` directly into the `candidate_success` event so consumers read both fields from a single line (PR #7).

**Extended (2026-04-21, feat/best-quality-modes):**

- **`fallback_chains` as capability-layer successor:** Top-level `fallback_chains[tier][capability]` (array of `{model, quality_score?, speed_score?}`) is the new capability-layer fallback source. In `resolveFallbackModel`, `fallback_chains[hw][capKey]` is checked first; if absent, the legacy `fallback_strategies[model].event[failureClass]` path is used. Coexistence is opt-in per capability — capabilities without a `fallback_chains` entry keep the synthesized legacy behavior untouched.
- **`local_terminal_appended` in `fallback.candidate_success`:** The ring-buffer event and proxy log now include `local_terminal_appended: true|false`. `true` when either `resolveFallbackModel` (pre-flight path) or `buildFallbackCandidatesFromChain` (active in-flight failure path) appended the profile entry's `disconnect_model` as a terminal candidate because the chain's last entry was non-local. The `x-c-thru-resolved-via` response header also carries `local_terminal_appended`.
- **Local-terminal guard — two paths:** If the last candidate in the resolved chain routes to a non-local backend, `disconnect_model` is appended as a terminal candidate. This guard runs in both: (1) the **pre-flight path** (`resolveFallbackModel` — when the primary is known dead via cooldown/health state before the request is sent), and (2) the **active in-flight path** (`buildFallbackCandidatesFromChain` — when the primary request fails during transmission). Both paths apply to all modes, not just best-quality modes.
- **Quality-tolerance tiebreaker:** Active only in `cloud-best-quality` / `local-best-quality` modes. Within the `quality_tolerance_pct` (default 5%) band of the top candidate, the proxy prefers higher `speed_score`. Outside the band, strict quality rank applies.
- **From Session c6237d83:** Critical bug: active-path fallback was dead post-merge. The dispatch gate (line 2479) only entered `handleRequestWithFallback` when `fallback_strategies[terminalModel]` existed — empty in shipped config. Every capability request took the direct `forwardAnthropic` path, meaning a 429/5xx returned 502 with no recovery. Root cause: `fallback_chains` was integrated only into the pre-flight path (`resolveFallbackModel`), not the dispatch gate or active error handlers. Fix required three coordinated changes: (1) dispatch gate also routes through when `fallback_chains[hw][capKey]` exists, (2) early-return guard inside `handleRequestWithFallback` skips `doForward` when a chain exists, (3) active error handlers (lines 2152, 2235) consult `fallback_chains` when `fallback_strategies` yields nothing. Lesson: adding a new fallback mechanism requires auditing ALL code paths that bypass the old one.
- **From Session c6237d83:** Pre-flight/active-path parity — `resolveFallbackModel` and `buildFallbackCandidatesFromChain` must have structurally identical guard semantics. Two gaps found and fixed: (1) `resolveFallbackModel` didn't filter the primary model from candidates; on proxy restart with empty cooldowns, the primary could be returned as its own fallback. (2) `resolveFallbackModel` had an early `return null` before the local-terminal guard when filtering left an empty set; `buildFallbackCandidatesFromChain` already handled this correctly. Invariant: the local-terminal guard must fire unconditionally in both paths before any early return.

→ See also: [[c-thru-statusline]], [[ollama-http-api-migration]], [[logical-role-exclusivity]], [[capability-profile-model-layers]], [[best-quality-modes]], [[uplift-cascade-pattern]], [[connectivity-vs-cascade]]