#!/usr/bin/env bash
# B2 — router-hook unit suite (deterministic, no LLM).
#
# Proves the PreToolUse hook (tools/c-thru-agent-router-hook.sh) — the per-delegation
# HANDSHAKE that carries agent identity to the proxy. On every Agent call it:
#   1. injects a VALID model alias (C_THRU_AGENT_FALLBACK_ALIAS, default "sonnet").
#      Current Claude Code validates the Agent tool's `model` against a 4-alias enum
#      (sonnet/opus/haiku/fable) and BLOCKS the delegation on anything else — so the
#      old behavior (injecting the capability name) silently blocked every c-thru
#      agent. The alias passes validation + is the proxy-absent fallback.
#   2. prepends a [[c-thru-agent:<subagent_type>]] sentinel to the task prompt, which
#      becomes the subagent's first user message → rides in body.messages → the proxy
#      reads it and routes THIS request to the agent's mapped model. Per-request +
#      stateless, so many agents → many models work concurrently in one session.
#      See docs/planning/agent-delegation-findings.md.
# We feed synthetic PreToolUse payloads on stdin and assert:
#   - Agent calls (any mapped agent) → updatedInput.model == the valid alias,
#   - the alias is overridable via C_THRU_AGENT_FALLBACK_ALIAS,
#   - updatedInput.prompt carries the [[c-thru-agent:<type>]] sentinel + original task,
#   - non-LLM tools (WebSearch, Plan) pass through UNMODIFIED (no stdout),
#   - unknown subagent_type passes through (no override),
#   - the node-fallback path (no jq) emits both the alias and the sentinel.
#
# Named *.test.js for runner-glob symmetry with the other agent suites, but it's
# a bash script (the hook is bash). Run: bash test/agent-router-hook.test.js
#
# shellcheck shell=bash
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=test/helpers.sh
source "$REPO_DIR/test/helpers.sh"

HOOK="$REPO_DIR/tools/c-thru-agent-router-hook.sh"
MODEL_MAP="$REPO_DIR/config/model-map.json"
export CLAUDE_MODEL_MAP_PATH="$MODEL_MAP"

# The alias the hook injects by default (the Agent-tool enum requires one of
# sonnet/opus/haiku/fable). Keep in sync with the hook's default.
DEFAULT_ALIAS="sonnet"

# True iff the agent name has a capability mapping (the hook only overrides those;
# unmapped agents/built-ins pass through).
has_capability() {
  local agent="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -e --arg a "$agent" '.agent_to_capability[$a] // empty' "$MODEL_MAP" >/dev/null 2>&1
  else
    node -e 'const m=require(process.argv[1]);process.exit((m.agent_to_capability||{})[process.argv[2]]?0:1)' "$MODEL_MAP" "$agent"
  fi
}

# Run the hook with a payload, echo the resolved updatedInput.model (or "").
hook_model() {
  local payload="$1" out
  out=$(printf '%s' "$payload" | bash "$HOOK" 2>/dev/null || true)
  [ -n "$out" ] || { echo ""; return; }
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.model // empty' 2>/dev/null
  else
    node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(d).hookSpecificOutput.updatedInput.model||""))}catch{}})' <<<"$out"
  fi
}

# Raw hook stdout (for pass-through assertions).
hook_raw() {
  printf '%s' "$1" | bash "$HOOK" 2>/dev/null || true
}

agent_payload() {
  printf '{"tool_name":"Agent","tool_input":{"subagent_type":"%s","description":"d","prompt":"p"}}' "$1"
}

# ── 1. Every mapped agent → updatedInput.model == the valid alias (unblocks) ──────
echo "1. Agent subagent_type → valid alias '$DEFAULT_ALIAS' (full fleet, unblocks delegation)"
AGENTS=$(find "$REPO_DIR/agents" -maxdepth 1 -name '*.md' -exec basename {} .md \; | sort)
agent_count=0
for agent in $AGENTS; do
  agent_count=$((agent_count+1))
  if has_capability "$agent"; then
    check "Agent($agent) → model=$DEFAULT_ALIAS (valid, not blocked)" "$DEFAULT_ALIAS" "$(hook_model "$(agent_payload "$agent")")"
  else
    check "Agent($agent) → passthrough (no capability mapping)" "" "$(hook_model "$(agent_payload "$agent")")"
  fi
done
check "fleet roster is 22 agents" "22" "$agent_count"

# ── 2. The injected alias is a VALID enum value, and is overridable ───────────────
echo ""
echo "2. Injected model is always a valid Agent-tool alias; remaps no longer affect the hook"
# reviewer-plan / plan-scheduler used to remap to a different capability; now the
# hook injects the same valid alias for all (per-agent routing is the proxy's job).
check "reviewer-plan → $DEFAULT_ALIAS (valid alias)" "$DEFAULT_ALIAS" "$(hook_model "$(agent_payload reviewer-plan)")"
check "plan-scheduler → $DEFAULT_ALIAS (valid alias)" "$DEFAULT_ALIAS" "$(hook_model "$(agent_payload plan-scheduler)")"
got_override=$(C_THRU_AGENT_FALLBACK_ALIAS=opus hook_model "$(agent_payload coder)")
check "C_THRU_AGENT_FALLBACK_ALIAS=opus → model=opus" "opus" "$got_override"

# ── 3. Non-LLM tools pass through unmodified (no updatedInput emitted) ─────────
echo ""
echo "3. Non-LLM tools pass through with NO model override"
check "WebSearch → no stdout (passthrough)" "" "$(hook_raw '{"tool_name":"WebSearch","tool_input":{"query":"hi"}}')"
check "Plan → no stdout (passthrough)" "" "$(hook_raw '{"tool_name":"Plan","tool_input":{"plan":"x"}}')"
check "Bash → no stdout (unknown tool passthrough)" "" "$(hook_raw '{"tool_name":"Bash","tool_input":{"command":"ls"}}')"

# ── 4. Unknown subagent_type passes through (no override) ──────────────────────
echo ""
echo "4. Unknown / missing subagent_type → no override"
check "unknown subagent_type → empty model" "" "$(hook_model "$(agent_payload totally-unknown-agent-xyz)")"
check "Agent with no subagent_type → no stdout" "" "$(hook_raw '{"tool_name":"Agent","tool_input":{"prompt":"p"}}')"
check "empty payload → no stdout" "" "$(hook_raw '{}')"

# ── 5. updatedInput merges model + sentinel-prompt, preserving fields (jq path) ──
echo ""
echo "5. updatedInput injects model + [[c-thru-agent:..]] sentinel prompt, preserves fields"
if command -v jq >/dev/null 2>&1; then
  out=$(hook_raw "$(agent_payload planner)")
  got_prompt=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.prompt // empty')
  got_subtype=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.subagent_type // empty')
  got_decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty')
  sentinel_ok=$(printf '%s' "$got_prompt" | grep -qF '[[c-thru-agent:planner]]' && echo yes || echo no)
  orig_ok=$(printf '%s' "$got_prompt" | grep -qF 'p' && echo yes || echo no)
  check "prompt carries the [[c-thru-agent:planner]] sentinel" "yes" "$sentinel_ok"
  check "prompt preserves the original task text" "yes" "$orig_ok"
  check "original subagent_type preserved in updatedInput" "planner" "$got_subtype"
  check "permissionDecision=allow" "allow" "$got_decision"
else
  echo "  SKIP  merge-preservation checks (jq not on PATH)"
fi

# ── 6. node-fallback path (no jq) emits the alias AND the sentinel prompt ───────
echo ""
echo "6. node fallback (jq removed from PATH) emits alias + sentinel prompt"
nojq_path=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '/jq' | tr '\n' ':')
nojq_out=$(printf '%s' "$(agent_payload coder)" | PATH="$nojq_path" bash "$HOOK" 2>/dev/null)
got=$(printf '%s' "$nojq_out" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(d).hookSpecificOutput.updatedInput.model||""))}catch{}})')
got_np=$(printf '%s' "$nojq_out" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(d).hookSpecificOutput.updatedInput.prompt||""))}catch{}})')
nojq_sentinel_ok=$(printf '%s' "$got_np" | grep -qF '[[c-thru-agent:coder]]' && echo yes || echo no)
check "coder → $DEFAULT_ALIAS via node fallback" "$DEFAULT_ALIAS" "$got"
check "node fallback prompt carries [[c-thru-agent:coder]] sentinel" "yes" "$nojq_sentinel_ok"

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
