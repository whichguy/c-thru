---
name: c-thru-status
description: "Show c-thru routes, proxy URL, per-model usage stats (calls, tokens, last call time), and backend health. Use 'fix' to pull missing models and reload."
allowed-tools: "Bash"
---
# c-thru Status

Works for **plugin-only** and **CLI** installs. Prefer plugin-root tools and
the live proxy HTTP API — do **not** require `~/.claude/tools/c-thru`.

Your session context may carry a c-thru control plane line:
`(c-thru) proxy control plane: http://127.0.0.1:<port>`. Use that base URL.
If absent, fall back to `${ANTHROPIC_BASE_URL:-http://127.0.0.1:10017}`.

Set:
```bash
BASE="${ANTHROPIC_BASE_URL:-http://127.0.0.1:10017}"
# Plugin installs: CLAUDE_PLUGIN_ROOT is set to the cached plugin directory.
# CLI installs: tools live under ~/.claude/tools (optional for this command).
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
USAGE_JS=""
if [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/tools/c-thru-agent-usage.js" ]; then
  USAGE_JS="$PLUGIN_ROOT/tools/c-thru-agent-usage.js"
elif [ -f "${HOME}/.claude/tools/c-thru-agent-usage.js" ]; then
  USAGE_JS="${HOME}/.claude/tools/c-thru-agent-usage.js"
fi
```

**1. Live status (proxy)** — primary for all install paths:
```bash
curl -s --max-time 2 "$BASE/c-thru/status" || echo "proxy unreachable at $BASE"
```
Summarize: listening state, mode/tier if present, `dashboard_url`, errors.

**2. Recent activity**
```bash
curl -s --max-time 2 "$BASE/c-thru/recent?n=10" || true
```
Summarize the last few requests (served model, tokens, latency, errors).

**3. Live dashboard** — from the status JSON `dashboard_url` field (e.g.
`http://127.0.0.1:10017/c-thru/dashboard`). Surface that URL for the user.

**4. Formatted route list (optional, CLI install only)** — only if the binary exists:
```bash
if command -v c-thru >/dev/null 2>&1 || [ -x "${HOME}/.claude/tools/c-thru" ]; then
  "${HOME}/.claude/tools/c-thru" --list $ARGUMENTS 2>/dev/null \
    || c-thru --list $ARGUMENTS 2>/dev/null \
    || true
else
  echo "(c-thru CLI not installed — route table available after CLI install; proxy /c-thru/status is authoritative for plugin-only)"
fi
```

**5. Per-agent offload (from transcripts)** — capability stats from the proxy
are not agent-precise. Prefer the bundled script when present:
```bash
if [ -n "$USAGE_JS" ]; then
  node "$USAGE_JS"
  # optional: node "$USAGE_JS" --project <slug> --since 2026-06-01
else
  echo "(c-thru-agent-usage.js not found in plugin or CLI tools)"
fi
```

**Plugin command name:** marketplace installs namespace this as
`/c-thru:c-thru-status`. CLI/`~/.claude/commands` installs may expose
`/c-thru-status`.
