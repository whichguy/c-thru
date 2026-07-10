#!/usr/bin/env bash
# Smoke tests for c-thru-map-changed.sh validation output and lineage warning.
#
# Run: bash test/c-thru-map-changed-hook.test.sh

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=test/helpers.sh
source "$REPO_DIR/test/helpers.sh"

HOOK="$REPO_DIR/tools/c-thru-map-changed.sh"
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

RUN_STDOUT=""
RUN_STATUS=0

run_hook() {
    local payload="$1"
    local path_prefix="${2:-}"
    if [ -n "$path_prefix" ]; then
        RUN_STDOUT=$(printf '%s' "$payload" | PATH="$path_prefix:$PATH" bash "$HOOK" 2>/dev/null)
    else
        RUN_STDOUT=$(printf '%s' "$payload" | bash "$HOOK" 2>/dev/null)
    fi
    RUN_STATUS=$?
}

json_valid_object() {
    node -e "
        let d = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', c => d += c);
        process.stdin.on('end', () => {
            if (d.length === 0) process.exit(1);
            try {
                const parsed = JSON.parse(d);
                process.exit(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? 0 : 1);
            } catch (_) {
                process.exit(1);
            }
        });
    " >/dev/null 2>&1 <<< "$1"
}

additional_context() {
    node -e "
        let d = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', c => d += c);
        process.stdin.on('end', () => {
            try {
                const parsed = JSON.parse(d);
                process.stdout.write(String(parsed.hookSpecificOutput?.additionalContext || ''));
            } catch (_) {}
        });
    " 2>/dev/null <<< "$1"
}

warn_present() {
    case "$1" in
        *"WARN: model-map lineage"*) printf 'yes' ;;
        *) printf 'no' ;;
    esac
}

# ---------------------------------------------------------------------------
# Fixture 1: Real repo config — valid JSON output, no lineage drift warning.
# ---------------------------------------------------------------------------
echo "Fixture 1: repo config model-map.json..."
run_hook "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$REPO_DIR/config/model-map.json\"}}"
check "Repo config hook exits 0" "0" "$RUN_STATUS"
json_valid_object "$RUN_STDOUT"; check "Repo config stdout is one valid JSON object" "0" "$?"
check "Repo config has no lineage warning" "no" "$(warn_present "$(additional_context "$RUN_STDOUT")")"

# ---------------------------------------------------------------------------
# Fixture 2: Different file literally named model-map.json — no lineage warning.
# ---------------------------------------------------------------------------
echo "Fixture 2: non-repo model-map.json..."
OTHER_DIR="$TMPDIR_ROOT/other"
mkdir -p "$OTHER_DIR"
cp "$REPO_DIR/config/model-map.json" "$OTHER_DIR/model-map.json"
run_hook "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$OTHER_DIR/model-map.json\"}}"
check "Non-repo model-map hook exits 0" "0" "$RUN_STATUS"
json_valid_object "$RUN_STDOUT"; check "Non-repo model-map stdout is one valid JSON object" "0" "$?"
check "Non-repo model-map has no lineage warning" "no" "$(warn_present "$(additional_context "$RUN_STDOUT")")"

# ---------------------------------------------------------------------------
# Fixture 3: Non-model-map file — existing silent early exit.
# ---------------------------------------------------------------------------
echo "Fixture 3: unrelated JSON file..."
run_hook '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/whatever.json"}}'
check "Unrelated JSON hook exits 0" "0" "$RUN_STATUS"
check "Unrelated JSON produces no stdout" "0" "$(printf '%s' "$RUN_STDOUT" | wc -c | tr -d ' ')"

# ---------------------------------------------------------------------------
# Fixture 4: Simulated lineage drift — warning appended, still JSON and exit 0.
# ---------------------------------------------------------------------------
echo "Fixture 4: simulated lineage drift..."
REAL_NODE=$(command -v node)
SHIM_DIR="$TMPDIR_ROOT/node-shim"
mkdir -p "$SHIM_DIR"
sed "s#__REAL_NODE__#$REAL_NODE#g" > "$SHIM_DIR/node" <<'SHIMEOF'
#!/usr/bin/env bash
case " $* " in
    *model-map-lineage.test.js*) exit 1 ;;
    *) exec "__REAL_NODE__" "$@" ;;
esac
SHIMEOF
chmod +x "$SHIM_DIR/node"

run_hook "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$REPO_DIR/config/model-map.json\"}}" "$SHIM_DIR"
check "Drift simulation hook exits 0" "0" "$RUN_STATUS"
json_valid_object "$RUN_STDOUT"; check "Drift simulation stdout is one valid JSON object" "0" "$?"
check "Drift simulation includes lineage warning" "yes" "$(warn_present "$(additional_context "$RUN_STDOUT")")"

# ---------------------------------------------------------------------------
echo ""
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
exit "$FAIL"
