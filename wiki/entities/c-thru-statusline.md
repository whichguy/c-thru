---
title: c-thru statusline + Stop hook (fallback visibility)
type: entity
---

# c-thru fallback visibility

When the proxy chains from a dead primary (e.g. `glm-5.1:cloud`) to a
healthy local fallback (e.g. `gemma4:26b-a4b`), Claude Code does not read
the `x-claude-proxy-served-by` response header. To surface this to the
user, c-thru ships three artifacts driven off `~/.claude/proxy.log`.

## Source of truth

`~/.claude/proxy.log` is written by `proxyLog()` on every state
transition. The relevant events:

- `[fallback.candidate_success]` — fallback chain served a response
- `[fallback.chain_start]` — primary about to fail over; includes `terminal_model`
- `[liveness.mark_dead]` / `[liveness.mark_alive]` — primary state flips

No separate snapshot file is written; readers tail the log.

## Channels

| Channel | Artifact | Behavior |
|---|---|---|
| **Stop hook** (primary) | `tools/c-thru-stop-hook.sh` | Emits one `systemMessage` per NEW fallback event (2-min recency + tracker dedup). Always exits 0. |
| **Statusline overlay** | `tools/c-thru-statusline-overlay.sh` | Prints ` ⚠️  FALLBACK → <model>` if a fallback fired in the last 120 s, else nothing. Safe to append to any host statusline. |
| **Default statusline** | `tools/c-thru-statusline.sh` | `<model> | <cwd>` + overlay. For users with no existing statusline. |
| **Desktop notification** | proxy-fired, opt-in via `CLAUDE_PROXY_NOTIFY=1` | macOS `osascript` banner at the moment of fallback. AFK backup. |
| **Claude context** | `/hooks/context` extension | Adds `(c-thru) Last turn was served by <x> …` to `additionalContext` for 120 s so Claude can explain if asked. |

## Install

`install.sh` symlinks all three scripts into `~/.claude/tools/` but does
**not** rewrite existing `statusLine` or `hooks.Stop` entries. When
either is present the installer prints manual-integration instructions.

### Manual integration

Append overlay to your existing statusline:

```sh
printf '%s%s' "$your_existing_output" "$(sh ~/.claude/tools/c-thru-statusline-overlay 2>/dev/null)"
```

Register Stop hook (append to `hooks.Stop` in `~/.claude/settings.json`).
Note: `command` is not shell-expanded, so `~` will not resolve — use an
absolute path:

```json
{"hooks":[{"type":"command","command":"/Users/<you>/.claude/tools/c-thru-stop-hook","timeout":3}]}
```

## Session-safety contract

Both hooks and the overlay:

- use `set +e` + `trap 'exit 0' ERR`
- soft-fail on missing `jq` / missing / malformed log
- exit 0 on every path (never blocks Claude's response)
- Stop hook: prints either empty stdout or exactly one valid JSON object via `jq -cn`

The Stop hook uses `~/.claude/.c-thru-stop-hook-last-ts` (a single epoch-ms
integer) to dedupe — only NEW fallback events produce a `systemMessage`.

- **From Session b50c3df0:** Critical correlation bug: the Stop hook reads both `terminal_model` and the fallback model from the same `candidate_success` log line to pair "what should have served" with "what actually served". Originally `terminal_model` was only logged in `chain_start`, causing stale/missing correlation when the hook parsed `candidate_success` alone. Fix: proxy now logs `terminal_model` directly into the `candidate_success` event (PR #7).
- **From Session b50c3df0:** Design decision: `~/.claude/proxy.log` is the single source of truth, not a separate `proxy-status.json` snapshot. This eliminates atomic-write complexity in the proxy hot path and unifies the event stream. The Stop hook and statusline both tail the log; the `/hooks/context` extension reads the in-memory `fallbackEvents` ring buffer directly. An earlier draft used a snapshot file but the log-as-event-stream approach removed one file and one atomic-write dance.

## Why these channels

- Custom HTTP response headers (`x-claude-proxy-*`) — Claude Code ignores them.
- `SessionStart` stdout — regressed in Claude Code 2.1.37.
- `PostToolUse` + `systemMessage` — fires N× per turn (duplicate warnings).
- Hook exit 2 — shown as "hook error" to the user, misleading.

`Stop` fires exactly once per assistant response and `systemMessage` is
documented as "Warning message shown to the user" — designed for this.

## TODO: Proxy health false-positive in SessionStart

`c-thru-session-start.sh` reports `☁️  Proxy health: cloud backend unhealthy` at session start even when the proxy is not genuinely degraded (label shown: `recovering`). Investigate:

- What triggers the `recovering` label? Is it a transient HTTP timeout before the proxy warms up?
- Should the hook apply a grace period (e.g. retry once after 1–2 s) before reporting unhealthy?
- Should the hook suppress the warning entirely if the proxy process was just spawned (compare PID start time vs hook invocation time)?

→ See also: [[claude-code-hook-channels]], [[ollama-http-api-migration]], [[hook-safety-posture]], [[load-bearing-invariant]], [[fallback-event-system]]
