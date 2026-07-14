#!/usr/bin/env bash
# Smoke + idempotency tests for install.sh.
# Catches: hook matcher syntax (bug #2), OVR_MAP not clobbering on re-run (bug #4),
# symlink presence, duplicate hook registration.
#
# Run: bash test/install-smoke.test.sh

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=test/helpers.sh
source "$REPO_DIR/test/helpers.sh"

# ---------------------------------------------------------------------------
# Sandboxed home + CLAUDE_DIR — no writes to the real ~/.claude
# ---------------------------------------------------------------------------
TMP=$(mktemp -d)
FAKE_HOME="$TMP/home"
FAKE_CLAUDE="$FAKE_HOME/.claude"
mkdir -p "$FAKE_HOME"
export HOME="$FAKE_HOME"
export CLAUDE_DIR="$FAKE_CLAUDE"

# (The durable ~/.claude/settings.json byte-identity invariant is asserted
# hermetically by cli-e2e-flags.test.js; this suite asserts "no persistent
# hooks/MCP" below.)

trap 'rm -rf "$TMP"' EXIT

echo "=== First run ==="
(cd "$REPO_DIR" && bash install.sh 2>/dev/null) || { echo "ABORT: install.sh non-zero on first run"; exit 1; }

SETTINGS="$FAKE_CLAUDE/settings.json"

# ---------------------------------------------------------------------------
# Symlink assertions
# ---------------------------------------------------------------------------
echo "Symlinks:"
assert_symlink() {
    local name="$1" target="$2"
    local link="$FAKE_CLAUDE/tools/$name"
    local actual
    actual=$(readlink "$link" 2>/dev/null || echo "")
    check "symlink $name → $target" "$target" "$actual"
}

assert_symlink "c-thru"            "$REPO_DIR/tools/c-thru"
assert_symlink "cthru"             "$REPO_DIR/tools/c-thru"   # convenience alias ≡ c-thru
assert_symlink "c-thru-map-changed" "$REPO_DIR/tools/c-thru-map-changed.sh"
assert_symlink "verify-lmstudio-ollama-compat" "$REPO_DIR/tools/verify-lmstudio-ollama-compat.sh"
assert_symlink "c-thru-ollama-probe" "$REPO_DIR/tools/c-thru-ollama-probe.sh"

# ---------------------------------------------------------------------------
# model-map files
# ---------------------------------------------------------------------------
echo "Model-map files:"
check "model-map.overrides.json is {}" "{}" "$(cat "$FAKE_CLAUDE/model-map.overrides.json" 2>/dev/null || echo MISSING)"
check "model-map.system.json exists" "yes" "$([ -f "$FAKE_CLAUDE/model-map.system.json" ] && echo yes || echo no)"

# Validate system map via the repo's validator (node required)
if command -v node >/dev/null 2>&1 && [ -f "$REPO_DIR/tools/model-map-validate.js" ]; then
    node "$REPO_DIR/tools/model-map-validate.js" "$FAKE_CLAUDE/model-map.system.json" 2>/dev/null
    check "model-map.system.json valid" "0" "$?"
fi

# ---------------------------------------------------------------------------
# Hook assertions (settings.json)
# ---------------------------------------------------------------------------
echo "Hook assertions:"

if ! command -v jq >/dev/null 2>&1; then
    echo "  SKIP  (jq not available)"
else
    # Ephemeral architecture: hooks are NOT written to persistent settings.json.
    # Regression guard: install.sh must NOT inject persistent hooks.
    has_hooks=$(jq 'has("hooks")' "$SETTINGS" 2>/dev/null || echo "false")
    check 'No persistent hooks in settings.json (ephemeral arch)' "false" "$has_hooks"

    # MCP server is also ephemeral — not in ~/.claude.json.
    claude_json="$FAKE_HOME/.claude.json"
    has_mcp=$(jq 'has("mcpServers")' "$claude_json" 2>/dev/null || echo "false")
    check 'No persistent MCP in .claude.json (ephemeral arch)' "false" "$has_mcp"
fi

# ---------------------------------------------------------------------------
# Hook script executability — all hook tools must be symlinked and executable
# ---------------------------------------------------------------------------
echo "Hook scripts:"
HOOK_SCRIPTS=(
    c-thru-session-start
    c-thru-proxy-health
    c-thru-classify
    c-thru-map-changed
    c-thru-stop-hook
    c-thru-stop-failure-hook
    c-thru-enter-plan-hook
    c-thru-postcompact-context
    c-thru-statusline
    c-thru-statusline-overlay
)
for hs in "${HOOK_SCRIPTS[@]}"; do
    link="$FAKE_CLAUDE/tools/$hs"
    if [ -L "$link" ] && [ -x "$link" ]; then
        check "hook script $hs: symlinked + executable" "ok" "ok"
    elif [ -L "$link" ]; then
        check "hook script $hs: symlinked + executable" "ok" "symlinked-but-not-executable"
    else
        check "hook script $hs: symlinked + executable" "ok" "missing"
    fi
done

# ---------------------------------------------------------------------------
# Fleet hook stem strip — repo-path + tools-path hooks removed; user hooks kept
# ---------------------------------------------------------------------------
echo ""
echo "=== Fleet hook cleanup (repo-path / stem) ==="

if command -v jq >/dev/null 2>&1; then
  # Historical double-fire: durable settings with repo-path fleet scripts.
  # install.sh must strip by stem (not only ~/.claude/tools/ prefix).
  cat > "$SETTINGS" <<EOF
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$REPO_DIR/tools/c-thru-session-start.sh\"",
            "timeout": 10
          },
          {
            "type": "command",
            "command": "echo user-session-hook-keep",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$FAKE_CLAUDE/tools/c-thru-classify",
            "timeout": 8
          }
        ]
      }
    ]
  }
}
EOF
  # Surface install stderr on failure (silent 2>/dev/null hid the jq bugs).
  # Full stem list must match install.sh is_cthru_fleet_hook + c-thru OWNED stems.
  _install_err="$TMP/install-hook-cleanup.err"
  if ! (cd "$REPO_DIR" && bash install.sh >"$TMP/install-hook-cleanup.out" 2>"$_install_err"); then
    echo "ABORT: install.sh non-zero during hook-cleanup run" >&2
    tail -40 "$_install_err" >&2 || true
    exit 1
  fi

  remaining_fleet=$(jq -r '
    [.hooks // {} | .. | objects | .command? // empty]
    | map(select(test("c-thru-(session-start|postcompact-context|proxy-health|classify|map-changed|plan-visibility-hook|stop-hook|stop-failure-hook|autonomous-gate|agent-router-hook|enter-plan-hook)")))
    | length
  ' "$SETTINGS" 2>/dev/null || echo "err")
  check "repo/tools fleet hooks stripped by install" "0" "$remaining_fleet"

  user_kept=$(jq -r '
    [.hooks // {} | .. | objects | .command? // empty]
    | map(select(test("user-session-hook-keep")))
    | length
  ' "$SETTINGS" 2>/dev/null || echo "0")
  check "non-c-thru user hook preserved" "1" "$user_kept"

  # Only the user SessionStart hook should remain (fleet UserPromptSubmit gone).
  events_left=$(jq -r '(.hooks // {}) | keys | sort | join(",")' "$SETTINGS" 2>/dev/null || echo "")
  check "only SessionStart event remains after fleet strip" "SessionStart" "$events_left"

  # Reset settings for the rest of the suite (ephemeral arch expects no durable
  # c-thru hooks; user-hook residue would break the "no hooks" idempotency checks).
  printf '{}\n' > "$SETTINGS"
else
  echo "  SKIP  fleet hook cleanup (jq not available)"
fi

# ---------------------------------------------------------------------------
# Second run — idempotency + overrides preservation
# ---------------------------------------------------------------------------
echo ""
echo "=== Second run (idempotency) ==="

# Seed user content that must survive re-install
printf '{"llm_mode":"offline","custom":"preserved"}' > "$FAKE_CLAUDE/model-map.overrides.json"

(cd "$REPO_DIR" && bash install.sh 2>/dev/null) || { echo "ABORT: install.sh non-zero on second run"; exit 1; }

echo "Overrides preservation:"
if command -v jq >/dev/null 2>&1; then
    ovr_custom=$(jq -r '.custom // ""' "$FAKE_CLAUDE/model-map.overrides.json" 2>/dev/null || echo "")
    ovr_mode=$(jq -r '.llm_mode // ""' "$FAKE_CLAUDE/model-map.overrides.json" 2>/dev/null || echo "")
    check "overrides .custom preserved" "preserved" "$ovr_custom"
    check "overrides .llm_mode preserved" "offline" "$ovr_mode"

    # Idempotency: settings.json still has no persistent hooks after second run
    has_hooks2=$(jq 'has("hooks")' "$SETTINGS" 2>/dev/null || echo "false")
    check 'No persistent hooks after second run' "false" "$has_hooks2"

    # Idempotency: extend_model_map is now guardless (it re-runs every install). Verify the
    # deep-merge preserves the shipped capability-outer profile across a re-install rather
    # than corrupting/dropping it. (Probes a real capability — `planner` — not the dead
    # `judge` key the removed guard used.)
    if [ -f "$FAKE_CLAUDE/model-map.system.json" ]; then
        sys_planner=$(jq -r '.llm_profiles.planner["best-cloud"]["128gb"] // ""' "$FAKE_CLAUDE/model-map.system.json" 2>/dev/null || echo "")
        shipped_planner=$(jq -r '.llm_profiles.planner["best-cloud"]["128gb"] // ""' "$REPO_DIR/config/model-map.json" 2>/dev/null || echo "")
        check 'system-map planner profile preserved after second run' "$shipped_planner" "$sys_planner"
    fi
fi

# ---------------------------------------------------------------------------
# Regression guard: free-port capture must survive FORCE_COLOR (a coding-agent
# sandbox commonly exports FORCE_COLOR=3, which makes Node's console.log
# ANSI-colorize its args even through command substitution — this silently
# corrupted the captured port with escape bytes and broke the whole install
# E2E check). Assert the captured value is a bare integer string regardless.
# ---------------------------------------------------------------------------
echo "Free-port capture under FORCE_COLOR:"
free_port_under_color="$(FORCE_COLOR=3 node -e "const s=require('net').createServer(); s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})" 2>/dev/null || true)"
if [[ "$free_port_under_color" =~ ^[0-9]+$ ]]; then
    check "free-port capture is a bare integer under FORCE_COLOR=3" "yes" "yes"
else
    check "free-port capture is a bare integer under FORCE_COLOR=3" "yes" "no (got: $free_port_under_color)"
fi

echo ""
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
