#!/usr/bin/env bash
# Best-effort background refresh of third-party CLI plugin marketplaces.
# Called by a future launcher integration; intentionally never blocks a CLI.
set -uo pipefail

# Opt out before resolving paths, taking a lock, or doing any other work.
[[ "${C_THRU_NO_MARKETPLACE_UPDATE:-}" == "1" ]] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -r "$SCRIPT_DIR/c-thru-lib.sh" ]]; then
  # shellcheck source=c-thru-lib.sh
  . "$SCRIPT_DIR/c-thru-lib.sh"
fi

if declare -F cthru_original_profile_dir >/dev/null 2>&1; then
  DURABLE_DIR="$(cthru_original_profile_dir)"
else
  DURABLE_DIR="${CLAUDE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
fi

STAMP="$DURABLE_DIR/.c-thru-marketplace-update-stamp"
UPDATE_LOG="$DURABLE_DIR/.c-thru-marketplace-update.log"
LOCK_FILE="$DURABLE_DIR/.c-thru-marketplace-update.lock"
UPDATE_INTERVAL="${C_THRU_MARKETPLACE_UPDATE_INTERVAL:-21600}"
WARN_AFTER="${C_THRU_MARKETPLACE_UPDATE_WARN_AFTER:-300}"

_stamp_is_fresh() {
  [[ -f "$STAMP" ]] || return 1
  local _age
  _age=$(( $(date +%s) - $(stat -f %m "$STAMP" 2>/dev/null || stat -c %Y "$STAMP" 2>/dev/null || echo 0) ))
  [[ "$_age" -lt "$UPDATE_INTERVAL" ]]
}

# --- _with_lock: run a function under an exclusive advisory lock ---
# The flock branch deliberately mirrors c-thru-ollama-gc.sh. The mkdir fallback
# is PID-aware rather than age-based: plugin refreshes can legitimately exceed
# thirty seconds, so an age cutoff could steal a live updater's lock.
# `flock -x` (no `-n`) blocks until acquired rather than failing fast -- this is
# intentional, not a missed non-blocking flag: every caller already backgrounds
# this whole script and disowns it, so a second trigger blocking here just
# waits quietly in its own subshell. _critical_section re-checks the debounce
# stamp immediately after acquiring the lock, so the waiter finds the stamp
# already fresh and returns without duplicating the first runner's work.
_with_lock() {
  if [[ "${C_THRU_MARKETPLACE_UPDATE_FORCE_MKDIR_LOCK:-}" != "1" ]] && command -v flock >/dev/null 2>&1; then
    (flock -x 9; "$@") 9>"$LOCK_FILE"
  else
    local _ldir="$LOCK_FILE.d" _pid _rc=0
    while ! mkdir "$_ldir" 2>/dev/null; do
      _pid="$(cat "$_ldir/pid" 2>/dev/null || true)"
      if [[ "$_pid" =~ ^[0-9]+$ ]] && kill -0 "$_pid" 2>/dev/null; then
        return 0
      fi
      # A missing, malformed, or dead pid cannot own this advisory lock.
      rm -f "$_ldir/pid" 2>/dev/null || true
      rmdir "$_ldir" 2>/dev/null || true
    done
    printf '%s\n' "$$" > "$_ldir/pid" 2>/dev/null || true
    "$@" || _rc=$?
    rm -f "$_ldir/pid" 2>/dev/null || true
    rmdir "$_ldir" 2>/dev/null || true
    return "$_rc"
  fi
}

# Single source of truth for "which Claude profile root are we operating
# against" — both the preflight safety scan and the installed-plugin
# enumeration must resolve the SAME directory, or a non-default profile
# (CLAUDE_DIR/CLAUDE_CONFIG_DIR/C_THRU_MARKETPLACE_CLAUDE_DIR override) would
# silently scan one location for safety while updating plugins in another.
_claude_root() {
  printf '%s' "${C_THRU_MARKETPLACE_CLAUDE_DIR:-${CLAUDE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}}"
}

_scan_marketplaces() {
  local _root _entry _dirty _counts _behind _ahead
  local -a _unsafe=()
  local _claude_root; _claude_root="$(_claude_root)"
  local _grok_root="${C_THRU_MARKETPLACE_GROK_DIR:-$HOME/.grok}"

  for _root in "$_claude_root/plugins/marketplaces" "$_grok_root/marketplace-cache"; do
    for _entry in "$_root"/*/; do
      [[ -d "$_entry" && -e "$_entry/.git" ]] || continue
      git -C "$_entry" rev-parse --is-inside-work-tree >/dev/null 2>&1 || continue

      _dirty="$(git -C "$_entry" status --porcelain 2>/dev/null || true)"
      if [[ -n "$_dirty" ]]; then
        _unsafe+=("$_entry: dirty working tree")
      fi

      if git -C "$_entry" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
        _counts="$(git -C "$_entry" rev-list --left-right --count '@{u}...HEAD' 2>/dev/null || true)"
        _behind=""; _ahead=""
        read -r _behind _ahead <<<"$_counts" || true
        if [[ "$_behind" =~ ^[0-9]+$ && "$_ahead" =~ ^[0-9]+$ && "$_ahead" -gt 0 ]]; then
          if [[ "$_behind" -gt 0 ]]; then
            _unsafe+=("$_entry: diverged from upstream (ahead $_ahead, behind $_behind)")
          else
            _unsafe+=("$_entry: ahead of upstream (ahead $_ahead)")
          fi
        fi
      else
        # No branch/upstream to compare against — this is the normal shape for
        # Grok's own marketplace-cache clones (confirmed: all 5 real ones are
        # detached HEAD). Fall back to reachability: if HEAD isn't contained in
        # any remote-tracking branch, treat it as a possible local-only commit.
        if [[ -z "$(git -C "$_entry" branch -r --contains HEAD 2>/dev/null)" ]]; then
          _unsafe+=("$_entry: detached HEAD not reachable from any remote branch")
        fi
      fi
    done
  done

  if [[ "${#_unsafe[@]}" -gt 0 ]]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) marketplace update skipped: unsafe marketplace clone state; merge/clean manually"
    local _reason
    for _reason in "${_unsafe[@]}"; do
      echo "  $_reason"
    done
    return 1
  fi
  return 0
}

# Accepted residual risk: a plugin update landing here can race a concurrently
# starting Claude Code session's own plugin discovery/load. This isn't a new
# hazard this script introduces -- it's the same race that already exists
# between a manual `claude plugin update` and a session start in another
# terminal -- only marginally more likely now that updates fire automatically.
# An already-running session is unaffected (its plugin code is already loaded;
# see the module header for why that's the real "restart boundary"). Not
# fixable from this script: plugin-write atomicity is the native CLI's
# responsibility, not something a caller can coordinate around.
_run_updates() {
  command -v claude >/dev/null 2>&1 && claude plugin marketplace update </dev/null 2>&1 || true
  command -v grok >/dev/null 2>&1 && grok plugin marketplace update </dev/null 2>&1 || true
  command -v codex >/dev/null 2>&1 && codex plugin marketplace upgrade </dev/null 2>&1 || true

  if command -v claude >/dev/null 2>&1; then
    local _plugin_id _installed_json
    _installed_json="$(_claude_root)/plugins/installed_plugins.json"
    # while/read (not a word-splitting `for $(...)`) so a plugin id containing
    # whitespace or shell-glob characters can't corrupt iteration or cross the
    # `claude plugin update` argument boundary.
    while IFS= read -r _plugin_id; do
      [[ -n "$_plugin_id" ]] || continue
      claude plugin update -- "$_plugin_id" </dev/null 2>&1 || true
    done < <(CTHRU_INSTALLED_PLUGINS_JSON="$_installed_json" node -e '
      const p = require(process.env.CTHRU_INSTALLED_PLUGINS_JSON);
      console.log(Object.keys(p.plugins || {}).join("\n"));
    ' 2>/dev/null)
  fi
  command -v grok >/dev/null 2>&1 && grok plugin update </dev/null 2>&1 || true
}

_rotate_log() {
  local _lines
  if [[ -f "$UPDATE_LOG" ]]; then
    _lines="$(wc -l < "$UPDATE_LOG" 2>/dev/null || echo 0)"
    if [[ "$_lines" -gt 100 ]]; then
      tail -100 "$UPDATE_LOG" > "$UPDATE_LOG.tmp" 2>/dev/null && mv "$UPDATE_LOG.tmp" "$UPDATE_LOG" 2>/dev/null || true
    fi
  fi
}

_critical_section() {
  # A second flock waiter may enter after a completed runner, so re-check the
  # stamp inside the lock as a race guard. The first check remains lock-free.
  _stamp_is_fresh && return 0

  # $$ is available in the macOS Bash 3.x shipped with older Claude installs.
  # (BASHPID is not.) The watcher is cancelled before this function returns.
  local _owner_pid="$$" _watcher_pid
  (
    sleep "$WARN_AFTER" 2>/dev/null || true
    if kill -0 "$_owner_pid" 2>/dev/null; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) marketplace update still running after ${WARN_AFTER}s (diagnostic only; not terminating)"
    fi
  ) &
  _watcher_pid=$!

  if ! _scan_marketplaces; then
    : # Unsafe is a completed, deliberately skipped run; still refresh stamp.
  else
    _run_updates
  fi

  kill "$_watcher_pid" 2>/dev/null || true
  wait "$_watcher_pid" 2>/dev/null || true
  touch "$STAMP" 2>/dev/null || true
  _rotate_log
}

# Debounce before lock acquisition. A missing/unwritable profile directory is
# fail-open: mkdir/redirection failures simply leave nothing persistent behind.
_stamp_is_fresh && exit 0
mkdir -p "$DURABLE_DIR" 2>/dev/null || true
_with_lock _critical_section >> "$UPDATE_LOG" 2>&1 || true

exit 0
