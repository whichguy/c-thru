#!/usr/bin/env bash
# Golden contract for the launcher's thin model_routes adapter.
#
# Three surfaces must agree on output:
#   1. tools/c-thru:resolve_model_route_value (legacy shell contract)
#   2. tools/c-thru-resolve --model-route-target (process boundary)
#   3. tools/model-map-resolve.js:resolveRouteTarget (domain implementation)
#
# Bash retains its legacy exact/Bash-ERE/glob selection policy. The extracted
# target then crosses the adapter into the shared route-graph implementation.
# Exit 2 means a selected target could not reach an endpoint; the shell maps it
# to historical empty success so Claude/Ollama autodetection can continue.
#
# Run: bash test/model-route-parity.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOLS_DIR="$REPO_DIR/tools"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1" >&2; FAIL=$((FAIL + 1)); }

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

FIXTURE_CONFIG="$TMPDIR_TEST/model-map.json"
cat > "$FIXTURE_CONFIG" <<'EOF'
{
  "endpoints": {
    "cloud_ep": { "format": "anthropic", "url": "https://api.anthropic.com" },
    "local_ep": { "format": "anthropic", "url": "http://127.0.0.1:11434", "auth": "none" }
  },
  "model_routes": {
    "re:(": "cloud_ep",
    "re:^regex-priority-": "local_ep",
    "re:^regex-priority-[0-9]+$": "cloud_ep",
    "re:^direct-model$": "local_ep",
    "re:^posix-model-[[:digit:]]$": "cloud_ep",
    "legacy-*-model": "local_ep",
    "legacy-?-model": "local_ep",
    "bracket-model-[0-9]": "cloud_ep",
    "negated-model-[!0-3]": "local_ep",
    "literal-close-[]]": "cloud_ep",
    "glob-posix-[[:digit:]]": "local_ep",
    "direct-model": "cloud_ep",
    "alias-model": { "endpoint": "cloud_ep", "name": "alias-served" },
    "mode-model": { "best-cloud": "cloud_ep", "best-local-oss": "local_ep", "connected": "cloud_ep" },
    "mode-connected": { "connected": "cloud_ep", "default": "local_ep" },
    "mode-default": { "default": "local_ep" },
    "mode-first": { "best-local-gov": "local_ep", "best-cloud-gov": "cloud_ep" },
    "sigil-model": "sigil-served@local_ep",
    "nested-a": "nested-b@missing_ep",
    "nested-b@missing_ep": { "endpoint": "cloud_ep", "name": "nested-served" },
    "nested-posix": "nested-posix-7",
    "re:^nested-posix-[[:digit:]]$": "cloud_ep",
    "missing-endpoint": "not_defined",
    "cycle-a": "cycle-b",
    "cycle-b": "cycle-a",
    "depth-0": "depth-1",
    "depth-1": "depth-2",
    "depth-2": "depth-3",
    "depth-3": "depth-4",
    "depth-4": "depth-5",
    "depth-5": "depth-6",
    "depth-6": "depth-7",
    "depth-7": "depth-8",
    "depth-8": "depth-9",
    "depth-9": "cloud_ep"
  }
}
EOF

ROUTE_FUNCTIONS="$TMPDIR_TEST/c-thru-route-functions.sh"
awk '
  index($0, "looks_like_model_pattern_key()") == 1 { emit = 1 }
  index($0, "resolve_target_backend_for_model()") == 1 { exit }
  emit { print }
' "$TOOLS_DIR/c-thru" > "$ROUTE_FUNCTIONS"

# Source only the launcher's model-route helper region. The full entrypoint has
# launch side effects and bootstrap path assumptions.
# shellcheck source=/dev/null
source "$ROUTE_FUNCTIONS"
CONFIG="$FIXTURE_CONFIG"
CTHRU_SELF_DIR="$TOOLS_DIR"

shell_resolve() {
  resolve_model_route_value "$1" "$2"
}

cli_resolve() {
  local route_json
  route_json="$(select_route_json "$1")"
  [[ -n "$route_json" ]] || return 2
  CLAUDE_MODEL_MAP_PATH="$FIXTURE_CONFIG" \
    "$TOOLS_DIR/c-thru-resolve" --model-route-target "$1" "$2" "$route_json"
}

js_resolve() {
  local route_json
  route_json="$(select_route_json "$1")"
  [[ -n "$route_json" ]] || return 2
  node -e '
    const fs = require("fs");
    const { spawnSync } = require("child_process");
    const { resolveRouteTarget } = require(process.argv[1]);
    const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const regexTest = (pattern, value) =>
      spawnSync("jq", [
        "-n", "-e", "--arg", "value", value, "--arg", "pattern", pattern,
        "try ($value | test($pattern)) catch false",
      ]).status === 0;
    const result = resolveRouteTarget(JSON.parse(process.argv[5]), process.argv[3], {
      routes: config.model_routes || {},
      endpoints: config.endpoints || config.backends || {},
      mode: process.argv[4],
      maxDepth: 9,
      matchOptions: { regexTest },
    });
    if (!result) process.exit(2);
    process.stdout.write(`${result.endpointId}\t${result.servedBy}`);
  ' "$TOOLS_DIR/model-map-resolve.js" "$FIXTURE_CONFIG" "$1" "$2" "$route_json"
}

select_route_json() {
  local selected
  selected="$(jq -r --arg model "$1" '
    (.model_routes // {}) |
    if has($model) then .[$model] | @json else empty end
  ' "$FIXTURE_CONFIG")"
  [[ -n "$selected" ]] || selected="$(
    lookup_model_pattern_value "model_routes" "$1" 1
  )"
  printf '%s' "$selected"
}

check_case() {
  local label="$1" model="$2" mode="$3" expected="$4" expected_cli_status="$5"
  local shell_out shell_status shell_err
  local cli_out cli_status cli_err
  local js_out js_status js_err

  shell_err="$TMPDIR_TEST/shell.err"
  cli_err="$TMPDIR_TEST/cli.err"
  js_err="$TMPDIR_TEST/js.err"
  : > "$shell_err"
  : > "$cli_err"
  : > "$js_err"

  shell_out="$(shell_resolve "$model" "$mode" 2>"$shell_err")"
  shell_status=$?
  cli_out="$(cli_resolve "$model" "$mode" 2>"$cli_err")"
  cli_status=$?
  js_out="$(js_resolve "$model" "$mode" 2>"$js_err")"
  js_status=$?

  if [[ "$shell_status" -eq 0 && "$shell_out" == "$expected" && ! -s "$shell_err" ]] &&
     [[ "$cli_status" -eq "$expected_cli_status" && "$cli_out" == "$expected" && ! -s "$cli_err" ]] &&
     [[ "$js_status" -eq "$expected_cli_status" && "$js_out" == "$expected" && ! -s "$js_err" ]]; then
    pass "$label -> ${expected:-unresolved}"
    return
  fi

  fail "$label"
  echo "        shell: status=$shell_status out='${shell_out:-}' err='$(<"$shell_err")'" >&2
  echo "        cli:   status=$cli_status out='${cli_out:-}' err='$(<"$cli_err")'" >&2
  echo "        js:    status=$js_status out='${js_out:-}' err='$(<"$js_err")'" >&2
  echo "        want:  shell_status=0 cli/js_status=$expected_cli_status out='${expected:-}' stderr=<empty>" >&2
}

echo "model-route shared adapter contract"
echo ""

check_case "exact key beats an earlier matching regex" \
  "direct-model" "best-cloud" $'cloud_ep\tdirect-model' 0
check_case "first matching regex retains insertion order" \
  "regex-priority-123" "best-cloud" $'local_ep\tregex-priority-123' 0
check_case "malformed regex is ignored before later matches" \
  "regex-priority-456" "best-cloud" $'local_ep\tregex-priority-456' 0
check_case "legacy Bash POSIX-class regex remains supported" \
  "posix-model-7" "best-cloud" $'cloud_ep\tposix-model-7' 0
check_case "legacy star-glob route remains supported" \
  "legacy-any-model" "best-cloud" $'local_ep\tlegacy-any-model' 0
check_case "legacy question-glob route remains supported" \
  "legacy-x-model" "best-cloud" $'local_ep\tlegacy-x-model' 0
check_case "legacy bracket-glob route remains supported" \
  "bracket-model-7" "best-cloud" $'cloud_ep\tbracket-model-7' 0
check_case "legacy negated bracket-glob remains supported" \
  "negated-model-8" "best-cloud" $'local_ep\tnegated-model-8' 0
check_case "legacy literal-close bracket-glob remains supported" \
  "literal-close-]" "best-cloud" $'cloud_ep\tliteral-close-]' 0
check_case "legacy POSIX-class glob remains supported" \
  "glob-posix-7" "best-cloud" $'local_ep\tglob-posix-7' 0
check_case "{endpoint,name} alias object" \
  "alias-model" "best-cloud" $'cloud_ep\talias-served' 0
check_case "mode-specific exact selection" \
  "mode-model" "best-local-oss" $'local_ep\tmode-model' 0
check_case "mode selection falls back to connected" \
  "mode-connected" "unlisted-mode" $'cloud_ep\tmode-connected' 0
check_case "mode selection falls back to default" \
  "mode-default" "unlisted-mode" $'local_ep\tmode-default' 0
check_case "mode selection finally uses first value" \
  "mode-first" "unlisted-mode" $'local_ep\tmode-first' 0
check_case "model@backend sigil target" \
  "sigil-model" "best-cloud" $'local_ep\tsigil-served' 0
check_case "nested route-name chain" \
  "nested-a" "best-cloud" $'cloud_ep\tnested-served' 0
check_case "nested jq POSIX-class regex dialect remains supported" \
  "nested-posix" "best-cloud" $'cloud_ep\tnested-posix-7' 0
check_case "seven nested hops remain valid" \
  "depth-2" "best-cloud" $'cloud_ep\tdepth-9' 0
check_case "legacy eight-hop launcher boundary remains valid" \
  "depth-1" "best-cloud" $'cloud_ep\tdepth-9' 0
check_case "nine nested hops are rejected" \
  "depth-0" "best-cloud" "" 2
check_case "cycle is unresolved without diagnostics" \
  "cycle-a" "best-cloud" "" 2
check_case "missing endpoint is unresolved" \
  "missing-endpoint" "best-cloud" "" 2
check_case "unknown route is unresolved" \
  "unknown-model" "best-cloud" "" 2

echo ""
echo "CLI error identity"

invalid_usage_err="$TMPDIR_TEST/invalid-usage.err"
invalid_usage_out="$(CLAUDE_MODEL_MAP_PATH="$FIXTURE_CONFIG" \
  "$TOOLS_DIR/c-thru-resolve" --model-route-target 2>"$invalid_usage_err")"
invalid_usage_status=$?
if [[ "$invalid_usage_status" -eq 1 && -z "$invalid_usage_out" ]] &&
   grep -q "usage: c-thru-resolve --model-route-target" "$invalid_usage_err"; then
  pass "missing model is a usage error (exit 1 + diagnostic)"
else
  fail "missing model error identity (status=$invalid_usage_status out='$invalid_usage_out' err='$(<"$invalid_usage_err")')"
fi

BROKEN_CONFIG="$TMPDIR_TEST/broken-model-map.json"
printf '{not-json\n' > "$BROKEN_CONFIG"
broken_err="$TMPDIR_TEST/broken.err"
broken_out="$(CLAUDE_MODEL_MAP_PATH="$BROKEN_CONFIG" \
  "$TOOLS_DIR/c-thru-resolve" --model-route-target direct-model best-cloud '"cloud_ep"' 2>"$broken_err")"
broken_status=$?
if [[ "$broken_status" -eq 1 && -z "$broken_out" ]] &&
   grep -q "cannot load active model-map" "$broken_err"; then
  pass "malformed config is an operational error (exit 1 + diagnostic)"
else
  fail "malformed config error identity (status=$broken_status out='$broken_out' err='$(<"$broken_err")')"
fi

missing_err="$TMPDIR_TEST/missing.err"
missing_out="$(
  CTHRU_SELF_DIR="$TMPDIR_TEST/no-tools" \
    resolve_model_route_value direct-model best-cloud 2>"$missing_err"
)"
missing_status=$?
if [[ "$missing_status" -eq 1 && -z "$missing_out" ]] &&
   grep -q "model-route resolver missing or not executable" "$missing_err"; then
  pass "missing adapter is an operational error (exit 1 + diagnostic)"
else
  fail "missing adapter error identity (status=$missing_status out='$missing_out' err='$(<"$missing_err")')"
fi

echo ""
echo "Summary: $PASS passed, $FAIL failed"
exit "$FAIL"
