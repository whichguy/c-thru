---
name: c-thru-status
description: "Show c-thru routes, proxy URL, per-model usage stats (calls, tokens, last call time), backend health, brand pin hard-fails, and provider env checks. Args: clear|reset; statusline on|off|status|style; doctor|keys (env/billing checklist); fix (reload + pull). Use 'fix' to pull missing models and reload."
allowed-tools: "Bash"
---
<!-- c-thru-managed: c-thru-status v3 -->
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
| `doctor` / `keys` | Provider env checklist (set vs usable) + brand hard-fail callouts from recent |
| `fix` | Pull missing local models if possible, `c-thru reload`, re-show status |
| `statusline` / `statusline status` | Durable statusline enablement status |
| `statusline on` / `statusline enable` | Enable c-thru statusline (durable settings; **restart required**) |
| `statusline off` / `statusline disable` | Disable c-thru statusline if ours |
| `statusline style <minimal\|default\|stats>` | Persist bar style pref |
| `statusline on --force` | Overwrite a custom statusLine |

### Clear stats

Usage stats are a **machine-wide lifetime ledger** (`~/.claude/usage-stats.json`), not per Claude session. The statusline `stats` style Σ chip reads the same ledger (global), while last-hop/fallback follow the session when `/s/<id>` is in the base URL. Reset:

```bash
# Prefer c-thru stats clear (retries 503 lock-busy; machine-wide ledger).
if command -v c-thru >/dev/null 2>&1 || [ -x "${HOME}/.claude/tools/c-thru" ]; then
  "${HOME}/.claude/tools/c-thru" stats clear 2>/dev/null || c-thru stats clear
else
  # Fallback: POST clear with brief 503 lock-busy retries (do not use curl -f —
  # that mislabels lock-busy as "proxy unreachable").
  _clear_ok=0
  for _i in 1 2 3 4 5 6 7 8; do
    _code="$(curl -sS --max-time 2 -o /tmp/c-thru-clear-body.$$ -w '%{http_code}' \
      -X POST "$BASE/c-thru/stats/clear" 2>/dev/null || echo 000)"
    if [ "$_code" = "200" ]; then _clear_ok=1; break; fi
    if [ "$_code" = "503" ]; then sleep 0.15 2>/dev/null || sleep 1; continue; fi
    break
  done
  if [ "$_clear_ok" != "1" ]; then
    if [ "$_code" = "503" ]; then
      echo "usage lock busy — try again in a moment (stats not cleared)"
    elif [ "$_code" = "000" ] || [ -z "$_code" ]; then
      echo "proxy unreachable — cannot clear"
    else
      echo "stats clear failed (HTTP ${_code})"
    fi
  else
    cat /tmp/c-thru-clear-body.$$ 2>/dev/null || true
  fi
  rm -f /tmp/c-thru-clear-body.$$ 2>/dev/null || true
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

### Doctor / keys (env set ≠ usable billing)

```bash
# Env presence only (never print secret values)
for v in XAI_API_KEY GOOGLE_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY; do
  eval "val=\${$v:-}"
  if [ -n "$val" ]; then echo "$v: set (len=${#val}; value not printed)"; else echo "$v: unset"; fi
done
# Note: shell checks the *current* Claude session env. A long-lived proxy started
# before export may still lack the key — run `c-thru restart` after rotating keys.
echo "---"
echo "Brand pins (agent model:*) hard-fail on primary 401/403/5xx — they do NOT cascade to routes.default."
echo "Grok leaf needs usable xAI billing (credits/spend), not only XAI_API_KEY set."
echo "Proof: GET /c-thru/recent fields agent, served_by, on_failure, fallback_suppressed, status."
# Recent brand hard-fails (this session / this proxy)
curl -s --max-time 2 "$BASE/c-thru/recent?n=20" 2>/dev/null | \
  node -e '
    let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
      try {
        const j=JSON.parse(d||"{}");
        const bad=(j.requests||[]).filter(r=>r.fallback_suppressed || r.on_failure==="hard_fail");
        if (!bad.length) { console.log("recent brand hard-fails: (none in last ring window)"); return; }
        console.log("recent brand hard-fails / hard_fail pins:");
        for (const r of bad.slice(0,8)) {
          console.log(`  ts=${r.ts} agent=${r.agent||"-"} model=${r.model} status=${r.status} served_by=${r.served_by||"-"} suppressed=${!!r.fallback_suppressed}`);
        }
      } catch { console.log("recent: unreadable"); }
    });
  ' || true
# Optional live xAI canary (only if user wants — costs tokens)
# With XAI_API_KEY set: C_THRU_LIVE_XAI=1 node test/proxy-xai-live.test.js (CLI install)
if command -v c-thru >/dev/null 2>&1 || [ -x "${HOME}/.claude/tools/c-thru" ]; then
  "${HOME}/.claude/tools/c-thru" explain --agent grok 2>/dev/null || c-thru explain --agent grok 2>/dev/null || true
fi
```

### Fix (reload + optional pull)

```bash
if command -v c-thru >/dev/null 2>&1 || [ -x "${HOME}/.claude/tools/c-thru" ]; then
  "${HOME}/.claude/tools/c-thru" reload 2>/dev/null || c-thru reload 2>/dev/null || true
  # After key rotation / billing fix, restart so the proxy process re-reads env:
  # c-thru restart
fi
# then re-run default status path below
```

---

## Default status path (no special args)

**1. Live status (proxy)** — primary for all install paths:
```bash
curl -s --max-time 2 "$BASE/c-thru/status" || echo "proxy unreachable at $BASE"
```
Summarize: mode/tier, `dashboard_url`, **Usage totals (since clear)** from `.usage` (calls, tokens — cumulative since last clear, not one chat).

**2. Recent activity** (include brand/agent attribution)
```bash
curl -s --max-time 2 "$BASE/c-thru/recent?n=10" || true
```
When summarizing recent rows, call out:
- `agent` — signed brand leaf (e.g. `grok`) when present
- `served_by` — concrete model that served (or attempted)
- `fallback_from` — cascade substitution occurred
- `fallback_suppressed` / `on_failure=hard_fail` — brand pin refused cascade (good; not a silent Grok→GLM lie)
- `status` / `ok` — HTTP outcome

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
