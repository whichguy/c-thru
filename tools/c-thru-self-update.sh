#!/usr/bin/env bash
# Best-effort git self-update for c-thru. Called from claude-router at startup.
# Never blocks launch. Always exits 0. Protects against all offline/dirty/detached states.
set -euo pipefail

REPO_ROOT="${ROUTER_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
UPDATE_LOG="$REPO_ROOT/.c-thru-update.log"
UPDATE_INTERVAL="${CLAUDE_ROUTER_UPDATE_INTERVAL:-3600}"

# Opt-out checks (fast path — checked before entering any subshell)
[[ "${CLAUDE_ROUTER_NO_UPDATE:-}" == "1" ]] && exit 0
[[ -f "$REPO_ROOT/config/.no-self-update" ]] && exit 0

# Read self_update field from merged overrides (written by /map-model update off)
_PROFILE_DIR="${CLAUDE_PROFILE_DIR:-${CLAUDE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}}"
_OVERRIDES="$_PROFILE_DIR/model-map.overrides.json"
if [[ -f "$_OVERRIDES" ]]; then
  _self_update="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('self_update',''))" "$_OVERRIDES" 2>/dev/null || true)"
  [[ "$_self_update" == "False" || "$_self_update" == "false" ]] && exit 0
fi

cd "$REPO_ROOT" || exit 0

# Must be inside a git repo
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Skip on detached HEAD
git symbolic-ref --quiet HEAD >/dev/null 2>&1 || exit 0

# Skip on dirty working tree (uncommitted changes)
[[ -z "$(git status --porcelain 2>/dev/null)" ]] || exit 0

# Debounce: skip if FETCH_HEAD is fresh (within UPDATE_INTERVAL seconds)
if [[ -f "$REPO_ROOT/.git/FETCH_HEAD" ]]; then
  _mtime="$(python3 -c "import os,time; print(int(time.time()-os.path.getmtime('$REPO_ROOT/.git/FETCH_HEAD')))" 2>/dev/null || echo 99999)"
  [[ "$_mtime" -lt "$UPDATE_INTERVAL" ]] && exit 0
fi

_old_sha="$(git rev-parse HEAD 2>/dev/null || true)"

# Background fetch + fast-forward with 5s hard kill (no `timeout` on macOS)
(
  git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=3 \
    fetch --quiet --no-tags origin 2>/dev/null || exit 0
  git merge-base --is-ancestor HEAD @{u} 2>/dev/null || exit 0
  git merge --ff-only --quiet @{u} 2>/dev/null || true
) &
_pull_pid=$!

# 1s foreground grace — kill if still running after 1s
( sleep 1; kill -0 "$_pull_pid" 2>/dev/null && kill -TERM "$_pull_pid" 2>/dev/null ) 2>/dev/null &
_grace_pid=$!

wait "$_pull_pid" 2>/dev/null || true
kill "$_grace_pid" 2>/dev/null; wait "$_grace_pid" 2>/dev/null || true

# Belt-and-suspenders: cancel the sleep subshell. _pull_pid is already reaped
# by wait above so kill -KILL on it is a no-op; this just harvests the subshell.
( sleep 4; true ) 2>/dev/null &
_hard_pid=$!
kill "$_hard_pid" 2>/dev/null; wait "$_hard_pid" 2>/dev/null || true

_new_sha="$(git rev-parse HEAD 2>/dev/null || true)"

# Append bounded log entry on fast-forward (max 100 lines)
if [[ -n "$_old_sha" && -n "$_new_sha" && "$_old_sha" != "$_new_sha" ]]; then
  _changed="$(git diff --stat "$_old_sha".."$_new_sha" 2>/dev/null | tail -1 || echo 'unknown')"
  _entry="$(date -u +%Y-%m-%dT%H:%M:%SZ) fetched ${_old_sha:0:8}..${_new_sha:0:8} (${_changed})"
  echo "$_entry" >> "$UPDATE_LOG" 2>/dev/null || true
  # Rotate to max 100 lines
  if [[ -f "$UPDATE_LOG" ]]; then
    _lines="$(wc -l < "$UPDATE_LOG" 2>/dev/null || echo 0)"
    if [[ "$_lines" -gt 100 ]]; then
      tail -100 "$UPDATE_LOG" > "$UPDATE_LOG.tmp" 2>/dev/null && mv "$UPDATE_LOG.tmp" "$UPDATE_LOG" 2>/dev/null || true
    fi
  fi
fi

exit 0
