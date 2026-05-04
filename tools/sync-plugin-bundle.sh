#!/usr/bin/env bash
# tools/sync-plugin-bundle.sh — keep plugins/c-thru/ in sync with source files.
#
# Hook scripts are copied from tools/, skills from skills/.
# Run after editing source files; also gated in pre-commit (--check mode).
#
# Usage:
#   tools/sync-plugin-bundle.sh           # sync
#   tools/sync-plugin-bundle.sh --check   # exit non-zero if any copy differs
set -o pipefail
shopt -s nullglob

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$ROOT/plugins/c-thru"
mode="${1:-sync}"
drift=0

check_or_copy() {
  local src="$1" dst="$2"
  if [ "$mode" = "--check" ]; then
    if ! cmp -s "$src" "$dst" 2>/dev/null; then
      echo "DRIFT: $dst differs from $src"
      drift=1
    fi
  else
    cp "$src" "$dst"
  fi
}

# Hook scripts
HOOKS=(
  c-thru-session-start.sh
  c-thru-proxy-health.sh
  c-thru-classify.sh
  c-thru-map-changed.sh
  c-thru-postcompact-context.sh
)
for h in "${HOOKS[@]}"; do
  check_or_copy "$ROOT/tools/$h" "$BUNDLE/hooks/$h"
done

# Skill SKILL.md files
SKILLS=(c-thru-plan c-thru-config c-thru-control)
for s in "${SKILLS[@]}"; do
  check_or_copy "$ROOT/skills/$s/SKILL.md" "$BUNDLE/skills/$s/SKILL.md"
done

[ "$drift" -eq 0 ] || { echo "Run tools/sync-plugin-bundle.sh to fix drift."; exit 1; }
