#!/usr/bin/env bash
# ARCH: SessionStart/PostCompact hook — collects proxy/Ollama issues; injects additionalContext only on error (silent on happy path). See also c-thru-map-changed.sh, c-thru-proxy-health.sh
# A13: `-u` catches unset-var bugs. `-e` off — failed curls are flow control.
set -uo pipefail

PORT="${CLAUDE_PROXY_PORT:-}"
if [ -z "$PORT" ] && [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
    PORT=$(printf '%s' "$ANTHROPIC_BASE_URL" | sed -nE 's#^https?://[^/:]+:([0-9]+).*$#\1#p')
fi
[ -n "$PORT" ] || exit 0  # c-thru not active

issues=()

# Check 1: proxy reachability
if ! curl -sf --max-time 1 "http://127.0.0.1:$PORT/ping" >/dev/null 2>&1; then
    issues+=("⚠️ proxy down on :${PORT} — API calls will fail. Fix: pkill -f claude-proxy")
fi

# Check 2: Ollama reachability (only when active route targets an Ollama backend)
if [ -n "${OLLAMA_URL:-}" ]; then
    OLLAMA_BASE="${OLLAMA_URL%/}"
    if ! curl --max-time 3 --connect-timeout 2 -sf "${OLLAMA_BASE}/api/tags" >/dev/null 2>&1; then
        issues+=("⚠️ Ollama unreachable on ${OLLAMA_BASE} — route 'local' will fail. Alternative: --route default")
    fi
fi

# Silent on happy path
[ ${#issues[@]} -eq 0 ] && exit 0

# Inject additionalContext with collected warnings
context=$(printf '%s\n' "${issues[@]}" | paste -sd '\n' -)
printf '{"hookSpecificOutput":{"additionalContext":"%s"}}' \
    "$(printf '%s' "$context" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/g' | tr -d '\n' | sed 's/\\n$//')"
