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

# Locate validator — BASH_SOURCE resolver works from symlink, repo direct, or plugin bundle
_src="${BASH_SOURCE[0]:-$0}"
while [ -L "$_src" ]; do
    _dir=$(cd -P "$(dirname "$_src")" && pwd)
    _src=$(readlink "$_src")
    case "$_src" in /*) ;; *) _src="$_dir/$_src" ;; esac
done
_hook_dir=$(cd -P "$(dirname "$_src")" && pwd)
repo_root="$(cd "$_hook_dir/.." && pwd)"
# Plugin-manifest gate (C_THRU_PLUGIN_HOOK=1)
if [ -r "$repo_root/tools/c-thru-plugin-hook-gate.sh" ]; then
    # shellcheck source=c-thru-plugin-hook-gate.sh
    ROUTER_REPO_ROOT="$repo_root"
    . "$repo_root/tools/c-thru-plugin-hook-gate.sh"
    if cthru_plugin_hook_should_skip; then
        exit 0
    fi
fi
validator="$repo_root/tools/model-map-validate.js"

if ! command -v node >/dev/null 2>&1 || [ ! -f "$validator" ]; then
    exit 0  # validator unavailable — skip silently
fi

# Run validation (single invocation — capture output, check exit code)
if validator_out=$(node "$validator" "$file_path" 2>&1); then
    msg="model-map.json valid — restart proxy to apply: pkill -f claude-proxy"
else
    msg=$(printf '%s' "$validator_out" | head -5)
fi

resolve_path() {
    local path="$1"
    local dir base
    dir=$(dirname "$path")
    base=$(basename "$path")
    if command -v realpath >/dev/null 2>&1; then
        realpath "$path" 2>/dev/null && return 0
    fi
    dir=$(cd -P "$dir" 2>/dev/null && pwd) || return 1
    printf '%s/%s\n' "$dir" "$base"
}

lineage_test="$repo_root/test/model-map-lineage.test.js"
repo_model_map="$repo_root/config/model-map.json"
if [ -f "$lineage_test" ] && resolved_file=$(resolve_path "$file_path") && resolved_repo_model_map=$(resolve_path "$repo_model_map"); then
    if [ "$resolved_file" = "$resolved_repo_model_map" ]; then
        if ! node "$lineage_test" >/dev/null 2>&1; then
            msg="${msg}
WARN: model-map lineage snapshot drift — review the routing diff, then run: node test/model-map-lineage.test.js --update"
        fi
    fi
fi

if command -v jq >/dev/null 2>&1; then
    msg_json=$(printf '%s' "$msg" | jq -Rs .)
else
    msg_json=$(node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(d)));" <<< "$msg")
fi
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}' "$msg_json"
