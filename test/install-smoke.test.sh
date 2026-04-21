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

# Snapshot real settings.json mtime before the run
REAL_SETTINGS="$HOME/.claude/settings.json"  # resolves inside sandbox — safe

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
    # Bug #2 regression: matcher must be "*", not a pipe-syntax literal
    mc_matcher=$(jq -r '
        [.hooks.PostToolUse // [] | .[].hooks[] |
         select(.command // "" | endswith("c-thru-map-changed"))] |
        .[0] // null' "$SETTINGS" 2>/dev/null)

    # The matcher lives on the PostToolUse entry, not the hook itself
    mc_entry_matcher=$(jq -r '
        (.hooks.PostToolUse // []) |
        map(select(.hooks[]?.command // "" | endswith("c-thru-map-changed"))) |
        .[0].matcher // ""' "$SETTINGS" 2>/dev/null)
    check 'PostToolUse c-thru-map-changed matcher == "*"' "*" "$mc_entry_matcher"

    # No duplicate c-thru-map-changed registrations
    mc_count=$(jq '[
        (.hooks.PostToolUse // []) |
        .[].hooks[] |
        select(.command // "" | endswith("c-thru-map-changed"))
    ] | length' "$SETTINGS" 2>/dev/null || echo 0)
    check "PostToolUse c-thru-map-changed count == 1" "1" "$mc_count"

    # MCP server registered in ~/.claude.json (HOME is sandboxed)
    claude_json="$FAKE_HOME/.claude.json"
    mcp_arg=$(jq -r '.mcpServers["llm-capabilities"].args[0] // ""' "$claude_json" 2>/dev/null || echo "")
    check 'MCP llm-capabilities registered' "yes" "$([ -n "$mcp_arg" ] && echo yes || echo no)"
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

    # No new duplicate map-changed hook after second run
    mc_count2=$(jq '[
        (.hooks.PostToolUse // []) |
        .[].hooks[] |
        select(.command // "" | endswith("c-thru-map-changed"))
    ] | length' "$SETTINGS" 2>/dev/null || echo 0)
    check "No duplicate c-thru-map-changed after second run" "1" "$mc_count2"
fi

echo ""
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
