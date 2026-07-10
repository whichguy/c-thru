#!/usr/bin/env bash
# Pin tools/c-thru's bash/jq model_routes resolver against the shared JS resolver.
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
    "direct-model": "cloud_ep",
    "plain-string-model": "local_ep",
    "alias-model": { "endpoint": "cloud_ep", "name": "alias-served" },
    "mode-model": { "best-cloud": "cloud_ep", "best-local-oss": "local_ep", "connected": "cloud_ep" },
    "sigil-model": "sigil-served@local_ep",
    "nested-a": "nested-b@missing_ep",
    "nested-b@missing_ep": { "endpoint": "cloud_ep", "name": "nested-served" },
    "cycle-a": "cycle-b",
    "cycle-b": "cycle-a",
    "re:^regex-model-[0-9]+$": "local_ep"
  }
}
EOF

ROUTE_FUNCTIONS="$TMPDIR_TEST/c-thru-route-functions.sh"
awk '
  index($0, "looks_like_model_pattern_key()") == 1 { emit = 1 }
  index($0, "resolve_target_backend_for_model()") == 1 { exit }
  emit { print }
' "$TOOLS_DIR/c-thru" > "$ROUTE_FUNCTIONS"

# Source only the resolver helper functions from tools/c-thru. The full script
# has launch side effects and bootstrap path assumptions; this range is the
# bash/jq oracle under test.
# shellcheck source=/dev/null
source "$ROUTE_FUNCTIONS"
CONFIG="$FIXTURE_CONFIG"

bash_resolve() {
  local model="$1" mode="$2"
  local route_json resolved

  route_json="$(jq -c --arg m "$model" '
    if (.model_routes // {}) | has($m) then .model_routes[$m] else empty end
  ' "$CONFIG" 2>/dev/null || true)"
  if [[ -z "$route_json" ]]; then
    route_json="$(lookup_model_pattern_json_value "model_routes" "$model" 2>/dev/null || true)"
  fi
  [[ -n "$route_json" ]] || return 0

  resolved="$(resolve_model_route_json_value "$model" "$route_json" "$mode" 2>/dev/null || true)"
  printf '%s' "$resolved"
}

js_resolve() {
  local model="$1" mode="$2"
  node -e '
    const fs = require("fs");
    const { resolveModelRoute } = require(process.argv[1]);
    const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const result = resolveModelRoute(process.argv[3], {
      routes: config.model_routes || {},
      endpoints: config.endpoints || config.backends || {},
      mode: process.argv[4],
    });
    if (result) process.stdout.write(`${result.endpointId}\t${result.servedBy}`);
  ' "$TOOLS_DIR/model-map-resolve.js" "$CONFIG" "$model" "$mode"
}

check_case() {
  local label="$1" model="$2" mode="$3"
  local bash_out js_out

  bash_out="$(bash_resolve "$model" "$mode")"
  js_out="$(js_resolve "$model" "$mode")"
  if [[ "$bash_out" == "$js_out" ]]; then
    pass "$label -> ${bash_out:-unresolved}"
  else
    fail "$label (bash='${bash_out:-unresolved}', js='${js_out:-unresolved}')"
  fi
}

echo "model-route parity tests"
echo ""

check_case "direct string-key route match" "direct-model" "best-cloud"
check_case "re: prefixed regex-key route match" "regex-model-123" "best-cloud"
check_case "plain string target" "plain-string-model" "best-cloud"
check_case "{endpoint,name} alias object target" "alias-model" "best-cloud"
check_case "mode-conditional target best-cloud" "mode-model" "best-cloud"
check_case "mode-conditional target best-local-oss" "mode-model" "best-local-oss"
check_case "model@backend sigil target" "sigil-model" "best-cloud"
check_case "nested route-name chain, 2 hops" "nested-a" "best-cloud"
check_case "depth-guard cycle is unresolved" "cycle-a" "best-cloud"

echo ""
echo "Summary: $PASS passed, $FAIL failed"
exit "$FAIL"
