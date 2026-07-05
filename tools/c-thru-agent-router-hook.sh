#!/usr/bin/env bash
# ARCH: PreToolUse — intercepts Agent and other tool calls and overrides the
# model parameter so the c-thru proxy receives the correct capability alias.
#
# Agent: resolves subagent_type through agent_to_capability in model-map.json.
# Claude Code's Agent tool ignores the model: field in agent frontmatter
# (known bug #44385), so the hook forces the correct model at the tool-call level.
#
# UPSTREAM WATCH — retirement condition (see docs/derived-artifacts.md, Tier 3):
# when claude-code#44385 ships upstream, frontmatter model: suffices and the
# Agent-tool model-injection branch below should be RETIRED — it becomes dead
# weight plus a double-override risk (hook and frontmatter both setting model).
# Keep the observability logging and the non-Agent passthrough when retiring.
#
# Only Agent tool calls are routed (they spawn subagents that make LLM requests).
# Non-LLM tools (WebSearch, WebFetch, Monitor, Plan) pass through without override
# since they don't generate LLM requests and setting updatedInput.model on them
# corrupts their tool input parameters.
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
  if [[ "$key" == advisor:* ]]; then
    local pinned_model="${key#advisor:}"
    if [[ "$pinned_model" == *[![:space:]]* ]]; then
      echo 'advisor-pin'
      return 0
    fi
  fi
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
    [ -n "$lookup_key" ] || { printf '[c-thru-agent-router] Agent tool call with no subagent_type — pass through\n' >&2; exit 0; }
    capability=$(resolve_capability "$lookup_key")
    ;;

  WebSearch|WebFetch|Monitor|Plan)
    # Non-LLM tools: log capability mapping for observability, pass through
    # without updatedInput.model (setting it corrupts tool input params).
    mapped_cap=$(resolve_capability "$tool_name")
    if [ -n "$mapped_cap" ]; then
      printf '[c-thru-agent-router] tool=%s capability=%s (observability only — no model override)\n' "$tool_name" "$mapped_cap" >&2
    fi
    exit 0
    ;;

  *)
    # Unknown tool — pass through without override
    exit 0
    ;;
esac

[ -n "$DEBUG_LOG" ] && printf '[%s] capability=%s\n' "$(date +%H:%M:%S)" "${capability:-<empty>}" >> "$DEBUG_LOG"
[ -n "$capability" ] || { printf '[c-thru-agent-router] no capability mapping for lookup_key=%s — pass through\n' "$lookup_key" >&2; exit 0; }

# --- Output updatedInput ---------------------------------------------
# This hook is the per-delegation HANDSHAKE that carries the agent identity to the
# proxy. It does two things on every Agent call (so N agents → N models works
# dynamically within one session — nothing here is static or one-time):
#
#   1. model — Claude Code validates the Agent tool's `model` against a small alias
#      enum (sonnet/opus/haiku/fable) and BLOCKS the delegation on anything else
#      (injecting a capability name was the prior, silently-blocking behavior). So we
#      inject a VALID alias purely to pass that validation; it is also the graceful
#      fallback model when the proxy isn't in-loop.
#   2. prompt — we prepend a [[c-thru-agent:<subagent_type>]] sentinel to the task
#      prompt. It becomes the subagent's first user message and rides in body.messages
#      on the subagent's requests; the proxy reads it and routes THIS request to the
#      agent's mapped model (overriding the alias). The only reliable channel for the
#      agent identity to reach the proxy — Claude Code exposes no per-subagent header
#      or out-of-band tag. Per-request + stateless, so concurrent agents don't race.
#      See docs/planning/agent-delegation-findings.md.
inject_model="${C_THRU_AGENT_FALLBACK_ALIAS:-sonnet}"
sentinel="[[c-thru-agent:${lookup_key}]]"$'\n'
[ -n "$DEBUG_LOG" ] && printf '[%s] capability=%s OUTPUT model=%s sentinel=agent:%s (proxy routes per sentinel)\n' "$(date +%H:%M:%S)" "$capability" "$inject_model" "$lookup_key" >> "$DEBUG_LOG"

if command -v jq >/dev/null 2>&1; then
  # Merge model + sentinel-prefixed prompt into the original tool_input (preserves
  # all other fields; safe against full-replace behavior).
  printf '%s' "$stdin_data" | jq -c --arg model "$inject_model" --arg sentinel "$sentinel" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "allow",
      "updatedInput": (.tool_input + {model: $model, prompt: ($sentinel + (.tool_input.prompt // ""))})
    }
  }'
else
  # node fallback (no jq): same full merge — preserve tool_input, set model, prefix prompt.
  printf '%s' "$stdin_data" | node -e '
let d=""; process.stdin.setEncoding("utf8");
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  let inp = {};
  try { inp = (JSON.parse(d).tool_input) || {}; } catch (e) {}
  const model = process.argv[1], sentinel = process.argv[2];
  const updatedInput = Object.assign({}, inp, { model, prompt: sentinel + (inp.prompt || "") });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput } }));
});
' "$inject_model" "$sentinel"
fi
