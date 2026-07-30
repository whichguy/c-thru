#!/usr/bin/env bash
# Hermetic Shape C bootstrap + stamp tests (uses local REPO_DIR; no network).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-shape-c.XXXXXX")"
export CLAUDE_DIR="$BASE/claude"
export CLAUDE_PROFILE_DIR="$CLAUDE_DIR"
mkdir -p "$CLAUDE_DIR"

pass=0
fail=0
check() {
  local name="$1"
  shift
  if "$@"; then
    pass=$((pass + 1))
  else
    echo "FAIL: $name"
    fail=$((fail + 1))
  fi
}

# shellcheck source=../tools/c-thru-install-core.sh
. "$REPO_ROOT/tools/c-thru-install-core.sh"

export REPO_DIR="$REPO_ROOT"

check "empty dir incomplete" bash -c '! cthru_repo_is_complete "'"$BASE"'/empty"'
check "monorepo complete" cthru_repo_is_complete "$REPO_DIR"
check "install from repo" cthru_install_from_repo
check "c-thru linked" test -e "$CLAUDE_DIR/tools/c-thru"
check "cthru linked" test -e "$CLAUDE_DIR/tools/cthru"
check "stamp exists" test -f "$(cthru_stamp_path)"
check "stamp healthy" cthru_stamp_is_healthy
check "source_root field" test "$(cthru_read_stamp_field source_root)" = "$REPO_DIR"

bash "$REPO_ROOT/tools/c-thru-plugin-bootstrap.sh" 2>/dev/null || true
check "stamp still healthy after bootstrap noop" cthru_stamp_is_healthy

check "session-start has Shape C" grep -q '_cthru_cli_ready' "$REPO_ROOT/tools/c-thru-session-start.sh"
check "session-start lite opt-in" grep -q 'C_THRU_PLUGIN_LITE' "$REPO_ROOT/tools/c-thru-session-start.sh"

rm -rf "$BASE"
echo "shape-c-bootstrap: $pass ok, $fail failed"
[[ "$fail" -eq 0 ]]
