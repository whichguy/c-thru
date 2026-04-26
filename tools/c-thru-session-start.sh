#!/usr/bin/env bash
# ARCH: SessionStart/PostCompact hook — injects tier/mode context and collects proxy/Ollama issues.
# Always injects active tier + mode so Claude knows its routing environment.
# A13: `-u` catches unset-var bugs. `-e` off — failed curls are flow control.
set -uo pipefail

PORT="${CLAUDE_PROXY_PORT:-}"
if [ -z "$PORT" ] && [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
    PORT=$(printf '%s' "$ANTHROPIC_BASE_URL" | sed -nE 's#^https?://[^/:]+:([0-9]+).*$#\1#p')
fi
[ -n "$PORT" ] || exit 0  # c-thru not active

issues=()
active_tier=""
active_mode=""

# Check 1: proxy reachability — also capture tier + mode from /ping
ping_json=""
if ping_json=$(curl -sf --max-time 2 "http://127.0.0.1:$PORT/ping" 2>/dev/null); then
    if command -v jq >/dev/null 2>&1; then
        active_tier=$(printf '%s' "$ping_json" | jq -r '.active_tier // ""')
        active_mode=$(printf '%s' "$ping_json" | jq -r '.active_mode // ""')
    elif command -v node >/dev/null 2>&1; then
        active_tier=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.active_tier||'')}catch{}" <<<"$ping_json" 2>/dev/null || true)
        active_mode=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.active_mode||'')}catch{}" <<<"$ping_json" 2>/dev/null || true)
    fi
else
    issues+=("⚠️ proxy down on :${PORT} — API calls will fail. Fix: pkill -f claude-proxy")
fi

# Check 2: Ollama reachability (only when active route targets an Ollama backend)
if [ -n "${OLLAMA_URL:-}" ]; then
    OLLAMA_BASE="${OLLAMA_URL%/}"
    if curl --max-time 3 --connect-timeout 2 -sf "${OLLAMA_BASE}/api/tags" >/dev/null 2>&1; then
        # Ollama reachable — spawn GC sweep in background (non-blocking, survives hook exit)
        nohup "${CLAUDE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/tools/c-thru-ollama-gc" sweep </dev/null >/dev/null 2>&1 &
        disown $!
    else
        issues+=("⚠️ Ollama unreachable on ${OLLAMA_BASE} — route 'local' will fail. Alternative: --route default")
    fi
fi

# Build context: always include tier/mode if known; append any issues
context_parts=()
if [ -n "$active_tier" ] || [ -n "$active_mode" ]; then
    context_parts+=("(c-thru) routing: tier=${active_tier:-unknown} mode=${active_mode:-unknown}")
fi

if [ ${#issues[@]} -gt 0 ]; then
    context_parts+=("${issues[@]}")
fi

[ ${#context_parts[@]} -eq 0 ] && exit 0

context=$(printf '%s\n' "${context_parts[@]}" | paste -sd '\n' -)
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}' \
    "$(printf '%s' "$context" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/g' | tr -d '\n' | sed 's/\\n$//')"
