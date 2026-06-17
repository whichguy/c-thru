#!/usr/bin/env bash
# ARCH: UserPromptSubmit hook — reads prompt from stdin JSON, calls /hooks/context
# on the proxy (dynamic port from ANTHROPIC_BASE_URL) to fetch a static control-plane
# context block. NOTE: /hooks/context returns a fixed block and does NOT inspect the
# prompt — there is no classify_intent logic in the proxy. Silent on healthy path.
# Does NOT block — exits 0 always.
# A13: `-u` catches unset-var bugs. `-e` is intentionally off because the
# hook uses command failures as flow control (exit 0 on anything unexpected).
set -uo pipefail

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
if [ -r "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh" ]; then
    # shellcheck source=c-thru-lib.sh
    . "$ROUTER_REPO_ROOT/tools/c-thru-lib.sh"
    PORT="$(cthru_hook_listen_port)"
fi
[ -n "$PORT" ] || exit 0

# Read stdin and extract prompt
stdin_data=$(cat)

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

# Call /hooks/context with the prompt — 3s timeout, silent on failure
response=$(printf '{"prompt":%s}' "$(printf '%s' "$prompt" | python3 -c "import sys,json;print(json.dumps(sys.stdin.read()))" 2>/dev/null || printf '""')" | \
    curl -sf --max-time 3 -X POST \
        -H 'Content-Type: application/json' \
        --data-binary @- \
        "http://127.0.0.1:${PORT}/hooks/context" 2>/dev/null)

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
    context_json=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(d)));" <<< "$context")
fi
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}' "$context_json"
