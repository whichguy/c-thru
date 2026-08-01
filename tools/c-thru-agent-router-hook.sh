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

# The launcher creates a distinct stable per-user 0600 token so independent
# sessions can safely reuse one fixed proxy. It exports only this path; the hook
# reads the token while signing and never logs it. Direct hook use without the
# launcher/token fails closed: the valid fallback alias is still injected, but
# no forgeable marker is added.
CLAUDE_DIR="${CLAUDE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
AGENT_SENTINEL_SECRET_FILE="${C_THRU_AGENT_SENTINEL_SECRET_FILE:-$CLAUDE_DIR/proxy.agent-token}"

agent_sentinel_tag() {
  local name="$1" secret="${C_THRU_AGENT_SENTINEL_SECRET:-}"
  if [[ -z "$secret" && -s "$AGENT_SENTINEL_SECRET_FILE" ]]; then
    secret="$(cat "$AGENT_SENTINEL_SECRET_FILE" 2>/dev/null || true)"
  fi
  [[ ${#secret} -ge 32 ]] || return 0
  command -v node >/dev/null 2>&1 || return 0
  C_THRU_AGENT_SENTINEL_SECRET="$secret" C_THRU_AGENT_SENTINEL_NAME="$name" node -e '
const crypto = require("crypto");
const secret = process.env.C_THRU_AGENT_SENTINEL_SECRET || "";
const name = process.env.C_THRU_AGENT_SENTINEL_NAME || "";
if (Buffer.byteLength(secret, "utf8") < 32 || !name) process.exit(0);
process.stdout.write(
  crypto.createHmac("sha256", secret)
    .update("c-thru-agent-v1:" + name, "utf8")
    .digest("hex")
);
' 2>/dev/null
}

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
    [ -n "$lookup_key" ] || {
      [ -n "$DEBUG_LOG" ] && printf '[%s] Agent tool call with no subagent_type — pass through\n' "$(date +%H:%M:%S)" >> "$DEBUG_LOG"
      exit 0
    }
    capability=$(resolve_capability "$lookup_key")
    ;;

  WebSearch|WebFetch|Monitor|Plan)
    # Non-LLM tools: log capability mapping for observability, pass through
    # without updatedInput.model (setting it corrupts tool input params).
    # Do NOT write to stderr — Claude Code paints exit-0 hook stderr into the
    # TUI and that interleaves with the interactive session (mouse/redraw noise).
    mapped_cap=$(resolve_capability "$tool_name")
    if [ -n "$mapped_cap" ] && [ -n "$DEBUG_LOG" ]; then
      printf '[%s] tool=%s capability=%s (observability only)\n' "$(date +%H:%M:%S)" "$tool_name" "$mapped_cap" >> "$DEBUG_LOG"
    fi
    exit 0
    ;;

  *)
    # Unknown tool — pass through without override
    exit 0
    ;;
esac

[ -n "$DEBUG_LOG" ] && printf '[%s] capability=%s\n' "$(date +%H:%M:%S)" "${capability:-<empty>}" >> "$DEBUG_LOG"
[ -n "$capability" ] || {
  [ -n "$DEBUG_LOG" ] && printf '[%s] no capability mapping for lookup_key=%s — pass through\n' "$(date +%H:%M:%S)" "$lookup_key" >> "$DEBUG_LOG"
  exit 0
}

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
#   2. prompt — we prepend a shared-agent-token-authenticated sentinel to the task
#      prompt. It becomes the subagent's first user message and rides in body.messages
#      on the subagent's requests; the proxy reads it and routes THIS request to the
#      agent's mapped model (overriding the alias). This remains the routing-name
#      channel: current Claude Code gateway requests include session/agent/parent
#      correlation IDs, but the protocol does not document any of those IDs as the
#      configured subagent_type key used by agent_to_capability. Per-request +
#      stateless, so concurrent agents don't race.
#      See docs/planning/agent-delegation-findings.md.
# Claude Code Agent tool only accepts sonnet|opus|haiku|fable. When the brand
# leaf *is* one of those, inject that enum id (exposes fable/opus as the model).
# Other brands keep a fallback alias; the signed sentinel carries the real name.
inject_model="${C_THRU_AGENT_FALLBACK_ALIAS:-sonnet}"
case "${lookup_key}" in
  sonnet|opus|haiku|fable) inject_model="$lookup_key" ;;
esac
# Stamp [[c-thru-agent:<name>:<hmac-sha256>]]. Missing signing state fails
# closed: keep the enum-safe fallback model but add no unsigned routing marker.
hmac_tag="$(agent_sentinel_tag "$lookup_key")"
if [[ "$hmac_tag" =~ ^[0-9a-f]{64}$ ]]; then
  sentinel="[[c-thru-agent:${lookup_key}:${hmac_tag}]]"$'\n'
  sentinel_state="signed"
else
  sentinel=""
  sentinel_state="disabled"
fi
# Identity questions for the subagent prompt.
# Claude Code only accepts aliases (sonnet/opus/haiku/fable) on Agent `model`
# for validation; the proxy rewrites via the sentinel to the brand pin when
# signed. Brand leaves (agent_to_capability → model:*) carry an Identity block
# in their agent system prompt — honor that over the transport alias.
# Non-brand leaves: answer as the model actually generating this response.
identity_block=""
if [[ -n "$lookup_key" ]]; then
  if [[ "$capability" == model:* ]]; then
    case "${lookup_key}" in
      sonnet|opus|haiku|fable)
        # Anthropic brand leaf: tool model may match the brand name; still follow Identity.
        identity_block="IDENTITY QUESTIONS: You are the c-thru brand leaf \"${lookup_key}\" (pin ${capability}). When asked your model name, maker, or origin: follow your agent system Identity section. You may claim Claude/Anthropic family. The Agent-tool model field \"${inject_model}\" is a transport alias that may match your brand name — routing still uses the signed sentinel + proxy latest_models pin."
        ;;
      *)
        identity_block="IDENTITY QUESTIONS: You are the c-thru brand leaf \"${lookup_key}\" (pin ${capability}). When asked your model name, maker, or origin: follow your agent system Identity section. Do NOT claim to be Claude, Anthropic, Sonnet, Opus, or Haiku unless your brand family is anthropic-claude. The Agent-tool model field \"${inject_model}\" is only a transport validation alias — it is NOT your identity."
        ;;
    esac
  else
    identity_block="IDENTITY QUESTIONS: If asked what model you are, what model version, or who made you, answer only from your direct knowledge of yourself as the model actually generating this response. Do not assume or invent identity from Agent-tool aliases (e.g. \"${inject_model}\"), agent names, routing labels, or training-data defaults about other products. If you are unsure, say you are unsure — do not guess."
  fi
  identity_block+=$'\n\n'
fi
prompt_prefix="${sentinel}${identity_block}"
[ -n "$DEBUG_LOG" ] && printf '[%s] capability=%s OUTPUT model=%s sentinel=%s agent=%s identity_nudge=%s (proxy routes only signed sentinels)\n' "$(date +%H:%M:%S)" "$capability" "$inject_model" "$sentinel_state" "$lookup_key" "${identity_block:+yes}" >> "$DEBUG_LOG"

if command -v jq >/dev/null 2>&1; then
  # Merge model + sentinel+identity-prefixed prompt into the original tool_input
  # (preserves all other fields; safe against full-replace behavior).
  printf '%s' "$stdin_data" | jq -c --arg model "$inject_model" --arg prefix "$prompt_prefix" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "allow",
      "updatedInput": (.tool_input + {model: $model, prompt: ($prefix + (.tool_input.prompt // ""))})
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
  const model = process.argv[1], prefix = process.argv[2];
  const updatedInput = Object.assign({}, inp, { model, prompt: prefix + (inp.prompt || "") });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput } }));
});
' "$inject_model" "$prompt_prefix"
fi
