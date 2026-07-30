#!/usr/bin/env bash
# Shape C: one-shot bootstrap for marketplace plugin installs.
# Ensures durable CLI tools (symlinks) + stamp so users run `cthru`.
#
# Idempotent. Safe to call from SessionStart (fail-open: never abort the host).
# Env:
#   C_THRU_FORCE_BOOTSTRAP=1  — re-run even if stamp healthy
#   C_THRU_GIT_REMOTE         — override clone URL
#   C_THRU_BOOTSTRAP_PULL=0   — skip git pull on existing c-thru-src
#   C_THRU_BOOTSTRAP_LOG      — log file (default: $CLAUDE_DIR/c-thru-bootstrap.log)
#   CLAUDE_PROFILE_DIR / CLAUDE_CONFIG_DIR / CLAUDE_DIR

set -uo pipefail

_bs_src="${BASH_SOURCE[0]:-$0}"
while [ -L "$_bs_src" ]; do
  _bs_dir=$(cd -P "$(dirname "$_bs_src")" && pwd)
  _bs_src=$(readlink "$_bs_src")
  case "$_bs_src" in /*) ;; *) _bs_src="$_bs_dir/$_bs_src" ;; esac
done
_BS_DIR=$(cd -P "$(dirname "$_bs_src")" && pwd)

# shellcheck source=c-thru-install-core.sh
. "$_BS_DIR/c-thru-install-core.sh"
# shellcheck source=c-thru-setup-messages.sh
. "$_BS_DIR/c-thru-setup-messages.sh" 2>/dev/null || true

CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-${CLAUDE_CONFIG_DIR:-${CLAUDE_DIR:-$HOME/.claude}}}"
export CLAUDE_DIR
mkdir -p "$CLAUDE_DIR" 2>/dev/null || true
_log="${C_THRU_BOOTSTRAP_LOG:-$CLAUDE_DIR/c-thru-bootstrap.log}"

_bs_log() {
  # Always append to log; mirror important lines to stderr unless quiet.
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  printf '%s\n' "$line" >>"$_log" 2>/dev/null || true
}

# Package root for version drift: plugin root when running from plugins/c-thru/tools
_package_root="$(cd "$_BS_DIR/.." 2>/dev/null && pwd -P || true)"

if [[ "${C_THRU_FORCE_BOOTSTRAP:-0}" != "1" ]] && cthru_stamp_is_healthy; then
  if ! cthru_stamp_version_stale_vs "$_package_root"; then
    exit 0
  fi
  _bs_log "stamp version stale vs package; re-linking"
fi

# Resolve full monorepo REPO_DIR
if [[ -n "${REPO_DIR:-}" ]] && cthru_repo_is_complete "$REPO_DIR"; then
  _bs_log "using pre-set REPO_DIR=$REPO_DIR"
elif cthru_ensure_source_root_s1; then
  _bs_log "using S1 source REPO_DIR=$REPO_DIR"
else
  # Developer layout: script lives at <monorepo>/tools/ → parent is repo root
  _maybe="$(cd "$_BS_DIR/.." 2>/dev/null && pwd -P || true)"
  if cthru_repo_is_complete "$_maybe"; then
    REPO_DIR="$_maybe"
    export REPO_DIR
    _bs_log "using monorepo tools/ parent REPO_DIR=$REPO_DIR"
  else
    _bs_log "ERROR: could not obtain full source tree"
    echo "c-thru bootstrap: could not obtain full source tree (need git + ${C_THRU_GIT_REMOTE:-https://github.com/whichguy/c-thru.git})" >&2
    exit 0
  fi
fi

if cthru_install_from_repo; then
  _bs_log "install ok source_root=$REPO_DIR"
  if declare -F cthru_msg_after_bootstrap >/dev/null 2>&1; then
    cthru_msg_after_bootstrap >&2
  else
    echo "c-thru CLI tools installed. Launch with: cthru" >&2
  fi
else
  _bs_log "ERROR: cthru_install_from_repo failed"
fi
exit 0
