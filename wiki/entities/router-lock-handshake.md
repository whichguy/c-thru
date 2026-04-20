---
name: Router Lock Handshake
type: entity
description: "Flock/mkdir-based concurrency control between router instances — ensures exactly one proxy is spawned when multiple routers start concurrently"
tags: [router, concurrency, flock, mkdir, locking]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-18
sources: [be297e50, b8f0466a, b50c3df0]
related: [load-bearing-invariant, declared-rewrites, sighup-config-reload]
---

# Router Lock Handshake

When multiple `claude-router` instances start simultaneously (common in Claude Code sessions), they race to spawn a single `claude-proxy`. The lock ensures exactly one proxy is created. Two implementations exist: `flock -n` (preferred, available on macOS/Linux) and `mkdir` fallback (when `flock` is unavailable).

- **From Session be297e50:** The A1 race fix addressed two bugs in the non-blocking fallback path: (1) when `flock -n` finds the lock held, the second router calls `wait_proxy_ping_ready` without verifying the holder's spawn actually succeeded — if the first router's proxy never came up, the second returns success anyway; (2) the mkdir fallback treats any mkdir failure as EEXIST, but on EROFS/EACCES it silently proceeds with no lock. Fix: non-blocking path now re-acquires under a blocking lock if ping never comes up, or takes over the stale lockdir; mkdir path distinguishes EEXIST from other errors.
- **From Session be297e50:** The `mkdir_err_$$` file (used to capture mkdir's stderr) was originally written to `$PWD` — moved to `${TMPDIR:-/tmp}/claude-router-mkdir-err.$$.$RANDOM`. The `2>` redirection creates the error file even when mkdir succeeds, so cleanup was added on the success branch too.
- **From Session be297e50:** Open investigation (task #5): SIGHUP self-restart for the proxy. The interaction between SIGHUP, the router flock handshake, in-flight SSE streams, and launchd KeepAlive overlap needs analysis before implementation. Task #6 (update /model-map skill with SIGHUP knowledge) is blocked on this.
- **From Session 6d09913f:** Task #5 resolved: SIGHUP = config-reload-only, not re-exec. Re-exec was rejected because proxy exit releases the flock → next router spawns on a different port → stale ANTHROPIC_BASE_URL in existing sessions. SIGHUP calls `reloadConfigFromDisk()` in-process (safe for in-flight streams). Full restart = `pkill -f claude-proxy` + router auto-respawn. See [[sighup-config-reload]].
- **From Session b8f0466a:** Task #5 and #6 both shipped. SIGHUP handler implemented (b84ffa2) and `/model-map` skill created. Review found and fixed three latent `reloadConfigFromDisk` bugs (process.exit reachable, CONFIG swapped before validation, CONFIG_MTIME_MS ordering), confirming the flock/re-exec concern from 6d09913f was well-founded — a `process.exit` in the validator would have killed the proxy mid-stream on a bad SIGHUP.
- **From Session b50c3df0:** Default `CLAUDE_PROXY_PORT=9997` (commit 90c3d7e). Before this, each router invocation picked a free port dynamically. With a fixed default, concurrent router invocations (main session + classify hook + background subprocesses) converge on a single proxy via flock coordination in `ensure_proxy_running`, rather than each starting its own. This is the mechanism that makes the SIGHUP-reject-re-exec decision safe — the fixed port ensures existing sessions don't lose their `ANTHROPIC_BASE_URL` target.

→ See also: [[load-bearing-invariant]], [[declared-rewrites]], [[sighup-config-reload]]