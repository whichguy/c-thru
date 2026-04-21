---
name: Proxy Health Function Semantics
type: entity
description: "Two similarly-named functions in proxy-health-common.sh serve different consumers with different inclusion of 'recovering' — a cross-consumer constraint that must not be collapsed"
tags: [proxy, health, hooks, craft-hooks, semantics]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-21
sources: [0a18c44e]
related: [c-thru-statusline, hook-safety-posture, claude-code-hook-channels]
---

# Proxy Health Function Semantics

`proxy-health-common.sh` (in `claude-craft`) defines two functions that sound similar but serve different consumers with different semantics about the `recovering` state. `proxy_health_unhealthy_summary` generates human-readable state summaries (consumed by `proxy-health-session.sh` for SessionStart context). `proxy_health_is_unhealthy_transition` classifies state transitions for event gating (consumed by `proxy-health-notify.sh:40` to decide whether to fire a notification). The key difference: `recovering` is an unhealthy *summary* state (it should appear in status messages) but also an unhealthy *transition* (a transition TO recovering is a meaningful event worth notifying about). Removing `recovering` from either function has different blast radii — removing it from the summary function changes user-facing text, removing it from the transition function silently suppresses notifications.

- **From Session 0a18c44e:** Plan review caught that an initial proposal to remove `recovering` from `proxy_health_is_unhealthy_transition` would silently stop `proxy-health-notify.sh:40` from firing notifications on recovering transitions — a behavioral regression not acknowledged in the plan. Fix: only split `proxy_health_unhealthy_summary` (exclude recovering) and leave `proxy_health_is_unhealthy_transition` untouched. This is a cross-consumer constraint: two functions with similar names and overlapping state sets must be edited independently, with each consumer's contract checked before modifying either function.
- **From Session a9bb05a0:** jq null-string injection: all three summary functions (`unhealthy_summary`, `recovering_summary`, `recent_heal`) interpolated `.backend_id` (and `.at` in `recent_heal`) into jq string templates without null guards. When the health file has partially-written or malformed entries with `null` fields, jq produces the literal string `"null"` (not empty string), which passes bash `[[ -n "$VAR" ]]` in callers and injects the text "null" into SessionStart advisory context. Fix: add `and .backend_id != null` to `select()` predicates in both summary functions, and `and ($lt.backend_id != null) and ($lt.at != null)` to the `recent_heal` `if` condition. `proxy_health_is_unhealthy_transition` is pure bash (no jq) — no null risk, do not change.

→ See also: [[c-thru-statusline]], [[hook-safety-posture]], [[claude-code-hook-channels]]