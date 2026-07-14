#!/usr/bin/env bash
# ARCH: SessionStart hook — injects tier/mode context and collects proxy/Ollama issues.
# Always injects active tier + mode so Claude knows its routing environment.
# A13: `-u` catches unset-var bugs. `-e` off — failed curls are flow control.
set -uo pipefail

stdin_data=$(cat)
_hook_session_id=""
if command -v jq >/dev/null 2>&1; then
    _hook_session_id=$(printf '%s' "$stdin_data" | jq -r '.session_id // empty' 2>/dev/null)
elif command -v node >/dev/null 2>&1; then
    _hook_session_id=$(printf '%s' "$stdin_data" | node -e "
        let d=''; process.stdin.setEncoding('utf8');
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            try{const s=JSON.parse(d).session_id;if(s)process.stdout.write(s)}catch(e){}
        });
    " 2>/dev/null)
fi
_hook_session_id=$(printf '%s' "$_hook_session_id" | tr -cd '[:alnum:]_-' | cut -c1-128)
[ -n "$_hook_session_id" ] && export C_THRU_SESSION_ID="${C_THRU_SESSION_ID:-$_hook_session_id}"

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

# Canonical hook port ladder via the shared lib (CLAUDE_PROXY_PORT → PROXY_PORT
# → USE_OLLAMA_PORT → ANTHROPIC_BASE_URL → plugin default). Fail-open: lib
# unreadable → PORT empty → the guard below no-ops (same as "c-thru not active").
PORT=""
BASE_URL=""
if [ -r "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh" ]; then
    # shellcheck source=c-thru-lib.sh
    . "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh"
    PORT="$(cthru_hook_listen_port)"
    # Round-5 B2: carries /s/<session-id> when this session set one, so
    # /hooks/context reflects THIS session's own mode, not silently the
    # proxy's global default (see cthru_hook_base_url in c-thru-lib.sh).
    BASE_URL="$(cthru_hook_base_url)"
fi
[ -n "$PORT" ] || exit 0  # c-thru not active (or lib unavailable — fail open)

issues=()

# Check 1: proxy reachability AND the canonical control-plane block in ONE probe.
# A single POST /hooks/context both proves the proxy is up (curl success) and
# yields the block (Profile/Mode + endpoint list — the proxy owns it, Part 1, so
# the URL/endpoints have exactly one source). `-sf` makes a connection refusal OR
# an HTTP error both count as "proxy down", matching the old /ping -sf health
# gate — and lets us drop the separate /ping curl that this duplicated (a
# successful /hooks/context already proves the proxy is up; a failing one fails
# identically to /ping). Bounded with --max-time 2 so a wedged proxy can't blow
# the 5s CLI hook budget and drop ALL SessionStart context. jq with a node
# fallback (matches the proxy's JSON). Empty additionalContext on a 200 stays
# "no block, no advisory" — same as before.
proxy_ctx=""
hook_json=""
# event=SessionStart → long "when to query" blurb (rare channel). Empty-body
# POSTs also get long from the proxy; the event makes intent explicit.
_fetch_hooks_context() {
    curl -sf --max-time 2 -X POST \
        -H 'Content-Type: application/json' \
        -d '{"event":"SessionStart"}' \
        "${BASE_URL:-http://127.0.0.1:$PORT}/hooks/context" 2>/dev/null
}
if hook_json=$(_fetch_hooks_context); then
    if command -v jq >/dev/null 2>&1; then
        proxy_ctx=$(printf '%s' "$hook_json" | jq -r '.hookSpecificOutput.additionalContext // ""')
    elif command -v node >/dev/null 2>&1; then
        proxy_ctx=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write((d.hookSpecificOutput&&d.hookSpecificOutput.additionalContext)||'')}catch{}" <<<"$hook_json" 2>/dev/null || true)
    fi
else
    # Agent-view reenter / rehydrate: session still has ANTHROPIC_BASE_URL pointing
    # at a dead port (prior c-thru EXIT killed the proxy). Resurrect on the SAME
    # port — do not rewrite env (hooks cannot change the parent process).
    _resurrected=0
    if [ -r "$ROUTER_REPO_ROOT/tools/c-thru-ensure-proxy-on-port.sh" ]; then
        # shellcheck source=c-thru-ensure-proxy-on-port.sh
        . "$ROUTER_REPO_ROOT/tools/c-thru-ensure-proxy-on-port.sh"
        # Opt-out for tests / emergency: C_THRU_NO_RESURRECT=1
        if [ "${C_THRU_NO_RESURRECT:-0}" != "1" ] && cthru_ensure_proxy_on_port "$PORT" 2>/dev/null; then
            _resurrected=1
        fi
    fi
    if [ "$_resurrected" = "1" ] && hook_json=$(_fetch_hooks_context); then
        if command -v jq >/dev/null 2>&1; then
            proxy_ctx=$(printf '%s' "$hook_json" | jq -r '.hookSpecificOutput.additionalContext // ""')
        elif command -v node >/dev/null 2>&1; then
            proxy_ctx=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write((d.hookSpecificOutput&&d.hookSpecificOutput.additionalContext)||'')}catch{}" <<<"$hook_json" 2>/dev/null || true)
        fi
        context_parts_pre_resurrect="(c-thru) proxy resurrected on :${PORT} after connection refused — same ANTHROPIC_BASE_URL, no env rewrite"
        # Defer into context_parts after array is initialized below via issues path;
        # stash on proxy_ctx prefix instead so we don't reference unset arrays under set -u.
        if [ -n "$proxy_ctx" ]; then
            proxy_ctx="${context_parts_pre_resurrect}"$'\n'"${proxy_ctx}"
        else
            proxy_ctx="${context_parts_pre_resurrect}"
        fi
    else
        issues+=("⚠️ proxy down on :${PORT} — API calls will fail (connection refused). Fix: keep cthru running, or re-open \`cthru agents\` so SessionStart can resurrect the proxy on this port.")
    fi
fi

# Check 2: Ollama reachability — prefer OLLAMA_URL (set by c-thru binary) else OLLAMA_BASE_URL
_ollama_check_url="${OLLAMA_URL:-${OLLAMA_BASE_URL:-}}"
if [ -n "$_ollama_check_url" ]; then
    OLLAMA_BASE="${_ollama_check_url%/}"
    if curl --max-time 3 --connect-timeout 2 -sf "${OLLAMA_BASE}/api/tags" >/dev/null 2>&1; then
        # Ollama reachable — spawn GC sweep in background (non-blocking, survives hook exit)
        nohup "${CLAUDE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/tools/c-thru-ollama-gc" sweep </dev/null >/dev/null 2>&1 &
        disown $!
    else
        issues+=("⚠️ Ollama unreachable on ${OLLAMA_BASE} — route 'local' will fail. Alternative: --route default")
    fi
fi

# Build context: proxy control-plane block first (carries Profile/Mode + the
# endpoint list, Part 1), then local advisories.
context_parts=()
if [ -n "$proxy_ctx" ]; then
    context_parts+=("$proxy_ctx")
fi

if [ ${#issues[@]} -gt 0 ]; then
    context_parts+=("${issues[@]}")
fi

# Dynamic: inject currently installed Ollama tags
if command -v ollama >/dev/null 2>&1; then
    _ollama_tags=$(ollama list 2>/dev/null | awk 'NR>1 && $1!="" {printf "%s ", $1}' | sed 's/ $//')
    [ -n "$_ollama_tags" ] && context_parts+=("(c-thru) installed ollama tags: $_ollama_tags")
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

# Check 4: repo divergence & stale WIP — last-fetched state only, NO network
# (measured ~40ms vs the 10s hook timeout). Gated on the repo root actually
# being a git checkout (plugin installs may not be); the divergence/behind
# advisories additionally require an upstream, the stale-WIP one does not.
if git -C "$ROUTER_REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # Tracked uncommitted changes only: drop untracked (??) lines; keep the
    # post-rename path for `R old -> new` forms.
    _tracked_dirty=$(git -C "$ROUTER_REPO_ROOT" status --porcelain 2>/dev/null | grep -v '^??' | grep -v '^$' || true)

    if git -C "$ROUTER_REPO_ROOT" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
        _lr=$(git -C "$ROUTER_REPO_ROOT" rev-list --left-right --count '@{u}...HEAD' 2>/dev/null || true)
        _behind=""; _ahead=""
        read -r _behind _ahead <<<"$_lr" || true
        if [ -n "$_behind" ] && [ -n "$_ahead" ]; then
            if [ "$_ahead" -gt 0 ] && [ "$_behind" -gt 0 ]; then
                context_parts+=("(c-thru) repo diverged from origin (ahead $_ahead, behind $_behind) — self-update is paused; merge manually")
            elif [ "$_behind" -gt 0 ] && [ -n "$_tracked_dirty" ]; then
                context_parts+=("(c-thru) repo is $_behind commit(s) behind origin but has uncommitted changes — self-update paused")
            fi
        fi
    fi

    # Stale WIP: tracked uncommitted changes with no file touched in 24h.
    if [ -n "$_tracked_dirty" ]; then
        _recent=""
        while IFS= read -r _line; do
            [ -n "$_line" ] || continue
            _f=$(printf '%s' "$_line" | sed 's/^...//; s/^.* -> //')
            if [ -n "$(find "$ROUTER_REPO_ROOT/$_f" -mtime -1 -print -quit 2>/dev/null)" ]; then
                _recent=1
                break
            fi
        done <<<"$_tracked_dirty"
        if [ -z "$_recent" ]; then
            context_parts+=("(c-thru) uncommitted changes untouched for >24h — possible abandoned WIP from a previous session")
        fi
    fi
fi

[ ${#context_parts[@]} -eq 0 ] && exit 0

context=$(printf '%s\n' "${context_parts[@]}" | paste -sd '\n' -)
# JSON-escape via jq -Rs (or node JSON.stringify fallback) so raw control chars
# (tabs, etc.) are \u-escaped — a hand-rolled sed chain produces invalid JSON.
if command -v jq >/dev/null 2>&1; then
    context_json=$(printf '%s' "$context" | jq -Rs .)
else
    # printf '%s' (not a <<< here-string, which implicitly appends a trailing
    # newline that would get baked into the JSON-escaped string, diverging
    # from the jq path above).
    context_json=$(printf '%s' "$context" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(d)));")
fi
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}' "$context_json"
