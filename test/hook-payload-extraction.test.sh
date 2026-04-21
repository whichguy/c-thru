#!/usr/bin/env bash
# Regression tests for c-thru-map-changed.sh payload extraction.
# Regression for session bug #1: PostToolUse wraps file_path under tool_input.
#
# Run: bash test/hook-payload-extraction.test.sh

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=test/helpers.sh
source "$REPO_DIR/test/helpers.sh"

# ---------------------------------------------------------------------------
# Setup: copy the hook into a tmpdir alongside a stub validator.
# The hook resolves validator via: script_dir/model-map-validate.js
# ---------------------------------------------------------------------------
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

HOOK_COPY="$WORK/c-thru-map-changed.sh"
STUB_VALIDATOR="$WORK/model-map-validate.js"
RECORDER="$WORK/recorder.txt"

cp "$REPO_DIR/tools/c-thru-map-changed.sh" "$HOOK_COPY"
chmod +x "$HOOK_COPY"

# Stub validator: writes its first argument to the recorder file, exits 0.
cat > "$STUB_VALIDATOR" <<'EOF'
#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.argv[2] || '', (process.argv[1] || '') + '\n');
process.exit(0);
EOF

# Stub validator: reads VALIDATOR_RECORDER from env, appends file_path (argv[2]) to it.
# hook calls: node "$validator" "$file_path" → argv = [node, script, file_path]
cat > "$STUB_VALIDATOR" <<'STUBEOF'
#!/usr/bin/env node
const fs = require('fs');
const rec = process.env.VALIDATOR_RECORDER;
const fp  = process.argv[2];
if (rec && fp !== undefined) fs.appendFileSync(rec, fp + '\n');
process.exit(0);
STUBEOF

# ---------------------------------------------------------------------------
# Helper: run hook with a given stdin payload; return validator-recorded path.
run_hook() {
    local payload="$1"
    rm -f "$RECORDER"
    export VALIDATOR_RECORDER="$RECORDER"
    printf '%s' "$payload" | bash "$HOOK_COPY" 2>/dev/null || true
}

# Same helper but with jq removed from PATH (tests node fallback path)
run_hook_nojq() {
    local payload="$1"
    local nojq_path
    nojq_path=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v 'jq' | tr '\n' ':')
    rm -f "$RECORDER"
    export VALIDATOR_RECORDER="$RECORDER"
    printf '%s' "$payload" | PATH="$nojq_path" bash "$HOOK_COPY" 2>/dev/null || true
}

recorded_path() {
    [ -f "$RECORDER" ] && cat "$RECORDER" | head -1 || echo ""
}

# ---------------------------------------------------------------------------
# Fixture 1: PostToolUse wrapper — tool_input.file_path (regression for bug #1)
# ---------------------------------------------------------------------------
echo "Fixture 1 (jq): PostToolUse tool_input wrapper..."
run_hook '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/model-map.json"}}'
check "PostToolUse tool_input.file_path extracted (jq)" "/tmp/model-map.json" "$(recorded_path)"

echo "Fixture 1 (node): PostToolUse tool_input wrapper..."
run_hook_nojq '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/model-map.json"}}'
check "PostToolUse tool_input.file_path extracted (node)" "/tmp/model-map.json" "$(recorded_path)"

# ---------------------------------------------------------------------------
# Fixture 2: Flat / legacy payload shape
# ---------------------------------------------------------------------------
echo "Fixture 2 (jq): flat file_path..."
run_hook '{"file_path":"/tmp/model-map.json"}'
check "Flat file_path extracted (jq)" "/tmp/model-map.json" "$(recorded_path)"

echo "Fixture 2 (node): flat file_path..."
run_hook_nojq '{"file_path":"/tmp/model-map.json"}'
check "Flat file_path extracted (node)" "/tmp/model-map.json" "$(recorded_path)"

# ---------------------------------------------------------------------------
# Fixture 3: model-map.overrides.json — validator NOT invoked
# (case pattern *model-map.json does not match overrides.json)
# ---------------------------------------------------------------------------
echo "Fixture 3: overrides file — validator NOT invoked..."
run_hook '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/model-map.overrides.json"}}'
check "Overrides file skipped" "" "$(recorded_path)"

# ---------------------------------------------------------------------------
# Fixture 4: Unrelated file — validator NOT invoked
# ---------------------------------------------------------------------------
echo "Fixture 4: unrelated file — validator NOT invoked..."
run_hook '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/other.txt"}}'
check "Unrelated file skipped" "" "$(recorded_path)"

# ---------------------------------------------------------------------------
# Fixture 5: Bash tool — validator NOT invoked
# ---------------------------------------------------------------------------
echo "Fixture 5: Bash tool payload — validator NOT invoked..."
run_hook '{"tool_name":"Bash","tool_input":{"command":"ls"}}'
check "Bash tool skipped" "" "$(recorded_path)"

# ---------------------------------------------------------------------------
# Fixture 6: Empty JSON — validator NOT invoked
# ---------------------------------------------------------------------------
echo "Fixture 6: empty JSON — validator NOT invoked..."
run_hook '{}'
check "Empty JSON skipped" "" "$(recorded_path)"

# ---------------------------------------------------------------------------
# Fixture 7: Malformed JSON — validator NOT invoked
# ---------------------------------------------------------------------------
echo "Fixture 7: malformed JSON — validator NOT invoked..."
run_hook 'not json at all'
check "Malformed JSON skipped" "" "$(recorded_path)"

# ---------------------------------------------------------------------------
echo ""
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
