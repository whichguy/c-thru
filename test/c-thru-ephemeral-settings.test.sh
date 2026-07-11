#!/usr/bin/env bash
# Regression tests for write_ephemeral_settings in tools/c-thru.
# Run: bash test/c-thru-ephemeral-settings.test.sh

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CTHRU="$SCRIPT_DIR/../tools/c-thru"
[[ -f "$CTHRU" ]] || { echo "fatal: cannot find $CTHRU" >&2; exit 1; }

# The builder only needs these fixture globals and its nested find_tool_path.
# Extracting it avoids starting a proxy or reading the invoking user's profile.
eval "$(awk '/^write_ephemeral_settings\(\) \{/,/^\}$/' "$CTHRU")"

PASS=0
FAIL=0
FIXTURE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/c-thru-ephemeral-settings.XXXXXX")
PROFILE_DIR="$FIXTURE_DIR/profile"
SESSION_DIR="$FIXTURE_DIR/session"
TOOLS_DIR="$SCRIPT_DIR/../tools"
mkdir -p "$PROFILE_DIR" "$SESSION_DIR"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

assert() {
  local label="$1"
  shift
  if "$@"; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label" >&2
    FAIL=$((FAIL + 1))
  fi
}

run_builder() {
  EPHEMERAL_SESSION_DIR="$SESSION_DIR"
  ORIGINAL_CLAUDE_PROFILE_DIR="$PROFILE_DIR"
  CTHRU_SELF_DIR="$TOOLS_DIR"
  EPHEMERAL_SETTINGS_JSON=""
  write_ephemeral_settings
  BUILT_JSON="$EPHEMERAL_SETTINGS_JSON"
}

assert_json_case() {
  local case_name="$1" json="$2"
  node - "$case_name" "$json" <<'NODE'
const [caseName, json] = process.argv.slice(2);
const settings = JSON.parse(json);
const fail = message => { console.error(message); process.exit(1); };
const hasInjectedCore = () =>
  settings.mcpServers?.['llm-capabilities'] &&
  Array.isArray(settings.hooks?.SessionStart) && settings.hooks.SessionStart.length > 0 &&
  Array.isArray(settings.permissions?.allow) &&
  settings.permissions.allow.includes('mcp__llm-capabilities__*');

if (caseName === 'preferences') {
  if (settings.showClearContextOnPlanAccept !== true) fail('showClearContextOnPlanAccept was not passed through');
  if (settings.tui !== 'fullscreen') fail('tui was not passed through');
  if ('model' in settings) fail('user model was not denied');
  if ('env' in settings) fail('user env was not denied');
  if (JSON.stringify(settings.hooks).includes('user-settings-hook')) fail('user hooks were not replaced');
  if (!hasInjectedCore()) fail('c-thru injected core settings are missing');
} else if (caseName === 'missing') {
  const keys = Object.keys(settings).sort().join(',');
  if (keys !== 'hooks,mcpServers,permissions') fail(`missing-file baseline leaked keys: ${keys}`);
  if (!hasInjectedCore()) fail('c-thru injected core settings are missing');
} else if (caseName === 'corrupt') {
  if (!hasInjectedCore()) fail('c-thru injected core settings are missing after corrupt user settings');
} else {
  fail(`unknown case ${caseName}`);
}
NODE
}

echo "1. Preferences pass through while routing/auth/hook keys are denied"
printf '%s\n' '{"showClearContextOnPlanAccept":true,"tui":"fullscreen","model":"x","env":{"A":"B"},"hooks":{"SessionStart":[{"hooks":[{"command":"user-settings-hook"}]}]}}' > "$PROFILE_DIR/settings.json"
run_builder
BUILDER_STATUS=$?
assert "preference settings builder exits 0" test "$BUILDER_STATUS" -eq 0
assert "preference passthrough and denylist behavior" assert_json_case preferences "$BUILT_JSON"

echo
echo "2. Missing settings.json retains the c-thru-only baseline"
rm -f "$PROFILE_DIR/settings.json"
run_builder
BUILDER_STATUS=$?
assert "missing settings builder exits 0" test "$BUILDER_STATUS" -eq 0
assert "missing settings file succeeds with the prior baseline shape" assert_json_case missing "$BUILT_JSON"

echo
echo "3. Corrupt settings.json warns but does not block launch"
printf '%s\n' '{oops' > "$PROFILE_DIR/settings.json"
WARN_FILE="$FIXTURE_DIR/corrupt-warning"
run_builder 2>"$WARN_FILE"
BUILDER_STATUS=$?
assert "corrupt settings builder exits 0" test "$BUILDER_STATUS" -eq 0
assert "corrupt settings file still produces c-thru settings" assert_json_case corrupt "$BUILT_JSON"
assert "corrupt settings file emits the expected warning" grep -q '^c-thru: ignoring unparseable user settings.json:' "$WARN_FILE"

echo
echo "============================================="
echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
