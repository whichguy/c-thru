#!/usr/bin/env bash
# ARCH: UserPromptSubmit hook — reads prompt from stdin JSON, calls /hooks/context
# on the hooks listener (port 9998) for classify_intent-based context injection.
# Silent on healthy/unclassified path. Does NOT block — exits 0 always.
# A13: `-u` catches unset-var bugs. `-e` is intentionally off because the
# hook uses command failures as flow control (exit 0 on anything unexpected).
set -uo pipefail

HOOKS_PORT="${CLAUDE_PROXY_HOOKS_PORT:-9998}"
prompt=""
context=""

# Only fire when c-thru is active (port in ANTHROPIC_BASE_URL)
PORT="${CLAUDE_PROXY_PORT:-}"
if [ -z "$PORT" ] && [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
    PORT=$(printf '%s' "$ANTHROPIC_BASE_URL" | sed -nE 's#^https?://[^/:]+:([0-9]+).*$#\1#p')
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
        "http://127.0.0.1:${HOOKS_PORT}/hooks/context" 2>/dev/null)

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

# Output hookSpecificOutput with additionalContext
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}' \
    "$(printf '%s' "$context" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/g' | tr -d '\n' | sed 's/\\n$//')"
