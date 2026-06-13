---
name: c-thru-status
description: "Show c-thru routes, proxy URL, per-model usage stats (calls, tokens, last call time), and backend health. Use 'fix' to pull missing models and reload."
allowed-tools: "Bash"
---
# c-thru Status

Your session context carries the live c-thru proxy control plane — a block that
starts with `(c-thru) proxy control plane: http://127.0.0.1:<port>` and lists the
queryable endpoints (`/c-thru/status`, `/c-thru/recent`, `/c-thru/dashboard`).
Use that base URL below. If it isn't in context, fall back to
`${ANTHROPIC_BASE_URL:-http://127.0.0.1:10017}`.

**1. Formatted tables** — run the list command. It shows: active profile, all
agents with model assignments and endpoints, proxy URL with tier/mode, Ollama
model count, backend health, and per-model usage stats (call count, total
tokens, timestamp of last call). If `$ARGUMENTS` is empty or `--verbose`, run:
```bash
~/.claude/tools/c-thru --list $ARGUMENTS
```

**2. Recent activity** — curl the recent-requests ring from the injected base URL
and summarize the last few requests (served model, tokens, latency, errors),
where `$BASE` is the proxy base URL above:
```bash
curl -s --max-time 2 "$BASE/c-thru/recent?n=10"
```

**3. Live dashboard** — `GET /c-thru/status` returns a `dashboard_url` field
(e.g. `http://127.0.0.1:10017/c-thru/dashboard`):
```bash
curl -s --max-time 2 "$BASE/c-thru/status"
```
Surface that `dashboard_url` so the user can watch per-request stats update live
in a browser.
