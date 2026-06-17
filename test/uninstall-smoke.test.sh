#!/usr/bin/env bash
# Smoke test for uninstall.sh.
# Asserts uninstall.sh --yes:
#   (a) removes all c-thru repo-pointing symlinks under $profile/tools
#   (b) preserves an unrelated (non-repo) symlink
#   (c) scrubs c-thru hook entries from settings.json but keeps a user hook
#   (d) preserves model-map.overrides.json (user data)
#
# Runs under a SYMLINKED TMPDIR component so it also covers C24: REPO_DIR and
# link_targets_repo() must both canonicalize physically (pwd -P) or repo-pointing
# symlinks under a symlinked path component would never be classified for removal.
#
# Run: bash test/uninstall-smoke.test.sh

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=test/helpers.sh
source "$REPO_DIR/test/helpers.sh"

if ! command -v jq >/dev/null 2>&1; then
    echo "  SKIP  (jq not available — uninstall settings scrub requires jq)"
    echo "0 tests: 0 passed, 0 failed"
    exit 0
fi

# ---------------------------------------------------------------------------
# Sandbox: a real dir reached via a SYMLINKED path component. Both install and
# uninstall see the symlinked path; physical canonicalization is what must agree.
# ---------------------------------------------------------------------------
REAL_TMP=$(mktemp -d)
LINK_TMP=$(mktemp -u)          # path that does not exist yet
ln -s "$REAL_TMP" "$LINK_TMP"  # LINK_TMP → REAL_TMP (symlinked component)
trap 'rm -f "$LINK_TMP"; rm -rf "$REAL_TMP"' EXIT

FAKE_HOME="$LINK_TMP/home"
FAKE_CLAUDE="$FAKE_HOME/.claude"
mkdir -p "$FAKE_HOME"
export HOME="$FAKE_HOME"
export CLAUDE_PROFILE_DIR="$FAKE_CLAUDE"

echo "=== Install (into symlinked profile path) ==="
(cd "$REPO_DIR" && bash install.sh 2>/dev/null) || { echo "ABORT: install.sh non-zero"; exit 1; }

TOOLS_DEST="$FAKE_CLAUDE/tools"
SETTINGS="$FAKE_CLAUDE/settings.json"

# Sanity: install created at least one repo-pointing symlink under tools/.
repo_links_before=$(find "$TOOLS_DEST" -maxdepth 1 -type l 2>/dev/null | wc -l | tr -d ' ')
check "install created repo symlinks under tools/" "yes" "$([ "${repo_links_before:-0}" -gt 0 ] && echo yes || echo no)"

# ---------------------------------------------------------------------------
# Seed fixtures uninstall must distinguish
# ---------------------------------------------------------------------------
# (b) an unrelated symlink (points outside the repo) — must be preserved
UNRELATED_TARGET="$REAL_TMP/unrelated-tool.sh"
printf '#!/bin/sh\necho hi\n' > "$UNRELATED_TARGET"
ln -s "$UNRELATED_TARGET" "$TOOLS_DEST/unrelated-tool"

# (c) settings.json with BOTH a c-thru hook and a user hook
cat > "$SETTINGS" <<'JSON'
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "/somewhere/.claude/tools/c-thru-classify" },
          { "type": "command", "command": "/usr/local/bin/my-user-hook.sh" }
        ]
      }
    ]
  }
}
JSON

# (d) model-map.overrides.json with user data — must survive
printf '{"llm_mode":"offline","custom":"keepme"}' > "$FAKE_CLAUDE/model-map.overrides.json"

echo ""
echo "=== Uninstall (--yes) ==="
(cd "$REPO_DIR" && bash uninstall.sh --yes 2>/dev/null) || { echo "ABORT: uninstall.sh non-zero"; exit 1; }

# ---------------------------------------------------------------------------
# (a) all c-thru repo-pointing symlinks gone (covers C24 under symlinked path)
# ---------------------------------------------------------------------------
echo ""
echo "Symlink removal:"
repo_links_after=0
if [ -d "$TOOLS_DEST" ]; then
    while IFS= read -r link; do
        [ -L "$link" ] || continue
        target=$(readlink "$link" 2>/dev/null || true)
        case "$target" in
            "$REPO_DIR"/*) repo_links_after=$((repo_links_after + 1)) ;;
        esac
    done < <(find "$TOOLS_DEST" -maxdepth 1 -type l 2>/dev/null)
fi
check "all c-thru repo-pointing symlinks removed (C24)" "0" "$repo_links_after"

# ---------------------------------------------------------------------------
# (b) unrelated symlink preserved
# ---------------------------------------------------------------------------
echo "Unrelated symlink:"
check "unrelated symlink preserved" "yes" \
    "$([ -L "$TOOLS_DEST/unrelated-tool" ] && echo yes || echo no)"

# ---------------------------------------------------------------------------
# (c) c-thru hook scrubbed, user hook kept
# ---------------------------------------------------------------------------
echo "settings.json hook scrub:"
cthru_hooks=$(jq '[.hooks.UserPromptSubmit[]?.hooks[]? | select((.command // "") | test("c-thru-"))] | length' "$SETTINGS" 2>/dev/null || echo ERR)
user_hooks=$(jq '[.hooks.UserPromptSubmit[]?.hooks[]? | select((.command // "") | test("my-user-hook"))] | length' "$SETTINGS" 2>/dev/null || echo ERR)
check "c-thru hook entry scrubbed" "0" "$cthru_hooks"
check "user hook entry preserved" "1" "$user_hooks"

# ---------------------------------------------------------------------------
# (d) model-map.overrides.json preserved
# ---------------------------------------------------------------------------
echo "Overrides preservation:"
ovr_custom=$(jq -r '.custom // ""' "$FAKE_CLAUDE/model-map.overrides.json" 2>/dev/null || echo MISSING)
check "model-map.overrides.json preserved" "keepme" "$ovr_custom"

echo ""
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
