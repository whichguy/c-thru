#!/usr/bin/env bash
# ARCH: PreToolUse — intercepts Agent and other tool calls and overrides the
# model parameter so the c-thru proxy receives the correct capability alias.
#
# Agent: resolves subagent_type through agent_to_capability in model-map.json.
# Claude Code's Agent tool ignores the model: field in agent frontmatter
# (known bug #44385), so the hook forces the correct model at the tool-call level.
#
# Other tools (WebSearch, WebFetch, Monitor, Plan): look up the tool_name
# directly in agent_to_capability. Add entries to agent_to_capability in
# config/model-map.json to route any tool to a different capability/model.
set -uo pipefail

DEBUG_LOG="${C_THRU_AGENT_HOOK_LOG:-}"
[ -n "$DEBUG_LOG" ] && printf '[%s] hook start\n' "$(date +%H:%M:%S)" >> "$DEBUG_LOG"

# --- Config -----------------------------------------------------------
ROUTER_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd 2>/dev/null || echo "")"
MODEL_MAP="${CLAUDE_MODEL_MAP_PATH:-$ROUTER_REPO_ROOT/config/model-map.json}"

# --- Helpers ----------------------------------------------------------

# Read a specific key from JSON using jq or node fallback
json_read() {
  local json="$1" key="$2"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r "$key // empty" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then
    node -e "
let d=''; process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  try{
    const obj=JSON.parse(d);
    // Split by '//' and evaluate each alternative (jq-like nullish fallback)
    const parts=process.argv[1].split('//').map(s=>s.trim()).filter(Boolean);
    for(const p of parts){
      if(p==='empty'){process.stdout.write('');return;}
      const val=p.split('.').filter(Boolean).reduce((o,k)=>o!=null?o[k]:undefined,obj);
      if(val!=null&&val!==''){process.stdout.write(String(val));return;}
    }
  }catch(e){}
});
" "$key" 2>/dev/null <<<"$json"
  fi
}

# Look up a key in agent_to_capability from model-map.json.
# Prints the capability name on stdout, or empty string if not found.
resolve_capability() {
  local key="$1"
  [ -n "$key" ] || return 0
  if [ ! -f "$MODEL_MAP" ]; then
    [ -n "$DEBUG_LOG" ] && printf '[%s] model_map NOT FOUND at %s\n' "$(date +%H:%M:%S)" "$MODEL_MAP" >> "$DEBUG_LOG"
    return 0
  fi
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg key "$key" '.agent_to_capability[$key] // empty' "$MODEL_MAP" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then
    node -e "
const m=require(process.argv[1]);
const cap=(m.agent_to_capability||{})[process.argv[2]];
if(cap) process.stdout.write(String(cap));
" "$MODEL_MAP" "$key" 2>/dev/null
  fi
}

# --- Read hook payload ------------------------------------------------
stdin_data=$(cat)
stdin_len=$(printf '%s' "$stdin_data" | wc -c)
[ -n "$DEBUG_LOG" ] && printf '[%s] stdin=%d bytes\n' "$(date +%H:%M:%S)" "$stdin_len" >> "$DEBUG_LOG"

tool_name=$(json_read "$stdin_data" '.tool_name // empty')
[ -n "$DEBUG_LOG" ] && printf '[%s] tool_name=%s\n' "$(date +%H:%M:%S)" "${tool_name:-<empty>}" >> "$DEBUG_LOG"
[ -n "$tool_name" ] || exit 0

capability=""

case "$tool_name" in
  Agent)
    # Agent tool: look up subagent_type in agent_to_capability
    lookup_key=$(json_read "$stdin_data" '.tool_input.subagent_type // .tool_input.name // empty')
    [ -n "$DEBUG_LOG" ] && printf '[%s] lookup_key=%s\n' "$(date +%H:%M:%S)" "${lookup_key:-<empty>}" >> "$DEBUG_LOG"
    [ -n "$lookup_key" ] || exit 0
    capability=$(resolve_capability "$lookup_key")
    ;;

  # Non-Agent tools: pass the tool name through as the model name.
  # Add entries to agent_to_capability in config/model-map.json
  # to route each tool name to the desired capability.
  WebSearch|WebFetch|Monitor|Plan)
    capability="$tool_name"
    ;;

  *)
    # Unknown tool — pass through without override
    exit 0
    ;;
esac

[ -n "$DEBUG_LOG" ] && printf '[%s] capability=%s\n' "$(date +%H:%M:%S)" "${capability:-<empty>}" >> "$DEBUG_LOG"
[ -n "$capability" ] || exit 0

# --- Output updatedInput ---------------------------------------------
# Override model=<capability> so the proxy receives the correct model.
[ -n "$DEBUG_LOG" ] && printf '[%s] OUTPUT model=%s\n' "$(date +%H:%M:%S)" "$capability" >> "$DEBUG_LOG"
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"model":"%s"}}}' "$capability"
