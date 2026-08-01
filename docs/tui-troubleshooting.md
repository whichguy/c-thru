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
| Opt out inject | `C_THRU_NO_STATUSLINE=1` |
| Skill enable | `/c-thru-config statusline on` writes durable `settings.json` (restart required); `off` / `style stats\|default\|minimal` |
| Overlay off | `C_THRU_STATUSLINE_OVERLAY=0` → `model \| cwd` only (skips recent fetch, fallback badge, **and** dash — all share one gate) |
| Style | `C_THRU_STATUSLINE_STYLE=minimal\|default\|stats` or durable `c-thru-statusline.json` (`stats` → `GET /c-thru/statusline`) |
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

## Agent view: connection refused after exit / re-enter

**Symptom:** `cthru agents --model grok` works, you **Esc** out, re-open agent view, **reuse an existing session** → connection refused to an old `127.0.0.1:<port>`.

**Cause:** Agent-view workers **freeze gateway env** at spawn. A new `cthru agents` launch starts a **new** proxy on a **new** port; old workers still dial the dead URL. Hooks cannot rewrite the parent process env. Claude also **strips `ANTHROPIC_BASE_URL` from job `providerEnv`** on disk (only `CLAUDE_CONFIG_DIR` is allowlisted), so a plain `claude respawn` does not pick up the shell’s new gateway by itself.

**Gateway survival stack** (best → last resort):

| Layer | When | Behavior |
|---|---|---|
| **EXIT keep-alive** | Esc agent-view while workers still need the gateway | Brand `agents` defaults `C_THRU_KEEP_PROXY=1`; also keeps if live `ps` shows another claude process with `ANTHROPIC_BASE_URL` on that port. Does **not** keep based on `jobs/*.json` alone (that orphaned main-chat proxies). Opt out: `C_THRU_KEEP_PROXY=0` |
| **SessionStart ensure** | New/resumed process | Dead local port → `c-thru-ensure-proxy-on-port` (same port) |
| **UPS ensure** (`c-thru-proxy-health`) | Each prompt | `/ping` fail → same-port ensure (preempt before next API call) |
| **StopFailure ensure** | Turn dies on API error (`server_error` / `unknown`) | Same-port ensure (after refuse; fire-and-forget — no auto-retry) |
| **Session revive** (brand `cthru agents`) | Re-open agents with **new** gateway | Stage `~/.claude/c-thru-agent-gateway/`; **respawn only dead** workers; **never respawn live bg** (detect via `CLAUDE_JOB_DIR` / rv sock / process id — **not** `ANTHROPIC_BASE_URL`); **patch-only** live + terminal brand jobs’ `providerEnv` |

Hooks **cannot** rewrite the parent process’s `ANTHROPIC_BASE_URL`. Same-port heal keeps the frozen URL valid; only revive/respawn (or a fixed `CLAUDE_PROXY_PORT`) delivers a new port.

### Reconnect crash: “currently running as a background agent”

**Symptom:** Session already answered; re-open the row → `Session is starting…` then:

`Session <id> is currently running as a background agent (bg)` → worker crash → auto-respawn loop.

**Cause:** A **second** process was started for a session that is **already live as bg**. Brand workers often **omit** `ANTHROPIC_BASE_URL` from the process env; older revive logic treated them as dead and called `claude respawn`. Claude Code may also race attach vs spawn (vendor residual).

**Fix (current):** revive builds a live-set from process table (`CLAUDE_JOB_DIR`, rv sock, job id) and **never respawns** live ids; soft-fails if respawn still returns the bg message (no retry). Prefer **attach** (Enter / `→`) on the existing row.

**If still stuck:**

```sh
C_THRU_NO_SESSION_REVIVE=1 cthru agents --model grok
claude attach <short-id>          # e.g. 152c2d06
# or clean restart of that row:
claude stop <short-id>
```

### SessionStart:resume → `c-thru-session.*/tools/c-thru-session-start: No such file`

**Cause:** Brand `cthru agents` once injected `--settings` with hook commands under the **ephemeral** session shadow (`/tmp/c-thru-session.XXXX/…`). Claude persists that JSON in job `respawnFlags`. When the parent UI exits, the shadow is deleted; resume still runs the dead path.

**Fix:** brand inject now uses **durable** `~/.claude/tools/…` (or repo `tools/*.sh`) only; revive rewrites stale `c-thru-session.*` hook paths in `respawnFlags` on open.

**Heal now:** re-run `cthru agents --model <brand>` once (revive patches job state), or manually edit `~/.claude/jobs/<id>/state.json` `respawnFlags` `--settings` to point SessionStart at `~/.claude/tools/c-thru-session-start`.

### “Not logged in · Please run /login” on brand attach (0s, no API call)

**Cause:** Durable gateway `~/.claude/c-thru-agent-gateway/settings.json` had `env.ANTHROPIC_AUTH_TOKEN=ollama` (or another placeholder). Jobs use `CLAUDE_CONFIG_DIR` → that gateway. Claude Code with a custom `ANTHROPIC_BASE_URL` **does not** use keychain for the login gate; a placeholder token fails client-side before any proxy call.

**Fix:** gateway staging never writes placeholders; it stages a real OAuth token from the process env or Claude Code credentials store when available, else omits `ANTHROPIC_AUTH_TOKEN` entirely (BASE_URL only).

**After restart / connect to existing:** live workers freeze env at spawn. Gateway settings install a durable **`apiKeyHelper`** (`c-thru-gateway-auth-helper`) so attach/resume fetches OAuth at **request time**. Shared gateway `ANTHROPIC_BASE_URL` is **unscoped** (`http://127.0.0.1:<port>` only — never `/s/<session-id>`, which would poison every job). Re-opening `cthru agents --model <brand>` re-stages gateway and **stop+respawns** live brand jobs when auth/base changed. SessionStart on gateway sessions re-writes `apiKeyHelper` + unscoped BASE_URL (fail-open).
**Connect to existing session checklist:**

1. Prefer `cthru agents --model <brand>` then attach (Enter/`→`), not bare `claude agents` after a reboot (no proxy/oauth restage).
2. SessionStart should not error on missing `c-thru-session.*` hooks (durable paths).
3. If still “Not logged in”: `claude stop <id>` then re-attach after one `cthru agents` open.

**Startup noise you may see (normal vs thrash):**

```text
✓ proxy  http://127.0.0.1:PORT  …
c-thru: agents via proxy model=grok base=http://127.0.0.1:PORT/s/… (no fleet inject)
c-thru: recycled session <id> onto gateway http://127.0.0.1:PORT (auth/base refresh)
```

- First line after a dead proxy / cold start: **expected**.
- `recycled session …` on **every** open: previously meant a **new dynamic port** each time (KEEP_PROXY left the old one, open spawned another). Brand open now **reuses** the gateway’s live proxy when `/ping` works, so the second open should **not** recycle unless auth/base actually changed.
- Many `model-map-validate: note:` lines: informational (missing optional cloud keys); not fatal for grok/xAI.

**Heal now:**

```sh
# Best: re-enter through c-thru (restages + recycles live brand workers)
cthru agents --model grok

# Manual restage only:
ANTHROPIC_BASE_URL=http://127.0.0.1:<proxy-port> bash tools/c-thru-revive-agent-sessions.sh
```

**Ops checklist:**

1. Re-enter brand work with **`cthru agents --model <brand>`** (revive + proxy).
2. Stderr: `revived session …` / `resurrected proxy on :PORT` / `revive skip … (live bg worker)`.
3. Opt out same-port ensure: `C_THRU_NO_RESURRECT=1`. Opt out revive: `C_THRU_NO_SESSION_REVIVE=1`. Also respawn terminal jobs: `C_THRU_REVIVE_ALL=1`. Cap respawns: `C_THRU_REVIVE_MAX` (default 20).
4. Gateway staging never writes real OAuth/API tokens (or profile `*KEY`/`*TOKEN` env) to disk — placeholders like `ollama` only. Same-port ensure refuses non-loopback `ANTHROPIC_BASE_URL`.
5. Long-term stability: fixed `CLAUDE_PROXY_PORT` so the URL stops changing.

**Not fixed by “telling the model the new port”** — the client dials env/settings; the model never chooses the TCP endpoint.

## Vendor class (Claude Code)

Claude Code enables terminal mouse tracking. Upstream issues report raw SGR / mouse sequences leaking into the input or display (garbled text on mouse move). That class can appear **without** c-thru. If plain `claude` is also dirty, treat as vendor/terminal first.

## Related env (see also `docs/env-vars.md`)

- Statusline: `C_THRU_NO_STATUSLINE`, `C_THRU_STATUSLINE_OVERLAY` (also gates dash), `C_THRU_STATUSLINE_DASH`
- Launch: `CLAUDE_PROXY_BYPASS` / `c-thru --bypass-proxy`
- Agent-view gateway: `C_THRU_KEEP_PROXY`, `C_THRU_NO_RESURRECT`, `C_THRU_NO_SESSION_REVIVE`, `C_THRU_REVIVE_MAX`, fixed `CLAUDE_PROXY_PORT`
