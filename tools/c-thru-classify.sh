#!/usr/bin/env bash
# ARCH: UserPromptSubmit hook — reads prompt from stdin JSON, calls /hooks/context
# on the proxy (dynamic port from ANTHROPIC_BASE_URL) to fetch the SHORT control-plane
# context block. Proxy event-split: non-empty body.prompt → short (this path);
# SessionStart/PreCompact/empty → long "when to query". No classify_intent / no LLM.
# Silent on healthy path. Does NOT block — exits 0 always.
# A13: `-u` catches unset-var bugs. `-e` is intentionally off because the
# hook uses command failures as flow control (exit 0 on anything unexpected).
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

prompt=""
context=""

# Only fire when c-thru is active. Resolve script location (follow symlinks) so
# the shared resolver lib is found via symlink, repo direct, or plugin bundle.
_src="${BASH_SOURCE[0]:-$0}"
while [ -L "$_src" ]; do
    _dir=$(cd -P "$(dirname "$_src")" && pwd)
    _src=$(readlink "$_src")
    case "$_src" in /*) ;; *) _src="$_dir/$_src" ;; esac
done
ROUTER_REPO_ROOT=$(cd -P "$(dirname "$_src")/.." && pwd)

# Canonical hook port ladder (NO lsof tail — this is the per-prompt hot path).
# Fail-open: lib unreadable → PORT empty → no-op (same as "c-thru not active").
PORT=""
BASE_URL=""
if [ -r "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh" ]; then
    # shellcheck source=c-thru-lib.sh
    . "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh"
    PORT="$(cthru_hook_listen_port)"
    # Round-5 B2: carries /s/<session-id> when set — see c-thru-lib.sh.
    BASE_URL="$(cthru_hook_base_url)"
fi
[ -n "$PORT" ] || exit 0

# Extract prompt field via jq or node
if command -v jq >/dev/null 2>&1; then
    prompt=$(printf '%s' "$stdin_data" | jq -r '.prompt // empty' 2>/dev/null)
elif command -v node >/dev/null 2>&1; then
    prompt=$(printf '%s' "$stdin_data" | node -e "
        let d=''; process.stdin.setEncoding('utf8');
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            try{const p=JSON.parse(d).prompt;if(p)process.stdout.write(p)}catch(e){}
        });
    " 2>/dev/null)
fi

[ -n "$prompt" ] || exit 0

# Call /hooks/context with the prompt — 3s timeout, silent on failure.
# JSON-escape via jq -Rs (or node JSON.stringify fallback) — same encoder used
# below for the response side, no python3 dependency.
if command -v jq >/dev/null 2>&1; then
    prompt_json=$(printf '%s' "$prompt" | jq -Rs .)
elif command -v node >/dev/null 2>&1; then
    # printf '%s' (not a <<< here-string, which implicitly appends a trailing
    # newline that would get baked into the JSON-escaped string).
    prompt_json=$(printf '%s' "$prompt" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(d)));")
else
    prompt_json='""'
fi

response=$(printf '{"prompt":%s}' "$prompt_json" | \
    curl -sf --max-time 3 -X POST \
        -H 'Content-Type: application/json' \
        --data-binary @- \
        "${BASE_URL:-http://127.0.0.1:$PORT}/hooks/context" 2>/dev/null)

[ -n "$response" ] || exit 0

# Extract additionalContext and output if present
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

# Output hookSpecificOutput with additionalContext.
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
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}' "$context_json"
