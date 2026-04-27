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

# Check 3: profile pollution — silent on happy path, single advisory line on drift.
# Resolve script dir (follow symlink) so we can find tools/model-map-config.js
# whether invoked via ~/.claude/tools symlink or directly from the repo.
_src="${BASH_SOURCE[0]:-$0}"
while [ -L "$_src" ]; do
    _dir=$(cd -P "$(dirname "$_src")" && pwd)
    _src=$(readlink "$_src")
    case "$_src" in /*) ;; *) _src="$_dir/$_src" ;; esac
done
_script_dir=$(cd -P "$(dirname "$_src")" && pwd)
ROUTER_REPO_ROOT=$(cd -P "$_script_dir/.." && pwd)
_pollution_script="$ROUTER_REPO_ROOT/tools/model-map-config.js"
if [ -f "$_pollution_script" ] && command -v node >/dev/null 2>&1; then
    _pollution_out=$(node "$_pollution_script" --detect-pollution 2>/dev/null || true)
    if [ -n "$_pollution_out" ] && \
       ! printf '%s' "$_pollution_out" | grep -q -E "no leaked|profile is clean"; then
        context_parts+=("c-thru: profile pollution detected (run \`c-thru --detect-pollution\` for details). May be from older c-thru versions.")
    fi
fi

[ ${#context_parts[@]} -eq 0 ] && exit 0

context=$(printf '%s\n' "${context_parts[@]}" | paste -sd '\n' -)
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}' \
    "$(printf '%s' "$context" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/g' | tr -d '\n' | sed 's/\\n$//')"
