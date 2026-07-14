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

# Every destination we sync is recorded here so the reverse-drift pass (--check)
# can flag bundle files that no longer correspond to any source list entry.
EXPECTED_DESTS=()

check_or_copy() {
  local src="$1" dst="$2"
  EXPECTED_DESTS+=("$dst")
  if [ "$mode" = "--check" ]; then
    if ! cmp -s "$src" "$dst" 2>/dev/null; then
      echo "DRIFT: $dst differs from $src"
      drift=1
    fi
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst" || { echo "FAIL: could not copy $src → $dst"; drift=1; }
  fi
}

# Hook scripts
HOOKS=(
  c-thru-session-start.sh
  c-thru-proxy-health.sh
  c-thru-classify.sh
  c-thru-map-changed.sh
  c-thru-plan-visibility-hook.sh
  c-thru-stop-hook.sh
  c-thru-postcompact-context.sh
)
for h in "${HOOKS[@]}"; do
  check_or_copy "$ROOT/tools/$h" "$BUNDLE/hooks/$h"
done

# Skill SKILL.md files — only public-facing skills synced to the marketplace bundle.
# The following skills are intentionally excluded:
#   logical-gearbox                             — internal routing research
#   review-fix, review-plan                     — review-suite; shipped via separate plugin
#   update-model-research                       — internal capability research tool
SKILLS=(c-thru-plan c-thru-config c-thru-control plan-page)
for s in "${SKILLS[@]}"; do
  check_or_copy "$ROOT/skills/$s/SKILL.md" "$BUNDLE/skills/$s/SKILL.md"
done

# Proxy binary + JS runtime deps (needed for plugin-only installs without install.sh).
# c-thru-lib.sh: the bundled hooks source it from $ROUTER_REPO_ROOT/tools/ (which
# resolves to $BUNDLE/tools/ in plugin mode), so it must ship here too.
for f in c-thru-lib.sh claude-proxy proxy-dashboard.html plan-dashboard.html plan-state-lib.js c-thru-plan-harness.js model-map-config.js model-map-resolve.js model-map-layered.js \
          model-map-validate.js hw-profile.js agent-sentinel.js upstream-error-body.js proxy-log-maintain.js; do
  check_or_copy "$ROOT/tools/$f" "$BUNDLE/tools/$f"
done

# Analysis tools (user-facing, not proxy runtime deps): per-agent offload telemetry
# read from Claude Code transcripts. c-thru-agent-usage.js requires ./agent-offload-lib.js,
# so both must ship together. Surfaced by the c-thru-status command.
for f in agent-offload-lib.js c-thru-agent-usage.js; do
  check_or_copy "$ROOT/tools/$f" "$BUNDLE/tools/$f"
done

# Shipped config (model routing defaults)
check_or_copy "$ROOT/config/model-map.json"            "$BUNDLE/config/model-map.json"

# Reverse-drift pass (--check only): a forward sync proves every source has a
# matching destination, but never catches a STALE bundle file that lingers after
# its source was dropped from a list. Walk the bundle's synced subtrees and flag
# any file that isn't an expected destination.
#   hooks.json is hand-maintained in the bundle (not copied from a source list),
#   so it is allowlisted rather than flagged.
if [ "$mode" = "--check" ]; then
  BUNDLE_ALLOWLIST=("$BUNDLE/hooks/hooks.json")
  is_expected() {
    local f="$1" e
    for e in "${EXPECTED_DESTS[@]}" "${BUNDLE_ALLOWLIST[@]}"; do
      [ "$f" = "$e" ] && return 0
    done
    return 1
  }
  while IFS= read -r -d '' f; do
    if ! is_expected "$f"; then
      echo "STALE: $f (no corresponding source entry in sync lists)"
      drift=1
    fi
  done < <(find "$BUNDLE"/tools "$BUNDLE"/hooks "$BUNDLE"/skills "$BUNDLE"/config -type f -print0 2>/dev/null)
fi

[ "$drift" -eq 0 ] || { echo "Run tools/sync-plugin-bundle.sh to fix drift."; exit 1; }
