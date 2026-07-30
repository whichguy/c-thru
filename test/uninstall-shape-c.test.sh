#!/usr/bin/env bash
# Shape C uninstall: stamp, c-thru-src links, --purge-src.
# Hermetic. Run: bash test/uninstall-shape-c.test.sh
set -uo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=test/helpers.sh
source "$REPO_DIR/test/helpers.sh"

REAL_TMP=$(mktemp -d)
trap 'rm -rf "$REAL_TMP"' EXIT
export CLAUDE_PROFILE_DIR="$REAL_TMP/claude"
export CLAUDE_DIR="$CLAUDE_PROFILE_DIR"
mkdir -p "$CLAUDE_DIR/tools" "$CLAUDE_DIR/c-thru-src/tools"

# Minimal fake source tree + managed links
printf '#!/bin/sh\n' >"$CLAUDE_DIR/c-thru-src/tools/c-thru"
chmod +x "$CLAUDE_DIR/c-thru-src/tools/c-thru"
ln -sfn "$CLAUDE_DIR/c-thru-src/tools/c-thru" "$CLAUDE_DIR/tools/c-thru"
ln -sfn "$CLAUDE_DIR/c-thru-src/tools/c-thru" "$CLAUDE_DIR/tools/cthru"
# Unrelated link must survive
printf '#!/bin/sh\n' >"$REAL_TMP/other.sh"
ln -sfn "$REAL_TMP/other.sh" "$CLAUDE_DIR/tools/unrelated-tool"

cat >"$CLAUDE_DIR/.c-thru-cli-installed" <<EOF
version=0.0.0
source_root=$CLAUDE_DIR/c-thru-src
source_ref=main
source_sha=deadbeef
installed_at=now
EOF
printf '{}' >"$CLAUDE_DIR/c-thru-bootstrap.log"
printf '{}' >"$CLAUDE_DIR/.c-thru-plugin-setup-pending"

echo "=== Uninstall without --purge-src ==="
bash "$REPO_DIR/uninstall.sh" --yes 2>/dev/null || true

check "stamp removed" "yes" "$([ ! -e "$CLAUDE_DIR/.c-thru-cli-installed" ] && echo yes || echo no)"
check "bootstrap log removed" "yes" "$([ ! -e "$CLAUDE_DIR/c-thru-bootstrap.log" ] && echo yes || echo no)"
check "c-thru tools link removed" "yes" "$([ ! -e "$CLAUDE_DIR/tools/c-thru" ] && echo yes || echo no)"
check "cthru tools link removed" "yes" "$([ ! -e "$CLAUDE_DIR/tools/cthru" ] && echo yes || echo no)"
check "unrelated link preserved" "yes" "$([ -L "$CLAUDE_DIR/tools/unrelated-tool" ] && echo yes || echo no)"
check "c-thru-src preserved without purge" "yes" "$([ -d "$CLAUDE_DIR/c-thru-src" ] && echo yes || echo no)"

# Re-seed for purge-src
mkdir -p "$CLAUDE_DIR/c-thru-src/tools"
printf '#!/bin/sh\n' >"$CLAUDE_DIR/c-thru-src/tools/c-thru"
echo "version=0" >"$CLAUDE_DIR/.c-thru-cli-installed"

echo "=== Uninstall --purge-src ==="
bash "$REPO_DIR/uninstall.sh" --yes --purge-src 2>/dev/null || true
check "c-thru-src removed with purge" "yes" "$([ ! -e "$CLAUDE_DIR/c-thru-src" ] && echo yes || echo no)"
check "stamp removed after purge run" "yes" "$([ ! -e "$CLAUDE_DIR/.c-thru-cli-installed" ] && echo yes || echo no)"

echo ""
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
