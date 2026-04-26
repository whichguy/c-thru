#!/usr/bin/env bash
# c-thru proxy health check — UserPromptSubmit hook
# Derive port from explicit env var or from ANTHROPIC_BASE_URL set by c-thru.
# A13: `-u` catches unset-var bugs; `-e` off so curl failure falls through to exit 2.
set -uo pipefail
PORT="${CLAUDE_PROXY_PORT:-}"
if [ -z "$PORT" ] && [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
    PORT=$(printf '%s' "$ANTHROPIC_BASE_URL" | sed -nE 's#^https?://[^/:]+:([0-9]+).*$#\1#p')
fi
[ -n "$PORT" ] || exit 0
curl -sf --max-time 2 "http://127.0.0.1:$PORT/ping" >/dev/null 2>&1 && exit 0
echo "c-thru: proxy unreachable on :${PORT} — run: pkill -f claude-proxy" >&2
exit 0
