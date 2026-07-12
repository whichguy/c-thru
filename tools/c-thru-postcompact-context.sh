#!/usr/bin/env bash
# ARCH: PreCompact hook (filename retained for history — PostCompact never
# fires; see tools/c-thru:398) — reinject c-thru routing context before
# Claude Code compacts history. Silent on healthy path; exits 0 always.
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

# Resolve script location (follow symlinks) so the shared resolver lib is
# found via symlink, repo direct, or plugin bundle.
_src="${BASH_SOURCE[0]:-$0}"
while [ -L "$_src" ]; do
    _dir=$(cd -P "$(dirname "$_src")" && pwd)
    _src=$(readlink "$_src")
    case "$_src" in /*) ;; *) _src="$_dir/$_src" ;; esac
done
ROUTER_REPO_ROOT=$(cd -P "$(dirname "$_src")/.." && pwd)

# Canonical hook port ladder via the shared lib (CLAUDE_PROXY_PORT → PROXY_PORT
# → USE_OLLAMA_PORT → ANTHROPIC_BASE_URL → plugin default) — same resolver the
# other hooks use. Fail-open: lib unreadable → PORT empty → no-op (same as
# "c-thru not active").
PORT=""
BASE_URL=""
if [ -r "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh" ]; then
    # shellcheck source=c-thru-lib.sh
    . "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh"
    PORT="$(cthru_hook_listen_port)"
    # Round-5 B2: carries /s/<session-id> when set — see c-thru-lib.sh.
    BASE_URL="$(cthru_hook_base_url)"
fi
[ -n "$PORT" ] || exit 0  # c-thru not active (or lib unavailable — fail open)

response=$(curl --silent --max-time 3 --fail \
  -X POST "${BASE_URL:-http://127.0.0.1:$PORT}/hooks/context" \
  -H "Content-Type: application/json" \
  -d '{"event":"PreCompact"}' 2>/dev/null) || exit 0

[ -n "$response" ] || exit 0

# The proxy's /hooks/context handler hardcodes its own hookEventName
# (SessionStart) in the raw response — extract just additionalContext and
# re-wrap it under THIS hook's real event name, matching the pattern used by
# c-thru-session-start.sh and c-thru-classify.sh.
context=""
if command -v jq >/dev/null 2>&1; then
    context=$(printf '%s' "$response" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null)
elif command -v node >/dev/null 2>&1; then
    context=$(printf '%s' "$response" | node -e "
        let d=''; process.stdin.setEncoding('utf8');
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            try{const c=JSON.parse(d)?.hookSpecificOutput?.additionalContext;if(c)process.stdout.write(c)}catch(e){}
        });
    " 2>/dev/null)
fi

[ -n "$context" ] || exit 0

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
printf '{"hookSpecificOutput":{"hookEventName":"PreCompact","additionalContext":%s}}' "$context_json"
