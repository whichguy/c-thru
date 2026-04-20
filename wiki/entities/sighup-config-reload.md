---
name: SIGHUP Config Reload
type: entity
description: "SIGHUP handler for claude-proxy triggers in-process config reload (not re-exec); full restart is pkill + router auto-respawn"
tags: [proxy, sighup, config-reload, lifecycle]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-18
sources: [6d09913f, b8f0466a, 386b8e16]
related: [router-lock-handshake, load-bearing-invariant, declared-rewrites]
---

# SIGHUP Config Reload

`claude-proxy` handles SIGHUP by calling `reloadConfigFromDisk()` in-process — it does NOT re-exec or restart. This matches the nginx/sshd convention and is safe for in-flight SSE streams. A full proxy restart is achieved by `pkill -f claude-proxy`; the router auto-respawns a new proxy on next invocation.

- **From Session 6d09913f:** Full re-exec (self-restart) was considered and rejected: if the proxy exits, the flock/READY lock releases, and the next router invocation spawns a new proxy on a potentially different port — but existing sessions still point at the old `ANTHROPIC_BASE_URL`. SIGHUP = config-reload-only avoids this race. The proxy already has `fs.watch`-based auto-reload (lines 290–309), but `fs.watch` can miss events on some platforms/filesystems; SIGHUP provides a user-visible control surface for forcing a reload.
- **From Session 6d09913f:** Implementation: add `process.on('SIGHUP', () => { if (reloadConfigFromDisk()) console.error('claude-proxy: config reloaded via SIGHUP') })` after the SIGINT handler (line 2630). `reloadConfigFromDisk()` already exists at line 268. The proxy PID is discoverable via `~/.claude/proxy.pid` (written at server.listen) or `lsof -nP -iTCP:PORT -sTCP:LISTEN -t`. The `/ping` endpoint already exposes `config_path` and `config_source`. The planned `/model-map` skill will use `kill -HUP $(cat ~/.claude/proxy.pid)` to force reloads after config edits.
- **From Session b8f0466a:** Shipped: SIGHUP handler committed (b84ffa2), `/model-map` skill created at `~/.claude/skills/model-map/SKILL.md` with reload/restart/edit/validate/show subcommands. Two rounds of review found and fixed three latent bugs in `reloadConfigFromDisk` that SIGHUP made user-triggerable: (1) `process.exit` reachable via `validateRouteGraph` — now throws `Error` instead, (2) CONFIG swapped before validation — now validates `nextConfig` then assigns, (3) `CONFIG_MTIME_MS` captured after `statSync` could fail — now captured at read time before validation gates. Advisory items remaining: `validateWithNode` TOCTOU (reads disk, not in-memory `nextConfig`), silent spawn-error swallow in validateWithNode, and dead `try/catch` around `reloadConfigFromDisk()` in `fs.watch` callback.
- **From Session 386b8e16:** All three advisory items from b8f0466a resolved in three commits: (1) `0c79fde` — `validateRouteGraph` throws `Error` instead of `process.exit`; `validateWithNode` returns `bool` instead of `process.exit`. Both are now safe to call from hot-reload paths (SIGHUP + fs.watch). (2) `8409ce0` — `reloadConfigFromDisk` captures `mtime` before validation (via `fs.statSync` at read time) and validates `nextConfig` before assigning to `CONFIG`, eliminating the validate-after-swap and stat-after-failure bugs. (3) `9594a42` — `validateWithNode` accepts explicit `pathToValidate` arg; `reloadConfigFromDisk` writes `nextConfig` to a tmpfile (`os.tmpdir()/claude-proxy-validate-$PID.json`) for the validator, closing the TOCTOU. Silent `catch {}` replaced with logged error. Dead `try/catch` around `reloadConfigFromDisk()` in `fs.watch` callback removed (the function handles its own errors).

- **From Session 9d601210:** v1.2 plan review finding (N8): SIGHUP hot-reload × v1.2 resolver interaction not addressed — resolver should snapshot CONFIG at entry (not re-read global on each fallback step). Verification should include a reload-during-request test. Plan edited to add this constraint.

→ See also: [[router-lock-handshake]], [[load-bearing-invariant]], [[declared-rewrites]], [[capability-profile-model-layers]]