# TUI troubleshooting under c-thru

When the Claude Code UI looks broken under `c-thru` (garbled characters, “keys not working”), use this page before assuming a keystroke interceptor or a proxy stream bug.

## Symptom shapes

| Look | Likely class |
|---|---|
| CSI / mouse junk: `[[`, `0;12;34M`, `^[[` after mouse or arrows | Terminal mouse-tracking sequences not consumed cleanly (often **Claude Code TUI**, sometimes amplified by launch/TTY posture) |
| Binary soup: `�`, high-bit Latin-1 after an API error / retry | Compressed **error body** rendered as text (proxy path; see error-body sanitize work) |
| Layout shred: overlapping text, wrong columns, status bar into chat | Statusline redraw / wide glyphs / slow statusline command |

## Not a keystroke hook

c-thru does **not** sit on stdin between the keyboard and Claude Code.

- Launch: `exec` or pure foreground `env … claude` (proxy path cannot `exec` so EXIT can reap the proxy child).
- Proxy: HTTP only on loopback.
- Hooks: SessionStart, UserPromptSubmit, PreCompact, PostToolUse, PreToolUse, Stop, statusLine — **not** per-keystroke.

There is no c-thru “pass keys through properly” middleware. Do not invent one.

## A/B matrix (same terminal app)

Reproduce once per row: type text → left-arrow → move mouse over the window.

| # | Command / setup | Isolates |
|---|---|---|
| 1 | `claude` (no c-thru) | Vendor TUI / terminal only |
| 2 | `c-thru --bypass-proxy` | Near-plain Claude: no proxy, **no** ephemeral inject (hooks/statusLine fleet) |
| 3 | `c-thru` (normal) | Full stack (proxy + inject + default statusline if none set) |
| 4 | `C_THRU_NO_STATUSLINE=1 c-thru` | Full stack but no default statusline inject |
| 5 | Custom `statusLine` in settings that runs `true` | Same as “no useful statusline work” |

**Read:**

- Dirty on 1 (and usually 2) → Claude Code / terminal (not c-thru inject/proxy).
- Clean on 1–2, dirty on 3 → c-thru path (launch, inject, proxy, or statusline).
- Clean on 4, dirty on 3 → default statusline hot path.
- Dirty only after API errors with binary look → error-body / stale proxy (`pkill -f claude-proxy` after code pull).

## Hook ownership (double-fire)

Fleet hooks must **not** live in static project or durable user settings. They ship via:

- Ephemeral `--settings` on each `c-thru` launch, and/or  
- Plugin `hooks.json` (marketplace plugin path).

`install.sh` strips durable fleet hooks by `~/.claude/tools/` prefix **or** known script basenames. Ephemeral merge also drops owned stems from user/caller settings so inject is sole owner.

Project `.claude/settings.json` in this repo is **permissions only** (no c-thru hooks). Re-adding SessionStart/classify/etc. there will double-fire next to inject.

**Plugin + CLI:** if the marketplace **c-thru plugin** is enabled *and* you launch via the CLI inject path, Claude Code can still run the same fleet hooks twice (plugin `hooks.json` is a separate layer; basename strip only applies inside ephemeral settings merge). Prefer one path.

Remaining intentional stderr (not “debug noise”):

| Hook | stderr |
|---|---|
| `c-thru-proxy-health` | Warn when proxy unreachable (UserPromptSubmit) |
| `c-thru-enter-plan-hook` | Planner hint (opt out: `/c-thru-config planning off`) |
| `c-thru-agent-router-hook` | Debug file only when configured — not stderr |

## Statusline policy

| Rule | Detail |
|---|---|
| Absent-only | Inject default only if user/caller has **no** `statusLine` |
| Opt out | `C_THRU_NO_STATUSLINE=1` |
| Overlay off | `C_THRU_STATUSLINE_OVERLAY=0` → `model \| cwd` only (skips recent fetch, fallback badge, **and** dash — all share one gate) |
| Dash off | `C_THRU_STATUSLINE_DASH=0` — hides dash only when the overlay path is still on |
| No OSC-8 | Hyperlinks in the statusline are unreliable in Claude Code; bar uses plain `dash :PORT/c-thru/dashboard` |

Default bar (when injected) is roughly:

```text
<model> | <cwd> | <served> <in>/<out> | [fallback] -> <m> | dash :PORT/c-thru/dashboard
```

Open the dashboard: `open "http://127.0.0.1:PORT/c-thru/dashboard"` (use the port from the bar or `/c-thru/status`).

## Where to look for stats

| Need | Channel |
|---|---|
| Ambient last served / tokens / fallback | Statusline |
| “Something just fell back” | Stop hook `systemMessage` |
| Routes, usage tables, cooldowns | `c-thru list` / `/c-thru-status`, `GET /c-thru/status` |
| Live HTML | `GET /c-thru/dashboard` |

## Vendor class (Claude Code)

Claude Code enables terminal mouse tracking. Upstream issues report raw SGR / mouse sequences leaking into the input or display (garbled text on mouse move). That class can appear **without** c-thru. If plain `claude` is also dirty, treat as vendor/terminal first.

## Related env (see also `docs/env-vars.md`)

- `C_THRU_NO_STATUSLINE`, `C_THRU_STATUSLINE_OVERLAY`, `C_THRU_STATUSLINE_DASH`
- `CLAUDE_PROXY_BYPASS` / `c-thru --bypass-proxy`
