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

# Portable mode octal (macOS stat -f %Lp; GNU stat -c %a).
file_mode() {
  local p="$1"
  if stat -f '%Lp' "$p" >/dev/null 2>&1; then
    stat -f '%Lp' "$p"
  else
    stat -c '%a' "$p"
  fi
}

check_or_copy() {
  local src="$1" dst="$2"
  EXPECTED_DESTS+=("$dst")
  if [ "$mode" = "--check" ]; then
    if ! cmp -s "$src" "$dst" 2>/dev/null; then
      echo "DRIFT: $dst differs from $src"
      drift=1
    fi
    # Content-only cmp is mode-blind — marketplace hooks.json direct-execs
    # copied shell hooks, so a 0644 mirror of a 0755 source is shipped-broken
    # while --check stays green (advisors cycle-2 M1).
    if [ -e "$src" ] && [ -e "$dst" ]; then
      local sm dm
      sm=$(file_mode "$src")
      dm=$(file_mode "$dst")
      if [ "$sm" != "$dm" ]; then
        echo "DRIFT: $dst mode $dm != source mode $sm ($src)"
        drift=1
      fi
    fi
  else
    mkdir -p "$(dirname "$dst")"
    # -p preserves mode (and times) so hook +x survives the mirror.
    cp -p "$src" "$dst" || { echo "FAIL: could not copy $src → $dst"; drift=1; }
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
  c-thru-stop-failure-hook.sh
  c-thru-postcompact-context.sh
)
for h in "${HOOKS[@]}"; do
  check_or_copy "$ROOT/tools/$h" "$BUNDLE/hooks/$h"
done

# Skill SKILL.md files — Shape C lean marketplace: none.
# Fleet skills (c-thru-plan, config, control, …) arrive via `cthru` launch inject,
# not the plugin package. Repo skills/ still holds sources for CLI inject.
SKILLS=()
for s in "${SKILLS[@]}"; do
  check_or_copy "$ROOT/skills/$s/SKILL.md" "$BUNDLE/skills/$s/SKILL.md"
done

# Proxy binary + JS runtime deps (needed for plugin-only installs without install.sh).
# c-thru-lib.sh: the bundled hooks source it from $ROUTER_REPO_ROOT/tools/ (which
# resolves to $BUNDLE/tools/ in plugin mode), so it must ship here too.
# c-thru-plugin-hook-gate.sh: sourced by every hook when C_THRU_PLUGIN_HOOK=1.
for f in c-thru-lib.sh c-thru-ensure-proxy-on-port.sh c-thru-revive-agent-sessions.sh c-thru-gateway-auth-helper.sh claude-proxy proxy-dashboard.html plan-dashboard.html plan-state-lib.js c-thru-plan-harness.js model-map-config.js model-map-resolve.js model-map-layered.js \
          model-map-validate.js hw-profile.js agent-sentinel.js upstream-error-body.js proxy-log-maintain.js \
          c-thru-install-core.sh c-thru-plugin-bootstrap.sh c-thru-setup-messages.sh c-thru-plugin-hook-gate.sh \
          c-thru-statusline.sh c-thru-statusline-overlay.sh c-thru-config-helpers.js c-thru-control.js; do
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

# Slash commands — Shape C lean: status + install-cli only.
# Full /cplan and advisors ship via CLI inject / other plugins, not marketplace fat.
COMMANDS=(c-thru-status.md c-thru-install-cli.md)
for c in "${COMMANDS[@]}"; do
  if [ -f "$ROOT/commands/$c" ]; then
    check_or_copy "$ROOT/commands/$c" "$BUNDLE/commands/$c"
  fi
done

# hooks.json is hand-maintained in the bundle (not copied from a source list).
BUNDLE_ALLOWLIST=("$BUNDLE/hooks/hooks.json")

is_expected() {
  local f="$1" e
  for e in "${EXPECTED_DESTS[@]}" "${BUNDLE_ALLOWLIST[@]}"; do
    [ "$f" = "$e" ] && return 0
  done
  return 1
}

# Reverse-drift: --check flags STALE; sync mode prunes orphaned lean leftovers.
while IFS= read -r -d '' f; do
  if ! is_expected "$f"; then
    if [ "$mode" = "--check" ]; then
      echo "STALE: $f (no corresponding source entry in sync lists)"
      drift=1
    else
      echo "PRUNE: $f"
      rm -f "$f" || { echo "FAIL: could not prune $f"; drift=1; }
    fi
  fi
done < <(find "$BUNDLE"/tools "$BUNDLE"/hooks "$BUNDLE"/skills "$BUNDLE"/config "$BUNDLE"/commands -type f -print0 2>/dev/null)

# Drop empty skill dirs left after lean prune
if [ "$mode" != "--check" ]; then
  find "$BUNDLE/skills" -mindepth 1 -type d -empty -delete 2>/dev/null || true
fi

[ "$drift" -eq 0 ] || { echo "Run tools/sync-plugin-bundle.sh to fix drift."; exit 1; }
