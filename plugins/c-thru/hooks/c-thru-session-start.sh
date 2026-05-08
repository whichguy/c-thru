#!/usr/bin/env bash
# ARCH: SessionStart/PostCompact hook — injects tier/mode context and collects proxy/Ollama issues.
# Always injects active tier + mode so Claude knows its routing environment.
# A13: `-u` catches unset-var bugs. `-e` off — failed curls are flow control.
set -uo pipefail

# --- Resolve script location (follow symlinks) so ROUTER_REPO_ROOT is correct
# whether this script is invoked via ~/.claude/tools symlink, repo direct, or plugin bundle.
_src="${BASH_SOURCE[0]:-$0}"
while [ -L "$_src" ]; do
    _dir=$(cd -P "$(dirname "$_src")" && pwd)
    _src=$(readlink "$_src")
    case "$_src" in /*) ;; *) _src="$_dir/$_src" ;; esac
done
_script_dir=$(cd -P "$(dirname "$_src")" && pwd)
ROUTER_REPO_ROOT=$(cd -P "$_script_dir/.." && pwd)

# --- First-run: seed model-map config + register proxy URL in settings.json ---
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
_bundled_config="$ROUTER_REPO_ROOT/config/model-map.json"
_sys_map="$CLAUDE_DIR/model-map.system.json"
_ovr_map="$CLAUDE_DIR/model-map.overrides.json"
_eff_map="$CLAUDE_DIR/model-map.json"
_settings="$CLAUDE_DIR/settings.json"

if [ -f "$_bundled_config" ] && [ ! -f "$_sys_map" ]; then
    # Seed model-map files
    cp "$_bundled_config" "$_sys_map"
    [ -f "$_ovr_map" ] || printf '{}' > "$_ovr_map"
    [ -f "$_eff_map" ] || cp "$_bundled_config" "$_eff_map"

    # Spawn proxy on fixed port (plugin mode — port is static so ANTHROPIC_BASE_URL can be pre-written)
    _proxy_bin="$ROUTER_REPO_ROOT/tools/claude-proxy"
    _plugin_port="${C_THRU_PLUGIN_PORT:-10017}"
    if [ -f "$_proxy_bin" ] && command -v node >/dev/null 2>&1; then
        nohup node "$_proxy_bin" --port "$_plugin_port" \
            --config "$_eff_map" \
            >> "$CLAUDE_DIR/proxy.plugin.log" 2>&1 &
        disown $!
    fi

    # Register ANTHROPIC_BASE_URL in settings.json (takes effect on next Claude Code launch)
    if command -v node >/dev/null 2>&1 && [ -f "$_settings" ]; then
        node -e "
          const fs=require('fs'), f=process.argv[1], p=parseInt(process.argv[2]);
          let s={};
          try{s=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}
          s.env=s.env||{};
          if(!s.env.ANTHROPIC_BASE_URL){
            s.env.ANTHROPIC_BASE_URL='http://127.0.0.1:'+p;
            fs.writeFileSync(f,JSON.stringify(s,null,2)+'\n');
            process.stderr.write('c-thru plugin: routing registered on port '+p+'. Restart Claude Code to activate.\n');
          }
        " "$_settings" "$_plugin_port" >&2
    fi
fi

PORT="${CLAUDE_PROXY_PORT:-}"
if [ -z "$PORT" ] && [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
    PORT=$(printf '%s' "$ANTHROPIC_BASE_URL" | sed -nE 's#^https?://[^/:]+:([0-9]+).*$#\1#p')
fi
# If URL matched 127.0.0.1 but had no port, fall back to plugin default
if [ -z "$PORT" ] && printf '%s' "${ANTHROPIC_BASE_URL:-}" | grep -qE '^https?://127\.0\.0\.1'; then
    PORT="${C_THRU_PLUGIN_PORT:-10017}"
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
