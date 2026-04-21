---
name: Skill Config/Reload Gaps
type: entity
description: "9 gaps in c-thru skill surface for managing proxy config state and lifecycle — overlapping skills, missing reload flags, no post-reload verification, stale proxy detection"
tags: [skills, config, proxy, reload, lifecycle, gaps]
confidence: high
last_verified: 2026-04-21
created: 2026-04-21
sources: [64f2589b, ddd426f8]
related: [sighup-config-reload, config-swap-invariant, declared-rewrites, capability-profile-model-layers, runtime-control]
---

# Skill Config/Reload Gaps

Inventory of 9 gaps found when auditing whether c-thru skills can change config state and restart the proxy as needed. The core issue: two overlapping skills write different files, and config mutations don't consistently trigger proxy reload.

- **From Session 64f2589b:** Two overlapping config-editor skills write to DIFFERENT files. `map-model` writes directly to `~/.claude/model-map.json` (the effective merged output) using `jq` — edits get clobbered by next `model-map-sync` run. `c-thru-config` writes to `~/.claude/model-map.overrides.json` via `model-map-edit.js` (layered). `map-model` is effectively broken under the layered schema. Skills in scope: `c-thru-config` (layered), `map-model` (older, direct `jq`), `model-map` (proxy lifecycle — reload/restart/edit/validate/show).
- **From Session 64f2589b:** `c-thru-config route` and `c-thru-config backend` have no `--reload` flag (unlike `mode` and `remap`). They only print "run '/c-thru-config reload' to apply" — forcing a manual second command. The running proxy stays stale until the user manually reloads.
- **From Session 64f2589b:** No skill verifies post-reload that the new config is active. `model-map reload` tails the log for a SIGHUP message but nothing re-queries `/ping` or `/v1/models` to confirm new routes/backends are live. `c-thru-config diag` detects staleness via mtime check but doesn't do a round-trip test.
- **From Session 64f2589b:** `c-thru-status` is read-only with no escape hatch — when it reports a broken backend, the user must manually pick another skill to fix it. No "fix it" action available.
- **From Session 64f2589b:** `map-model`'s `update now`, `provider`, and `recommendations reset` all edit config but never trigger a reload. They depend on the proxy's internal `fs.watch`/mtime polling (debounced 50ms, `claude-proxy:319-333`) — can miss changes if proxy is paused or not running at all.
- **From Session 64f2589b:** No skill exposes `restart` alongside edit. `/model-map restart` exists but is isolated from the editors. After a `route`/`backend` change it may be safer to restart than SIGHUP (backend URL changes may invalidate pooled connections), but neither editor skill offers that option.
- **From Session 64f2589b:** `model-map-sync.js` and `model-map-apply-recommendations.js` are NEVER invoked from any SKILL.md — syncing the effective config after an overrides edit is implicit (handled in `model-map-edit.js`), but recommendations application is only triggered at router startup. No runtime skill rebuilds the effective map from recommendations.
- **From Session 64f2589b:** `/c-thru-config reload` silently succeeds even when there's no proxy running (prints "proxy may not be running" and exit 0). A config edit made while the proxy is dead is effectively deferred to next spawn, with no reminder that changes are queued.
- **From Session 64f2589b:** Proxy restart mechanism: no explicit `c-thru restart` CLI. The router restarts the proxy only when it detects a config-path mismatch on `/ping` (`tools/c-thru:1031-1058`). If pid unknown, prints a warning and does NOT restart. Other kills (lines 845, 852, 955, 1014, 1165) are for router-spawned child cleanup on exit, not reload.
- **From Session ddd426f8:** Gaps resolved by feat/skills-config-proxy-reload: (1) map-model deprecated — single canonical editor is `c-thru-config` writing to overrides.json. (2) `--reload` flag unified across ALL mutating subcommands (route, backend, update, provider, recommendations). (3) `c-thru reload` + `/ping` verification provides post-reload confirmation. (4) `c-thru-status fix` provides a "fix it" action. (5) `model-map-sync.js` gap addressed by `model-map-edit.js --reload` which calls `c-thru reload` after write. (6) `c-thru restart [--force]` provides first-class restart CLI. (7) `CLAUDE_ROUTER_OLLAMA_AUTOSTART` flipped to default 1, closing the "Ollama not started" gap. Remaining: (8) `c-thru-config reload` still exits 0 when no proxy running (deferred to next spawn). (9) `model-map-apply-recommendations.js` still only invoked at startup, not from any skill.

→ See also: [[sighup-config-reload]], [[config-swap-invariant]], [[declared-rewrites]], [[capability-profile-model-layers]], [[runtime-control]], [[model-map-edit-key-whitelist]]