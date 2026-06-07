#!/usr/bin/env bash
# B2 — router-hook unit suite (deterministic, no LLM).
#
# Proves the "a prompt selected subagent X → the request carries the right
# model" seam: tools/c-thru-agent-router-hook.sh is the PreToolUse hook that
# rewrites an Agent tool call's model field to the resolved capability (working
# around Claude Code bug #44385, where the Agent tool ignores frontmatter
# `model:`). We feed it synthetic PreToolUse payloads on stdin and assert:
#   - Agent calls → updatedInput.model == agent_to_capability[subagent_type]
#     (including the two non-1:1 remaps), for every agent in the fleet,
#   - non-LLM tools (WebSearch, Plan) pass through UNMODIFIED (no stdout),
#   - unknown subagent_type passes through (no override),
#   - the merge preserves the original tool_input fields (jq path).
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

# Expected capability for an agent, read straight from the production config.
expected_cap() {
  local agent="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg a "$agent" '.agent_to_capability[$a] // empty' "$MODEL_MAP"
  else
    node -e 'const m=require(process.argv[1]);process.stdout.write(String((m.agent_to_capability||{})[process.argv[2]]||""))' "$MODEL_MAP" "$agent"
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

# ── 1. Every agent → updatedInput.model == resolved capability ────────────────
echo "1. Agent subagent_type → resolved capability (full fleet)"
AGENTS=$(find "$REPO_DIR/agents" -maxdepth 1 -name '*.md' -exec basename {} .md \; | sort)
agent_count=0
for agent in $AGENTS; do
  agent_count=$((agent_count+1))
  exp=$(expected_cap "$agent")
  got=$(hook_model "$(agent_payload "$agent")")
  check "Agent($agent) → model=$exp" "$exp" "$got"
done
check "fleet roster is 22 agents" "22" "$agent_count"

# ── 2. The two documented non-1:1 remaps resolve to the OTHER capability ───────
echo ""
echo "2. Non-1:1 remaps (subagent_type != capability)"
check "reviewer-plan → code-reviewer" "code-reviewer" "$(hook_model "$(agent_payload reviewer-plan)")"
check "plan-scheduler → fast-generalist" "fast-generalist" "$(hook_model "$(agent_payload plan-scheduler)")"

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

# ── 5. Merge preserves original tool_input fields (jq path only) ───────────────
echo ""
echo "5. updatedInput merges model into the original tool_input (preserves fields)"
if command -v jq >/dev/null 2>&1; then
  out=$(hook_raw "$(agent_payload planner)")
  got_prompt=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.prompt // empty')
  got_subtype=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.subagent_type // empty')
  got_decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty')
  check "original prompt preserved in updatedInput" "p" "$got_prompt"
  check "original subagent_type preserved in updatedInput" "planner" "$got_subtype"
  check "permissionDecision=allow" "allow" "$got_decision"
else
  echo "  SKIP  merge-preservation checks (jq not on PATH)"
fi

# ── 6. node-fallback path (no jq) still emits the right model ──────────────────
echo ""
echo "6. node fallback (jq removed from PATH) still resolves model"
nojq_path=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '/jq' | tr '\n' ':')
got=$(printf '%s' "$(agent_payload coder)" | PATH="$nojq_path" bash "$HOOK" 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(d).hookSpecificOutput.updatedInput.model||""))}catch{}})')
check "coder → coder via node fallback" "coder" "$got"

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
