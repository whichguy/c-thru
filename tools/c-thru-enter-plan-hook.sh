#!/usr/bin/env bash
# PreToolUse advisory hook: fires on EnterPlanMode.
# Emits a hint about /c-thru-plan to stderr. Never blocks.

# Consume stdin (hook payload) to avoid SIGPIPE.
cat > /dev/null

# Opt-out via env variable.
if [ "${CLAUDE_ROUTER_PLANNER_HINT:-1}" = "0" ]; then
    exit 0
fi

# Opt-out via planner_hint:false in model-map.overrides.json.
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
OVERRIDES="$CLAUDE_DIR/model-map.overrides.json"
if [ -f "$OVERRIDES" ] && command -v jq >/dev/null 2>&1; then
    hint=$(jq -r '.planner_hint // "unset"' "$OVERRIDES" 2>/dev/null)
    if [ "$hint" = "false" ]; then
        exit 0
    fi
fi

echo "💡 c-thru planner available: for multi-wave feature work, use /c-thru-plan <intent>" >&2
echo "   (disable this hint: /c-thru-config planning off)" >&2

exit 0
