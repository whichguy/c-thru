---
name: c-thru-status
description: "Show c-thru routes, proxy URL, per-model usage stats (calls, tokens, last call time), and backend health. Args: clear|reset stats; statusline on|off|status|style. Use 'fix' to pull missing models and reload."
allowed-tools: "Bash"
---
<!-- c-thru-managed: c-thru-status v2 -->
# c-thru Status

Works for **plugin-only** and **CLI** installs. Prefer plugin-root tools and
the live proxy HTTP API — do **not** require `~/.claude/tools/c-thru`.

Your session context may carry a c-thru control plane line:
`(c-thru) proxy control plane: http://127.0.0.1:<port>`. Use that base URL.
If absent, fall back to `${ANTHROPIC_BASE_URL}` (dynamic port from this launch).

Set:
```bash
BASE="${ANTHROPIC_BASE_URL:-http://127.0.0.1:10017}"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
HELPER=""
if [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/tools/c-thru-config-helpers.js" ]; then
  HELPER="$PLUGIN_ROOT/tools/c-thru-config-helpers.js"
elif [ -f "${HOME}/.claude/tools/c-thru-config-helpers.js" ]; then
  HELPER="${HOME}/.claude/tools/c-thru-config-helpers.js"
elif [ -f "$(git rev-parse --show-toplevel 2>/dev/null)/tools/c-thru-config-helpers.js" ]; then
  HELPER="$(git rev-parse --show-toplevel)/tools/c-thru-config-helpers.js"
fi
USAGE_JS=""
if [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/tools/c-thru-agent-usage.js" ]; then
  USAGE_JS="$PLUGIN_ROOT/tools/c-thru-agent-usage.js"
elif [ -f "${HOME}/.claude/tools/c-thru-agent-usage.js" ]; then
  USAGE_JS="${HOME}/.claude/tools/c-thru-agent-usage.js"
fi
ARGS="${ARGUMENTS:-}"
```

## Argument routing

Parse `$ARGUMENTS` (first word):

| Args | Action |
|---|---|
| empty / `--verbose` | Status tables + recent + dashboard (below) |
| `clear` / `reset` | Clear lifetime usage stats, then re-show tables |
| `statusline` / `statusline status` | Durable statusline enablement status |
| `statusline on` / `statusline enable` | Enable c-thru statusline (durable settings; **restart required**) |
| `statusline off` / `statusline disable` | Disable c-thru statusline if ours |
| `statusline style <minimal\|default\|stats>` | Persist bar style pref |
| `statusline on --force` | Overwrite a custom statusLine |

### Clear stats

Usage stats are a **machine-wide lifetime ledger** (`~/.claude/usage-stats.json`), not per Claude session. Reset:

```bash
if command -v c-thru >/dev/null 2>&1 || [ -x "${HOME}/.claude/tools/c-thru" ]; then
  "${HOME}/.claude/tools/c-thru" stats clear 2>/dev/null || c-thru stats clear
else
  curl -sf -X POST --max-time 2 "$BASE/c-thru/stats/clear" || echo "proxy unreachable — cannot clear"
fi
# then re-run the status path below so the user sees empty totals
```

### Statusline enable / style

```bash
if [ -n "$HELPER" ]; then
  case "$ARGS" in
    statusline|statusline\ status) node "$HELPER" statusline-status ;;
    statusline\ on*|statusline\ enable*) node "$HELPER" statusline-on ${ARGS#statusline on} ${ARGS#statusline enable} ;;
    statusline\ off*|statusline\ disable*) node "$HELPER" statusline-off ${ARGS#statusline off} ${ARGS#statusline disable} ;;
    statusline\ style\ *) node "$HELPER" statusline-style ${ARGS#statusline style } ;;
    *) node "$HELPER" statusline-status ;;
  esac
else
  echo "c-thru-config-helpers.js not found — run install.sh or use /c-thru-config statusline"
fi
```

Tell the user: **Claude binds statusLine at session start — restart Claude / re-run `c-thru` after enable/disable.**

---

## Default status path (no special args)

**1. Live status (proxy)** — primary for all install paths:
```bash
curl -s --max-time 2 "$BASE/c-thru/status" || echo "proxy unreachable at $BASE"
```
Summarize: mode/tier, `dashboard_url`, **Usage totals (since clear)** from `.usage` (calls, tokens — cumulative since last clear, not one chat).

**2. Recent activity**
```bash
curl -s --max-time 2 "$BASE/c-thru/recent?n=10" || true
```

**3. Live dashboard** — from the status JSON `dashboard_url` field.

**4. Formatted route list (optional, CLI install only)**
```bash
if command -v c-thru >/dev/null 2>&1 || [ -x "${HOME}/.claude/tools/c-thru" ]; then
  "${HOME}/.claude/tools/c-thru" --list 2>/dev/null || c-thru --list 2>/dev/null || true
fi
```

**5. Per-agent offload (transcripts)** when `USAGE_JS` is set:
```bash
[ -n "$USAGE_JS" ] && node "$USAGE_JS"
```

**Plugin command name:** marketplace installs may namespace as `/c-thru:c-thru-status`.
