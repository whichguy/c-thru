#!/usr/bin/env bash
# ARCH: FileChanged/PostToolUse hook — validates model-map.json on edit; exits 0 silently if file_path not model-map.json
# A13: `-u` catches unset-var bugs. `-e` off — flow-control via `|| exit 0`.
set -uo pipefail
file_path=""

# Parse file_path from stdin JSON safely
if command -v jq >/dev/null 2>&1; then
    file_path=$(jq -r '(.tool_input.file_path // .file_path) // empty' 2>/dev/null)
elif command -v node >/dev/null 2>&1; then
    file_path=$(node -e "
        let d=''; process.stdin.setEncoding('utf8');
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            try{const p=JSON.parse(d);process.stdout.write((p.tool_input&&p.tool_input.file_path)||p.file_path||'')}catch(e){}
        });
    " 2>/dev/null)
else
    exit 0  # cannot parse stdin — skip silently
fi

# Validate pattern: must end in model-map.json
case "$file_path" in
    *model-map.json) ;;
    *) exit 0 ;;  # not a model-map file — exit silently
esac

# Locate validator
script_dir="$(cd "$(dirname "$0")" && pwd)"
validator="${script_dir}/model-map-validate.js"

if ! command -v node >/dev/null 2>&1 || [ ! -f "$validator" ]; then
    exit 0  # validator unavailable — skip silently
fi

# Run validation
if node "$validator" "$file_path" >/dev/null 2>&1; then
    msg="model-map.json valid — restart proxy to apply: pkill -f claude-proxy"
else
    msg=$(node "$validator" "$file_path" 2>&1 | head -5)
fi

printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}' \
    "$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/g' | tr -d '\n' | sed 's/\\n$//')"
