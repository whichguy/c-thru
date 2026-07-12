#!/usr/bin/env bash
# c-thru autonomous gate — opt-in Stop hook for unattended repository checks.
# A local sentinel owns the block budget; all malformed or unavailable state
# fails open so ordinary Claude Code sessions are never held hostage.
set -euo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
SENTINEL="$ROOT/.claude/autonomous-gate.local.json"

# No sentinel means no autonomous run is active. Keep the normal interactive
# path to this one cheap filesystem check.
[[ -f "$SENTINEL" ]] || exit 0

# jq is required both to validate local state and to emit Claude Code's block
# decision safely. Without it, allow the stop rather than risking a loop.
if ! command -v jq >/dev/null 2>&1; then
    echo "c-thru autonomous gate: jq unavailable; allowing stop" >&2
    exit 0
fi

delete_corrupt_sentinel() {
    local why="$1"
    rm -f "$SENTINEL" || true
    echo "c-thru autonomous gate: deleted malformed sentinel ($why)" >&2
    exit 0
}

# Validate the counters before shell arithmetic. Keep them within a portable
# shell-safe range too: jq accepts enormous integral JSON numbers that Bash
# cannot safely compare or increment. The remaining fields are read only after
# the session guard, so a different session never inspects further state or
# mutates another autonomous run's sentinel.
if ! jq -e '
    (.max_blocks? | type == "number" and . >= 0 and . <= 2147483647 and floor == .) and
    (.blocks? | type == "number" and . >= 0 and . <= 2147483647 and floor == .)
' "$SENTINEL" >/dev/null 2>&1; then
    delete_corrupt_sentinel "invalid JSON or non-negative integer counters"
fi

sentinel_session=$(jq -r 'if (.session_id? | type) == "string" then .session_id else "" end' "$SENTINEL")
HOOK_INPUT=$(cat)
hook_session=$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // ""' 2>/dev/null || printf '')

# A non-empty sentinel session belongs only to that Claude Code session.
if [[ -n "$sentinel_session" ]] && [[ "$sentinel_session" != "$hook_session" ]]; then
    exit 0
fi

max_blocks=$(jq -r '.max_blocks' "$SENTINEL")
blocks=$(jq -r '.blocks' "$SENTINEL")
created=$(jq -r 'if (.created? | type) == "string" then .created else "" end' "$SENTINEL")

# BSD date accepts -j/-f while GNU date accepts -d. A non-portable or malformed
# timestamp is corrupt local state and must fail open just like bad JSON.
created_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$created" +%s 2>/dev/null || \
    date -u -d "$created" +%s 2>/dev/null || true)
if [[ ! "$created_epoch" =~ ^[0-9]+$ ]]; then
    delete_corrupt_sentinel "unparseable created timestamp"
fi

now_epoch=$(date -u +%s)
if (( now_epoch - created_epoch > 86400 )); then
    rm -f "$SENTINEL" || true
    echo "c-thru autonomous gate: deleted stale sentinel (older than 24 hours)" >&2
    exit 0
fi

# This budget is independent of Claude Code's engine-side consecutive-block
# protection. Exhaustion deliberately allows the stop and clears local state.
if (( blocks >= max_blocks )); then
    rm -f "$SENTINEL" || true
    echo "c-thru autonomous gate: block budget exhausted (${blocks}/${max_blocks}); allowing stop" >&2
    exit 0
fi

# Stop-hook re-entry is diagnostic only. The sentinel counter above is the
# sole control-flow safety mechanism, regardless of this engine-provided flag.
stop_hook_active=$(printf '%s' "$HOOK_INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || printf 'false')
if [[ "$stop_hook_active" == "true" ]]; then
    echo "c-thru autonomous gate: Stop hook re-entry observed" >&2
fi

CHECK_FAILURES=""
record_failure() {
    local label="$1" output="$2"
    CHECK_FAILURES="${CHECK_FAILURES}${label} failed:
${output}
"
}

# Each check is existence-guarded so this hook can run against small fixtures
# and against partial checkouts. Use conditional commands to preserve errexit
# everywhere else while retaining each check's diagnostic output on failure.
if [[ -f "$ROOT/tools/c-thru" ]]; then
    if output=$(bash -n "$ROOT/tools/c-thru" 2>&1); then
        :
    else
        record_failure "bash -n tools/c-thru" "$output"
    fi
fi

if [[ -f "$ROOT/tools/claude-proxy" ]]; then
    if output=$(node --check "$ROOT/tools/claude-proxy" 2>&1); then
        :
    else
        record_failure "node --check tools/claude-proxy" "$output"
    fi
fi

for model_map in "$ROOT"/tools/model-map-*.js; do
    [[ -f "$model_map" ]] || continue
    if output=$(node --check "$model_map" 2>&1); then
        :
    else
        record_failure "node --check ${model_map#$ROOT/}" "$output"
    fi
done

if [[ -f "$ROOT/tools/model-map-validate.js" ]] && [[ -f "$ROOT/config/model-map.json" ]]; then
    if output=$(node "$ROOT/tools/model-map-validate.js" "$ROOT/config/model-map.json" 2>&1); then
        :
    else
        record_failure "model-map validation" "$output"
    fi
fi

if [[ -n "$CHECK_FAILURES" ]]; then
    new_blocks=$((blocks + 1))
    TEMP_FILE="${SENTINEL}.tmp.$$"
    if ! jq --argjson blocks "$new_blocks" '.blocks = $blocks' "$SENTINEL" > "$TEMP_FILE"; then
        rm -f "$TEMP_FILE" || true
        echo "c-thru autonomous gate: could not update sentinel; allowing stop" >&2
        exit 0
    fi
    if ! mv "$TEMP_FILE" "$SENTINEL"; then
        rm -f "$TEMP_FILE" || true
        echo "c-thru autonomous gate: could not replace sentinel; allowing stop" >&2
        exit 0
    fi

    reason="c-thru autonomous gate found repository integrity failures. Fix them before stopping:
${CHECK_FAILURES}"
    reason="${reason:0:4000}"
    system_message="⛔ c-thru autonomous gate: integrity check failed (block ${new_blocks}/${max_blocks})"
    jq -n \
        --arg reason "$reason" \
        --arg system_message "$system_message" \
        '{decision: "block", reason: $reason, systemMessage: $system_message}'
fi

# Passing checks retain the sentinel for the autonomous run's own cleanup.
exit 0
